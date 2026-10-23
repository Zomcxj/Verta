//! A thin wrapper around the `gh` CLI: spawn processes, collect output, and turn a
//! `gh api user` result into a login state.
//!
//! gh is **account-scoped** and always runs in the host environment, never following
//! the current space / distro (hence no WorkspaceEnv here, and no wsl.exe). Processes
//! are run the same way as in `modules/git/process.rs`: `hide_console` +
//! `proc::capture::run`, with `NotFound` / `PermissionDenied` on spawn classified
//! separately as "gh not installed".

use std::io::Read;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use shared_child::SharedChild;

use crate::modules::proc::capture::{self, Limits};
use crate::modules::proc::hide_console;

use super::repos::{classify_failure, error_excerpt, parse_login, Failure};

/// Timeout for a small query (`gh api user`).
pub const USER_TIMEOUT_SECS: u64 = 20;
/// Timeout for pasted-PAT login: gh has to present the token to GitHub once.
pub const AUTH_TOKEN_TIMEOUT_SECS: u64 = 60;
/// Timeout for browser auth / logout: a human drives the browser step, so be
/// generous.
pub const AUTH_WEB_TIMEOUT_SECS: u64 = 600;
/// Timeout for one page of repos (up to 100 JSON entries): a slow network should
/// not leave it hanging forever.
pub const REPOS_TIMEOUT_SECS: u64 = 45;
/// Timeout for "latest CI run": a single record, lighter than a full page of repos.
pub const CI_TIMEOUT_SECS: u64 = 30;
/// Timeout for a permission lookup: one `gh repo view`.
pub const PERMISSION_TIMEOUT_SECS: u64 = 30;
/// Timeout for editing settings / deleting a repo: one API call, but GitHub is
/// occasionally slow.
pub const REPO_ADMIN_TIMEOUT_SECS: u64 = 60;
/// Timeout for rerun / cancel: one API call, lighter than fetching a list.
pub const RUN_ACTION_TIMEOUT_SECS: u64 = 30;
/// Timeout for fetching a log: the whole log is downloaded, slower than one API
/// call.
pub const LOG_TIMEOUT_SECS: u64 = 90;
/// Timeout for a page of issues / PRs: up to a hundred bodies come back, heavier
/// than an ordinary query.
pub const ISSUES_TIMEOUT_SECS: u64 = 45;
/// Timeout for one issue / PR detail (body / comments / PR info).
pub const ISSUE_DETAIL_TIMEOUT_SECS: u64 = 30;
/// Timeout for write actions (comment / open / close / merge / create): one API call,
/// but GitHub is occasionally slow.
pub const ISSUE_ACTION_TIMEOUT_SECS: u64 = 60;
/// Output cap for logs: far more generous than ordinary queries yet still bounded
/// (hitting it is reported as "cap reached").
pub const LOG_STDOUT_CAP: usize = 8 * 1024 * 1024;
const MAX_TIMEOUT_SECS: u64 = 120;
/// A page of 100 repos is a few hundred KiB of JSON, so this leaves ample headroom.
/// A truncated body fails to parse, and that is reported as a parse failure rather
/// than silently dropping a few entries.
const STDOUT_CAP: usize = 4 * 1024 * 1024;
const STDERR_CAP: usize = 64 * 1024;

pub struct GhOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// The output hit the cap and was cut: matters for logs (we got the beginning,
    /// more follows).
    pub stdout_truncated: bool,
}

impl GhOutput {
    pub fn is_ok(&self) -> bool {
        !self.timed_out && self.exit_code == Some(0)
    }

    /// Raw text on failure: some gh errors only go to stdout, so include both to
    /// avoid missing anything.
    pub fn failure_text(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if self.timed_out {
            parts.push("gh 命令超时，没有完整结果".into());
        }
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            parts.push(stderr.to_string());
        }
        let stdout = self.stdout.trim();
        if !stdout.is_empty() {
            parts.push(stdout.to_string());
        }
        if parts.is_empty() {
            parts.push("gh 没有给出任何输出".into());
        }
        parts.join("\n")
    }
}

/// The two failures that can come out of spawning gh. `NotFound` /
/// `PermissionDenied` mean "gh not installed"; everything else (pipes, other I/O) is
/// reported honestly as Io.
pub enum GhRunError {
    NotInstalled,
    Io(String),
}

pub fn run(args: &[&str], timeout_secs: u64) -> Result<GhOutput, GhRunError> {
    run_with_cap(args, timeout_secs, STDOUT_CAP)
}

/// Build a gh command: arguments passed one by one, no interactive prompts, no
/// colour, proxy applied, console hidden.
///
/// The caller chooses stdio (ordinary queries leave stdin=null and just collect
/// output; pasted PAT / browser auth need extra pipes).
pub fn command(args: &[&str]) -> Command {
    // Arguments go one by one; no shell string is ever assembled.
    let mut cmd = Command::new("gh");
    cmd.args(args)
        // No interactive prompts / update notices, and no colour escapes (the text
        // must be pasteable into an error message).
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    // gh ignores Windows' Internet settings, and an inherited proxy variable may be an
    // empty string; without an explicit value it connects directly and times out (see
    // modules::proxy).
    let proxy = crate::modules::proxy::resolve(None);
    crate::modules::proxy::apply(&mut cmd, proxy.as_deref());
    cmd
}

/// Spawn a gh child process and hand back its output pipes (stdout / stderr are
/// always piped).
///
/// For cases that read while running (browser auth streams the one-time code to the
/// UI); use [`run`] for one-shot queries.
pub fn spawn(args: &[&str], pipe_stdin: bool) -> std::io::Result<SharedChild> {
    let mut cmd = command(args);
    if pipe_stdin {
        cmd.stdin(Stdio::piped());
    }
    SharedChild::spawn(&mut cmd)
}

/// Spawn a gh child and invoke the callback as each of its two pipes is read (reads
/// happen on a dedicated thread).
pub fn pump<R: Read + Send + 'static>(reader: R, on_text: impl Fn(&str) + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                // The pipe hits EOF when the process exits; an error also counts as
                // done — never leave the UI hanging on it.
                Ok(0) | Err(_) => return,
                Ok(count) => on_text(&String::from_utf8_lossy(&buf[..count])),
            }
        }
    });
}

/// Write text to gh's stdin and wait for it to exit.
///
/// Pasted PATs can only go this way (`gh auth login --with-token` reads the token from
/// stdin): **the text only passes through memory** — it is gone once written to the
/// pipe, never reaching a file or app storage.
pub fn run_with_stdin(
    args: &[&str],
    stdin_text: &str,
    timeout_secs: u64,
) -> Result<GhOutput, GhRunError> {
    let child = std::sync::Arc::new(spawn(args, true).map_err(classify_spawn_error)?);

    if let Some(mut stdin) = child.take_stdin() {
        // Close after writing: gh only accepts the token once it sees EOF.
        let _ = stdin.write_all(stdin_text.as_bytes());
        let _ = stdin.write_all(b"\n");
    }

    let stdout = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let stderr = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    if let Some(pipe) = child.take_stdout() {
        let sink = stdout.clone();
        pump(pipe, move |text| {
            if let Ok(mut guard) = sink.lock() {
                guard.extend_from_slice(text.as_bytes());
            }
        });
    }
    if let Some(pipe) = child.take_stderr() {
        let sink = stderr.clone();
        pump(pipe, move |text| {
            if let Ok(mut guard) = sink.lock() {
                guard.extend_from_slice(text.as_bytes());
            }
        });
    }

    let dur = Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
    let status = child.wait_timeout(dur).map_err(|e| GhRunError::Io(e.to_string()))?;
    let timed_out = status.is_none();
    if timed_out {
        let _ = child.kill();
        let _ = child.wait();
    }
    // The pipes reach EOF soon after the process exits; this short wait only lets the
    // reader threads drain the tail.
    std::thread::sleep(Duration::from_millis(200));

    let take = |sink: &std::sync::Arc<std::sync::Mutex<Vec<u8>>>| {
        sink.lock()
            .map(|guard| String::from_utf8_lossy(&guard).into_owned())
            .unwrap_or_default()
    };
    Ok(GhOutput {
        stdout: take(&stdout),
        stderr: take(&stderr),
        exit_code: status.and_then(|status| status.code()),
        timed_out,
        stdout_truncated: false,
    })
}

fn classify_spawn_error(error: std::io::Error) -> GhRunError {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
            GhRunError::NotInstalled
        }
        _ => GhRunError::Io(error.to_string()),
    }
}

pub fn run_with_cap(
    args: &[&str],
    timeout_secs: u64,
    stdout_cap: usize,
) -> Result<GhOutput, GhRunError> {
    let mut cmd = command(args);

    let dur = Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
    let captured = capture::run(
        &mut cmd,
        dur,
        Limits {
            stdout: stdout_cap,
            stderr: STDERR_CAP,
            stop_on_stdout_cap: false,
        },
    )
    .map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
            GhRunError::NotInstalled
        }
        _ => GhRunError::Io(e.to_string()),
    })?;

    Ok(GhOutput {
        stdout: String::from_utf8_lossy(&captured.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&captured.stderr).into_owned(),
        exit_code: captured.exit_code,
        timed_out: captured.timed_out,
        stdout_truncated: captured.stdout_truncated,
    })
}

/// Verdict of one `gh api user --jq .login`.
pub enum LoginProbe {
    Login(String),
    /// Failure kind plus the already-truncated raw text.
    Failed(Failure, String),
}

/// Turn the login probe into "login name / failure".
///
/// Exit 0 without a login name counts as not logged in: without an identity, do not
/// claim success.
pub fn probe_login(output: &GhOutput) -> LoginProbe {
    if output.is_ok() {
        return match parse_login(&output.stdout) {
            Some(login) => LoginProbe::Login(login),
            None => LoginProbe::Failed(Failure::NotLoggedIn, "gh api user 没有返回登录名".into()),
        };
    }
    let text = output.failure_text();
    LoginProbe::Failed(classify_failure(&text), error_excerpt(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(stdout: &str, stderr: &str, exit_code: Option<i32>) -> GhOutput {
        GhOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code,
            timed_out: false,
            stdout_truncated: false,
        }
    }

    #[test]
    fn a_successful_probe_yields_the_login() {
        let probed = probe_login(&output("Zomcxj\n", "", Some(0)));
        match probed {
            LoginProbe::Login(login) => assert_eq!(login, "Zomcxj"),
            LoginProbe::Failed(..) => panic!("expected a login"),
        }
    }

    #[test]
    fn a_probe_that_exits_zero_without_a_login_is_not_a_success() {
        match probe_login(&output("", "", Some(0))) {
            LoginProbe::Failed(Failure::NotLoggedIn, message) => assert!(!message.is_empty()),
            LoginProbe::Failed(..) => panic!("expected notLoggedIn"),
            LoginProbe::Login(_) => panic!("expected a failure"),
        }
    }

    #[test]
    fn an_unauthenticated_probe_reports_the_original_wording() {
        let probed = probe_login(&output(
            "",
            "To get started with GitHub CLI, please run:  gh auth login\n",
            Some(1),
        ));
        match probed {
            LoginProbe::Failed(Failure::NotLoggedIn, message) => {
                assert!(message.contains("gh auth login"), "{message}");
            }
            LoginProbe::Failed(Failure::Error, message) => {
                panic!("该归成未登录，而不是其它错误：{message}")
            }
            LoginProbe::Login(_) => panic!("expected a failure"),
        }
    }

    #[test]
    fn a_transport_failure_is_an_error_not_a_login_problem() {
        // Network failures other than 401 must not steer the user into logging in again.
        match probe_login(&output("", "dial tcp: connection refused", Some(1))) {
            LoginProbe::Failed(Failure::Error, message) => {
                assert_eq!(message, "dial tcp: connection refused");
            }
            LoginProbe::Failed(Failure::NotLoggedIn, message) => {
                panic!("网络失败不该归成未登录：{message}")
            }
            LoginProbe::Login(_) => panic!("expected a failure"),
        }
    }

    #[test]
    fn failure_text_prefers_stderr_and_mentions_a_timeout() {
        let text = output("on stdout", "on stderr", Some(1)).failure_text();
        assert_eq!(text, "on stderr\non stdout");

        let mut timed_out = output("", "", None);
        timed_out.timed_out = true;
        assert!(timed_out.failure_text().contains("超时"));
        assert!(!timed_out.is_ok());

        assert!(!output("", "", Some(1)).failure_text().is_empty());
    }
}
