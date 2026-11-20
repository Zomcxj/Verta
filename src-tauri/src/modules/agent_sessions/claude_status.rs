//! Claude Code's own runtime registry: which sessions are busy right now.
//!
//! `~/.claude/sessions/<pid>.json` is written by every running Claude Code process, one file per
//! process, and removed when that process exits cleanly. It is the only source that says what a
//! session is *doing*: the transcript only says when it was last written, so a wait of three
//! minutes in the middle of a long tool call was indistinguishable from an idle session, and a
//! status that went back to `idle` kept its row lit until the write window ran out.
//!
//! Measured on this machine (2.1.328, 2026-11-20), one file as written:
//!
//! ```json
//! {"pid":28564,"sessionId":"b282aa01-3997-4af9-96d5-76c8aa9f9ded",
//!  "cwd":"C:\\Users\\cxj\\Desktop\\dsh","startedAt":1795134174227,
//!  "procStart":"134396077735867759","version":"2.1.328","peerProtocol":1,
//!  "peerFeatures":["notify_idle","artifact_yield"],"kind":"interactive","entrypoint":"cli",
//!  "pidDomain":"win32:win-j8j3du0ci9t","messagingSocketPath":"\\\\.\\pipe\\LOCAL\\cc-msg-...",
//!  "name":"daily task","nameSource":"user","nameSince":1795134174485,
//!  "updatedAt":1795134197610,"status":"busy","statusUpdatedAt":1795134197610}
//! ```
//!
//! The `<pid>.<hash>.key` file beside it is that peer's auth secret and is never opened here.
//!
//! Nothing is assumed about the rest of the shape: a field this reader does not use is ignored, a
//! file that does not parse is skipped, and a session that appears in more than one file (two
//! processes on one session) is busy if any of them says busy.
//!
//! **Stale files are the danger.** A Claude Code that crashes leaves its file behind with
//! `status: busy` and no process to clear it, which would pin a session as running forever. So an
//! entry only counts when the process it names is still the one that wrote it - on Windows by
//! comparing the process's own creation time with `procStart` (a recycled pid has a different one),
//! and where the OS cannot be asked, by how recently the file said anything at all.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// How stale a `busy` may be when the platform cannot say whether its process is alive.
///
/// Only reachable where liveness is unknown (a POSIX system without `/proc`, or a process this app
/// is not allowed to open). Ten minutes is well past the gap between two `statusUpdatedAt` writes
/// measured here - the field moved with every status change - and short enough that a crashed
/// session stops counting within one turn of the coffee break.
const UNKNOWN_LIVENESS_MAX_AGE_MS: i64 = 10 * 60 * 1000;

/// What one registry file says. Only the fields this reader uses are named; `serde` ignores the
/// rest, which is what keeps a new Claude Code release from breaking the read.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    pid: u32,
    session_id: String,
    /// `busy` while a turn is running, `idle` at a prompt. Absent in some versions, and then this
    /// entry says nothing rather than guessing.
    status: Option<String>,
    status_updated_at: Option<i64>,
    /// The process's creation time, as a Windows `FILETIME` in decimal. Compared against the live
    /// process so a recycled pid cannot inherit a crashed session's file.
    proc_start: Option<String>,
}

/// Whether the process a registry entry names is still the process that wrote it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Liveness {
    Alive,
    Dead,
    /// The OS would not answer (permissions, or a platform with no process table this reader can
    /// read). The caller falls back to the file's own timestamp.
    Unknown,
}

/// The sessions Claude Code itself says are busy, or `None` when this machine has no such registry.
///
/// `None` is "this version does not have this source" - the caller then keeps judging by the write
/// window, which is what every version before this one offered. An empty list is a real answer:
/// nothing is running, and a row that was lit because of a write must go dark.
pub(crate) fn busy_session_ids(config_dir: &Path) -> Option<Vec<String>> {
    let dir = config_dir.join("sessions");
    if !dir.is_dir() {
        return None;
    }
    let entries = std::fs::read_dir(&dir).ok()?;
    let now = now_ms();
    let mut busy: Vec<String> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        // `<pid>.<hash>.key` holds a peer's auth secret: not a registry file, and not ours to open.
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(entry) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|body| serde_json::from_str::<RegistryEntry>(&body).ok())
        else {
            continue;
        };
        if entry.status.as_deref() != Some("busy") {
            continue;
        }
        let expected = entry
            .proc_start
            .as_deref()
            .and_then(|stamp| stamp.parse::<u64>().ok());
        match liveness(entry.pid, expected) {
            Liveness::Alive => {}
            Liveness::Dead => continue,
            Liveness::Unknown => {
                // Nothing can vouch for the process, so the file's own freshness has to.
                let age = now.saturating_sub(entry.status_updated_at.unwrap_or(0));
                if age > UNKNOWN_LIVENESS_MAX_AGE_MS {
                    continue;
                }
            }
        }
        busy.push(entry.session_id);
    }
    // Two processes on one session (a parent and its child) say the same id twice.
    busy.sort();
    busy.dedup();
    Some(busy)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(windows)]
fn liveness(pid: u32, expected: Option<u64>) -> Liveness {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, FILETIME, GetLastError,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: `OpenProcess` hands back a handle this function closes before returning, and the
    // four `FILETIME` out-parameters are initialized stack values of the type the call expects.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return match GetLastError() {
                // No such process. Anything else (access denied, a protected process) means the
                // process may well be there and we simply cannot look at it.
                ERROR_INVALID_PARAMETER => Liveness::Dead,
                ERROR_ACCESS_DENIED => Liveness::Unknown,
                _ => Liveness::Unknown,
            };
        }
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(handle);
        if ok == 0 {
            return Liveness::Unknown;
        }
        let created = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        match expected {
            // The pid is alive but belongs to a different process than the one that wrote the file.
            Some(expected) if expected != created => Liveness::Dead,
            _ => Liveness::Alive,
        }
    }
}

#[cfg(not(windows))]
fn liveness(pid: u32, _expected: Option<u64>) -> Liveness {
    // One file per process is all a POSIX system needs to answer "is it still there", and this is
    // the one way to ask without a dependency. macOS has no `/proc`, so there the answer is
    // honestly unknown and the timestamp decides - the same rule a Windows process this app may not
    // open falls back to. Not verified on either platform yet (the machine this was written on is
    // Windows), which is why the fallback exists at all.
    if !Path::new("/proc").is_dir() {
        return Liveness::Unknown;
    }
    if Path::new(&format!("/proc/{pid}")).exists() {
        Liveness::Alive
    } else {
        Liveness::Dead
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(config: &Path, name: &str, body: &str) {
        let dir = config.join("sessions");
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join(name), body).expect("write");
    }

    fn entry(pid: u32, session: &str, status: &str, stamp: Option<&str>) -> String {
        let proc_start = stamp.map_or("null".to_string(), |s| format!("\"{s}\""));
        format!(
            r#"{{"pid":{pid},"sessionId":"{session}","status":"{status}","statusUpdatedAt":{now},"procStart":{proc_start}}}"#,
            now = now_ms()
        )
    }

    #[test]
    fn no_registry_is_not_an_empty_answer() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A version that does not keep this registry must leave the caller judging by writes, which
        // is a different answer from "nothing is running".
        assert_eq!(busy_session_ids(dir.path()), None);
        std::fs::create_dir_all(dir.path().join("sessions")).expect("dir");
        assert_eq!(busy_session_ids(dir.path()), Some(Vec::new()));
    }

    #[test]
    fn a_live_process_says_which_session_is_busy() {
        let dir = tempfile::tempdir().expect("temp dir");
        let me = std::process::id();
        write(
            dir.path(),
            &format!("{me}.json"),
            &entry(me, "session-a", "busy", None),
        );
        assert_eq!(
            busy_session_ids(dir.path()),
            Some(vec!["session-a".to_string()])
        );
    }

    #[test]
    fn an_idle_session_is_not_running() {
        let dir = tempfile::tempdir().expect("temp dir");
        let me = std::process::id();
        write(
            dir.path(),
            &format!("{me}.json"),
            &entry(me, "session-a", "idle", None),
        );
        assert_eq!(busy_session_ids(dir.path()), Some(Vec::new()));
    }

    #[test]
    fn a_file_left_by_a_dead_process_is_ignored() {
        let dir = tempfile::tempdir().expect("temp dir");
        // A pid no process can have: a crash leaves exactly this behind, and believing it would pin
        // a session as running forever.
        let dead = u32::MAX - 7;
        write(
            dir.path(),
            &format!("{dead}.json"),
            &entry(dead, "session-gone", "busy", None),
        );
        assert_eq!(busy_session_ids(dir.path()), Some(Vec::new()));
    }

    #[test]
    fn the_peer_keyfiles_are_not_registry_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let me = std::process::id();
        write(dir.path(), &format!("{me}.json"), &entry(me, "s1", "busy", None));
        // The real directory holds one of these beside each registry file; it is a secret, and it is
        // not JSON either, so a reader that parsed every file would report a session called nothing.
        write(dir.path(), &format!("{me}.deadbeef.key"), "not json at all");
        assert_eq!(busy_session_ids(dir.path()), Some(vec!["s1".to_string()]));
    }

    #[test]
    fn two_processes_on_one_session_say_it_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let me = std::process::id();
        write(dir.path(), &format!("{me}.json"), &entry(me, "s1", "busy", None));
        write(
            dir.path(),
            &format!("{me}-b.json"),
            &entry(me, "s1", "busy", None),
        );
        assert_eq!(busy_session_ids(dir.path()), Some(vec!["s1".to_string()]));
    }

    #[test]
    fn a_file_that_does_not_parse_is_skipped_not_fatal() {
        let dir = tempfile::tempdir().expect("temp dir");
        let me = std::process::id();
        write(dir.path(), "broken.json", "{ this is not json");
        write(dir.path(), &format!("{me}.json"), &entry(me, "s1", "busy", None));
        assert_eq!(busy_session_ids(dir.path()), Some(vec!["s1".to_string()]));
    }

    #[cfg(windows)]
    #[test]
    fn a_recycled_pid_does_not_inherit_a_crashed_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let me = std::process::id();
        // Alive pid, but the file names a creation time no process has: the pid was reused.
        write(
            dir.path(),
            &format!("{me}.json"),
            &entry(me, "s1", "busy", Some("123456789")),
        );
        assert_eq!(busy_session_ids(dir.path()), Some(Vec::new()));
    }
}
