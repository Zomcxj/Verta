//! "Does the shell have child processes?" without forking `pgrep`.
//!
//! The close-tab guard asks this on the main thread, so it must be a cheap
//! kernel query: `proc_listchildpids` on macOS, `/proc/<pid>/task/*/children`
//! on Linux (with a `/proc/*/stat` parent scan for kernels built without
//! `CONFIG_PROC_CHILDREN`), and a ToolHelp snapshot on Windows.
//!
//! Windows needs one extra step that the other systems do not (`descend_to_shell`):
//! the process a pty is spawned under is not always the shell the user types into.
//! Git's `bin\bash.exe` is a stub that runs `usr\bin\bash.exe` as its child, so
//! asking the stub whether it has children answers yes for as long as the tab
//! lives, and an idle terminal reads as busy.

#[cfg(target_os = "macos")]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    // One slot is enough: only existence matters, and the kernel fills what
    // fits and reports the count it wrote.
    let mut child: libc::pid_t = 0;
    let listed = unsafe {
        libc::proc_listchildpids(
            shell_pid as libc::pid_t,
            (&mut child as *mut libc::pid_t).cast(),
            std::mem::size_of::<libc::pid_t>() as libc::c_int,
        )
    };
    listed > 0
}

#[cfg(target_os = "linux")]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    use std::fs;
    let tasks = format!("/proc/{shell_pid}/task");
    let mut readable = false;
    if let Ok(entries) = fs::read_dir(&tasks) {
        for task in entries.flatten() {
            match fs::read_to_string(task.path().join("children")) {
                Ok(children) => {
                    readable = true;
                    if children_listed(&children) {
                        return true;
                    }
                }
                Err(_) => continue,
            }
        }
    }
    if readable {
        return false;
    }
    // No `children` files (CONFIG_PROC_CHILDREN is off): scan parents.
    fs::read_dir("/proc").is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry.file_name().to_str().is_some_and(|name| {
                name.bytes().all(|b| b.is_ascii_digit())
                    && fs::read_to_string(entry.path().join("stat"))
                        .ok()
                        .and_then(|stat| stat_parent(&stat))
                        == Some(shell_pid)
            })
        })
    })
}

/// A `children` file lists space-separated pids; empty means none.
#[cfg(any(target_os = "linux", test))]
fn children_listed(contents: &str) -> bool {
    contents.split_whitespace().next().is_some()
}

/// Parent pid from `/proc/<pid>/stat`: `pid (comm) state ppid ...` where
/// `comm` may itself contain spaces and parentheses, so anchor on the last `)`.
#[cfg(any(target_os = "linux", test))]
fn stat_parent(stat: &str) -> Option<u32> {
    let after = &stat[stat.rfind(')')? + 1..];
    after.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    // pgrep -P exits 0 when shell_pid has at least one child, 1 when none.
    std::process::Command::new("pgrep")
        .args(["-P", &shell_pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProcEntry {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

/// A process that is a shell, or the stub one is started through.
///
/// Windows does not always start the user's shell directly: Git's
/// `bin\bash.exe` is a stub whose only child is the real `usr\bin\bash.exe`, and
/// that is the pid the pty hands back. Both names have to count as "still the same
/// terminal" so the walk below can step past the stub.
#[cfg(any(target_os = "windows", test))]
fn is_shell_process(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "bash.exe"
            | "sh.exe"
            | "zsh.exe"
            | "fish.exe"
            | "pwsh.exe"
            | "powershell.exe"
            | "cmd.exe"
            | "wsl.exe"
            | "nu.exe"
            | "nushell.exe"
    )
}

/// The process the user is actually typing into, given the process list.
///
/// Stepping past a launcher is what makes "does this terminal have a command
/// running" answerable: ask the stub and the answer is yes forever, because the
/// shell it started is its child. So while the process has **exactly one** child and
/// that child is a shell, step into it. What is left is the shell itself, and its
/// children are the commands the user started.
///
/// The "exactly one" part is what keeps a command from being mistaken for a
/// launcher: a shell running anything has a child that is not a shell (a command), or
/// several children, and the walk stops. Something that spawns one shell at startup
/// (a distro's `wsl.exe` on the way to its login shell) is still followed.
///
/// A user sitting at the prompt of a shell they started by hand reads as "nothing
/// running", which is the honest answer: nothing is executing. A chain of launchers
/// is a handful of processes, and the loop is capped so a pathological tree cannot
/// spin the main thread.
#[cfg(any(target_os = "windows", test))]
pub(super) fn descend_to_shell(entries: &[ProcEntry], pid: u32) -> u32 {
    let mut current = pid;
    for _ in 0..8 {
        let mut children = entries.iter().filter(|entry| entry.parent == current);
        let Some(only) = children.next() else { break };
        if children.next().is_some() || !is_shell_process(&only.name) {
            break;
        }
        current = only.pid;
    }
    current
}

#[cfg(target_os = "windows")]
pub(super) fn shell_has_children(shell_pid: u32) -> bool {
    let entries = process_list();
    let shell = descend_to_shell(&entries, shell_pid);
    entries.iter().any(|entry| entry.parent == shell)
}

/// One ToolHelp snapshot as a process list.
#[cfg(target_os = "windows")]
pub(super) fn process_list() -> Vec<ProcEntry> {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };
    let mut entries = Vec::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return entries;
        }
        let mut entry: PROCESSENTRY32 = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32>() as u32;
        if Process32First(snapshot, &mut entry) != 0 {
            loop {
                // `szExeFile` is an ANSI image name, not a path, and carries the
                // NUL inside the fixed array.
                let name: Vec<u8> = entry
                    .szExeFile
                    .iter()
                    .take_while(|byte| **byte != 0)
                    .map(|byte| *byte as u8)
                    .collect();
                entries.push(ProcEntry {
                    pid: entry.th32ProcessID,
                    parent: entry.th32ParentProcessID,
                    name: String::from_utf8_lossy(&name).into_owned(),
                });
                if Process32Next(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_files_list_pids_or_nothing() {
        assert!(!children_listed(""));
        assert!(!children_listed("  \n"));
        assert!(children_listed("1234 "));
        assert!(children_listed("1 2 3\n"));
    }

    #[test]
    fn stat_parent_survives_awkward_command_names() {
        assert_eq!(stat_parent("42 (zsh) S 7 42 42 0 -1"), Some(7));
        assert_eq!(stat_parent("42 (a b) c) S 9 42"), Some(9));
        assert_eq!(stat_parent("42 (x) S"), None);
        assert_eq!(stat_parent("garbage"), None);
    }

    #[cfg(unix)]
    #[test]
    fn detects_real_children_without_forking_a_helper() {
        let me = std::process::id();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        assert!(shell_has_children(me), "the sleeping child is visible");
        let _ = child.kill();
        let _ = child.wait();
        // A leaf process (the child itself) has none.
        let mut leaf = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn leaf");
        assert!(!shell_has_children(leaf.id()));
        let _ = leaf.kill();
        let _ = leaf.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_process_has_no_children() {
        assert!(!shell_has_children(0x7fff_fff0));
    }

    /// A process as one snapshot line: pid, parent, image name.
    fn proc(pid: u32, parent: u32, name: &str) -> ProcEntry {
        ProcEntry {
            pid,
            parent,
            name: name.to_string(),
        }
    }

    #[test]
    fn the_shell_a_windows_stub_started_is_the_terminal() {
        // What this machine looks like: the host spawned Git's stub, the stub started
        // the real bash, and the real bash is where the user types.
        let list = [
            proc(10, 1, "verta.exe"),
            proc(11, 10, "bash.exe"),
            proc(12, 11, "bash.exe"),
        ];
        assert_eq!(descend_to_shell(&list, 11), 12);
        assert!(!list.iter().any(|entry| entry.parent == 12), "idle prompt");
    }

    #[test]
    fn a_command_under_the_shell_is_not_mistaken_for_a_launcher() {
        let list = [
            proc(11, 10, "bash.exe"),
            proc(12, 11, "bash.exe"),
            proc(13, 12, "node.exe"),
        ];
        // The walk stops at the shell: node is not a shell, so it is a command.
        assert_eq!(descend_to_shell(&list, 11), 12);
        assert!(list.iter().any(|entry| entry.parent == 12));
    }

    #[test]
    fn a_shell_started_by_hand_is_not_followed_further() {
        // The user ran `bash` as the foreground command and is sitting at its prompt:
        // nothing is executing, which is the honest answer either way.
        let list = [
            proc(11, 10, "bash.exe"),
            proc(12, 11, "bash.exe"),
            proc(13, 12, "bash.exe"),
        ];
        assert_eq!(descend_to_shell(&list, 11), 13, "still a terminal, not a job");
    }

    #[test]
    fn several_children_end_the_walk() {
        // A shell with more than one child is running more than one thing, which is a
        // terminal at work, not a launcher on the way to a shell.
        let list = [
            proc(11, 10, "bash.exe"),
            proc(12, 11, "bash.exe"),
            proc(13, 11, "conhost.exe"),
        ];
        assert_eq!(descend_to_shell(&list, 11), 11);
    }

    #[test]
    fn a_shell_started_directly_stays_where_it_is() {
        // No stub in front of it: the pid the pty handed back is the shell.
        let list = [proc(20, 1, "verta.exe"), proc(21, 20, "pwsh.exe")];
        assert_eq!(descend_to_shell(&list, 21), 21);
    }

    #[test]
    fn a_tree_that_never_ends_stops_at_the_cap() {
        // Nothing in a real terminal looks like this; the loop must not follow it
        // forever on the main thread.
        let mut list = vec![proc(1, 0, "bash.exe")];
        for step in 2..40u32 {
            list.push(proc(step, step - 1, "bash.exe"));
        }
        let settled = descend_to_shell(&list, 1);
        assert!(settled > 1 && settled < 40, "stopped, got {settled}");
    }
}
