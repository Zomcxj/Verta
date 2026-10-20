//! `gh` CLI 的薄封装：起进程、收输出，以及把一次 `gh api user` 的结论翻成登录态。
//!
//! gh 是**账号级**的，一律在主机环境跑，不跟当前空间 / 发行版走（所以这里没有
//! WorkspaceEnv，也不走 wsl.exe）。跑进程的姿势照 `modules/git/process.rs`：
//! `hide_console` + `proc::capture::run`，spawn 的 `NotFound` / `PermissionDenied`
//! 单独归成「没装 gh」。

use std::process::{Command, Stdio};
use std::time::Duration;

use crate::modules::proc::capture::{self, Limits};
use crate::modules::proc::hide_console;

use super::repos::{classify_failure, error_excerpt, parse_login, Failure};

/// 一次小查询（`gh api user`）的等待上限。
pub const USER_TIMEOUT_SECS: u64 = 20;
/// 一页仓库（最多 100 条 JSON）的等待上限：慢网络也别让它一直挂着。
pub const REPOS_TIMEOUT_SECS: u64 = 45;
/// 一次「最近一次 CI 运行」的等待上限：一条记录，比整页仓库轻。
pub const CI_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
/// 一页 100 条仓库的 JSON 大概几百 KiB，留足余量。真被截断的话 JSON 会解析失败，
/// 那种情况按解析失败如实报出来，不会静悄悄少几条。
const STDOUT_CAP: usize = 4 * 1024 * 1024;
const STDERR_CAP: usize = 64 * 1024;

pub struct GhOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
}

impl GhOutput {
    pub fn is_ok(&self) -> bool {
        !self.timed_out && self.exit_code == Some(0)
    }

    /// 失败时的原文：gh 有些错误只写 stdout，两边都带上省得漏。
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

/// 起 gh 本机进程时能遇到的两种失败。`NotFound` / `PermissionDenied` 是「没装 gh」，
/// 其余（管道、权限外的 io）归到如实报错的 Io。
pub enum GhRunError {
    NotInstalled,
    Io(String),
}

pub fn run(args: &[&str], timeout_secs: u64) -> Result<GhOutput, GhRunError> {
    // 参数一条一条传，不拼 shell 字符串。
    let mut cmd = Command::new("gh");
    cmd.args(args)
        // 别弹任何交互提示 / 更新通知，也别加颜色转义（要能直接贴进 error 里）。
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);
    // gh 不读 Windows 的 Internet 设置，继承来的代理变量还可能是空串，
    // 不显式给一份就会直连超时（见 modules::proxy）。
    let proxy = crate::modules::proxy::resolve(None);
    crate::modules::proxy::apply(&mut cmd, proxy.as_deref());

    let dur = Duration::from_secs(timeout_secs.clamp(1, MAX_TIMEOUT_SECS));
    let captured = capture::run(
        &mut cmd,
        dur,
        Limits {
            stdout: STDOUT_CAP,
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
    })
}

/// 一次 `gh api user --jq .login` 的结论。
pub enum LoginProbe {
    Login(String),
    /// 失败类别 + 已经截断好的原文。
    Failed(Failure, String),
}

/// 把探测登录态的那次调用翻成「登录名 / 失败」。
///
/// exit 0 却没吐登录名时按未登录算：拿不到身份就别硬说成功。
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
        // 401 之外的网络失败不能引导用户去重新登录。
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