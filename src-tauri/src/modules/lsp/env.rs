//! GUI-launched apps get a bare PATH on macOS, and servers like
//! typescript-language-server need the user's PATH themselves to find
//! `node`. Capture the login shell env once, reuse for detect and spawn.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

#[cfg(unix)]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Empty on Windows (full user env is inherited there) or if capture failed.
pub fn server_env_overlay() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        #[cfg(unix)]
        {
            match capture_login_env() {
                Some(env) => env,
                None => {
                    log::warn!("lsp: login shell env capture failed, using process env");
                    HashMap::new()
                }
            }
        }
        #[cfg(windows)]
        {
            HashMap::new()
        }
    })
}

/// A command may only be a **bare program name**: a path is refused rather than resolved.
///
/// The command comes from the frontend, and a custom LSP server is a record in the settings file -
/// a plain JSON file any process running as this user can append to. `which::which_in` accepts a
/// path, so `command: "C:\Windows\System32\cmd.exe"` was the whole of "run any program, at any
/// working directory". A bare name still has to be found on `PATH` (which is what a real server is),
/// and it can no longer name a specific executable by path.
fn is_bare_name(command: &str) -> bool {
    // Trimmed here rather than by the caller: a name and a name with spaces around it are the same
    // question, and a predicate that answers differently for them is a trap.
    let command = command.trim();
    !command.is_empty()
        && !command.contains('/')
        && !command.contains('\\')
        && !command.contains(':')
}

pub fn resolve_binary(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if !is_bare_name(command) {
        if !command.is_empty() {
            log::warn!("lsp: refusing a command that is a path: {command}");
        }
        return None;
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let path = server_env_overlay()
        .get("PATH")
        .cloned()
        .or_else(|| std::env::var("PATH").ok());
    which::which_in(command, path, cwd).ok()
}

#[cfg(unix)]
fn capture_login_env() -> Option<HashMap<String, String>> {
    use shared_child::SharedChild;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::sync::Arc;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = Command::new(&shell);
    cmd.args(["-l", "-c", "/usr/bin/env -0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let child = Arc::new(SharedChild::spawn(&mut cmd).ok()?);
    let mut stdout = child.take_stdout()?;
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("verta-lsp-env-capture".into())
        .spawn(move || {
            let mut buf = Vec::with_capacity(8 * 1024);
            let _ = stdout.read_to_end(&mut buf);
            let _ = tx.send(buf);
        })
        .ok()?;

    let bytes = match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(b) => {
            let _ = child.wait();
            b
        }
        Err(_) => {
            log::warn!("lsp: login shell env capture timed out after {CAPTURE_TIMEOUT:?}");
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };

    let env: HashMap<String, String> = bytes
        .split(|&b| b == 0)
        .filter(|chunk| !chunk.is_empty())
        .filter_map(|chunk| {
            let s = std::str::from_utf8(chunk).ok()?;
            let (k, v) = s.split_once('=')?;
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect();
    if env.is_empty() {
        return None;
    }
    Some(env)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn resolve_binary_finds_sh() {
        let p = resolve_binary("sh").expect("sh must resolve");
        assert!(p.is_absolute());
    }

    #[test]
    fn resolve_binary_rejects_empty_and_missing() {
        assert!(resolve_binary("").is_none());
        assert!(resolve_binary("   ").is_none());
        assert!(resolve_binary("verta-definitely-not-a-real-binary").is_none());
    }

}

/// The rule itself, without a shell to resolve against: this has to hold on Windows, which is the
/// only platform the release ships for - and there `tests` above is not even compiled.
#[cfg(test)]
mod name_tests {
    use super::*;

    /// The command reaches `Command::new`, so a path in it is arbitrary code execution.
    ///
    /// Each of these is a shape a settings file could carry, and each one names a specific program
    /// rather than a program to look up.
    #[test]
    fn a_command_that_is_a_path_is_refused() {
        for command in [
            "/bin/sh",
            "./sh",
            r"C:\Windows\System32\cmd.exe",
            r"..\sh",
            r"..\..\sh",
            // A drive letter with no separator is the same trick, spelled shorter.
            "c:sh",
            // And the Windows spelling of the same idea.
            r".\sh",
        ] {
            assert!(!is_bare_name(command), "{command} was accepted as a bare name");
            assert!(resolve_binary(command).is_none(), "{command} resolved");
        }
    }

    #[test]
    fn a_bare_program_name_is_allowed_through() {
        for command in ["rust-analyzer", "typescript-language-server", "gopls", "ruff"] {
            assert!(is_bare_name(command), "{command} was refused as a bare name");
        }
        assert!(!is_bare_name(""));
        assert!(!is_bare_name("   "));
    }
}
