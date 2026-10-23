//! Wire types for the remote repository list. The frontend already calls these
//! field names, so renaming one is a contract change.

use serde::Serialize;

/// `kind` for a successful query.
pub const KIND_READY: &str = "ready";
/// The machine has no gh CLI.
pub const KIND_NOT_INSTALLED: &str = "notInstalled";
/// gh is installed, but the current account is logged out / its credentials expired.
pub const KIND_NOT_LOGGED_IN: &str = "notLoggedIn";
/// Any other failure (network, rate limit, unparsable output).
pub const KIND_ERROR: &str = "error";
/// The repository has no workflow runs at all (CI not configured, or never run).
///
/// This is not a failure: we know for certain there is nothing, so it gets its
/// own kind and the UI says "no CI" instead of showing an error.
pub const KIND_NONE: &str = "none";

/// Fallback when gh produced no displayable output, so the frontend never gets
/// an empty string.
const NO_DETAIL: &str = "gh 没有给出错误输出";

/// Result of one "remote repository list" query.
///
/// `kind` says what was found:
/// - `ready`: the query succeeded (`repos` may be empty, meaning there really are no repos);
/// - `notInstalled` / `notLoggedIn` / `error`: a failure, with the cause carried in
///   `error` verbatim, never disguised as an empty list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReposPayload {
    pub kind: &'static str,
    /// The logged-in username.
    pub login: Option<String>,
    /// The `name` from `gh api user`, possibly empty.
    pub account_name: Option<String>,
    pub repos: Vec<RemoteRepo>,
    /// Hit the page limit and the last page was still full: there are likely more repos.
    pub truncated: bool,
    /// Raw output when `kind` is not `ready` (the first few lines of gh's stderr / stdout).
    pub error: Option<String>,
}

/// A remote repository. Only the fields the list renders; details (Releases /
/// Actions) belong to later slices.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    /// `owner/name`.
    pub full_name: String,
    pub owner: String,
    pub name: String,
    pub is_private: bool,
    pub is_fork: bool,
    pub is_archived: bool,
    pub language: Option<String>,
    /// GitHub's ISO8601 string as-is; the frontend turns it into relative time.
    pub pushed_at: Option<String>,
    pub description: Option<String>,
    /// `https://github.com/owner/name`.
    pub web_url: String,
}

impl RemoteReposPayload {
    pub fn ready(
        login: String,
        account_name: Option<String>,
        repos: Vec<RemoteRepo>,
        truncated: bool,
    ) -> Self {
        Self {
            kind: KIND_READY,
            login: Some(login),
            account_name,
            repos,
            truncated,
            error: None,
        }
    }

    /// Failure: `repos` is empty and `error` always has content (the fallback text
    /// when it is blank, so the frontend never renders nothing).
    pub fn failed(kind: &'static str, error: impl Into<String>) -> Self {
        Self::failed_after(kind, error, Vec::new())
    }

    /// Failure midway through paging: keep the repos already fetched rather than
    /// throwing them away. `kind` is no longer `ready`, so the frontend will not
    /// treat this as a complete list.
    pub fn failed_after(
        kind: &'static str,
        error: impl Into<String>,
        repos: Vec<RemoteRepo>,
    ) -> Self {
        let error = error.into();
        let error = if error.trim().is_empty() {
            NO_DETAIL.to_string()
        } else {
            error
        };
        Self {
            kind,
            login: None,
            account_name: None,
            repos,
            truncated: false,
            error: Some(error),
        }
    }

    pub fn not_installed() -> Self {
        Self::failed(KIND_NOT_INSTALLED, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// A repository's most recent workflow run. Only the fields the UI shows and
/// links to.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCiRun {
    /// Workflow name (something like `build` or `CI`).
    pub name: String,
    /// `queued` / `in_progress` / `completed` etc., exactly what GitHub returns.
    pub status: String,
    /// `success` / `failure` / `cancelled` etc.; empty until the run finishes.
    pub conclusion: Option<String>,
    pub run_number: u64,
    pub head_branch: Option<String>,
    /// ISO8601; the frontend turns it into relative time.
    pub updated_at: Option<String>,
    pub url: String,
}

/// CI query result for a single repository. `kind` shares the repository list's
/// semantics, plus `none` (no runs recorded).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCiPayload {
    pub kind: &'static str,
    /// Which repository was queried (`owner/name`); the frontend uses it to put the
    /// result back on the matching row.
    pub repo: String,
    pub run: Option<RepoCiRun>,
    pub error: Option<String>,
}

impl RepoCiPayload {
    pub fn found(repo: impl Into<String>, run: RepoCiRun) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run: Some(run),
            error: None,
        }
    }

    pub fn empty(repo: impl Into<String>) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            run: None,
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run: None,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// Fallback text: used when gh produced no displayable output, so the frontend
/// never gets an empty string.
fn or_no_detail(error: String) -> String {
    if error.trim().is_empty() {
        NO_DETAIL.to_string()
    } else {
        error
    }
}

/// One workflow run (a row in the run list).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoActionRun {
    /// GitHub's run id: rerun/cancel must send it back unchanged.
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub run_number: u64,
    pub head_branch: Option<String>,
    /// `push` / `pull_request` / `workflow_dispatch` etc., exactly what GitHub returns.
    pub event: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
}

/// A repository's run list. `kind` shares the CI payload's semantics (`none`
/// means there really are no runs).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoActionRunsPayload {
    pub kind: &'static str,
    pub repo: String,
    pub runs: Vec<RepoActionRun>,
    pub error: Option<String>,
}

impl RepoActionRunsPayload {
    /// Query succeeded. An empty list maps to `none` (genuinely no runs), not
    /// `ready`, consistent with the CI payload.
    pub fn found(repo: impl Into<String>, runs: Vec<RepoActionRun>) -> Self {
        if runs.is_empty() {
            return Self::empty(repo);
        }
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            runs,
            error: None,
        }
    }

    pub fn empty(repo: impl Into<String>) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            runs: Vec::new(),
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            runs: Vec::new(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// Outcome of a rerun / cancel.
///
/// Success carries no data (gh has nothing useful to say when it works); failure
/// returns gh's own words: cancelling an already-finished run, for instance, is
/// rejected by GitHub and that message is exactly what the user needs to see.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunActionResult {
    pub kind: &'static str,
    pub repo: String,
    pub run_id: u64,
    pub error: Option<String>,
}

impl RepoRunActionResult {
    pub fn ok(repo: impl Into<String>, run_id: u64) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run_id,
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        run_id: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run_id,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, run_id: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            run_id,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

/// A single step inside the run details.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunStep {
    pub number: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
}

/// A job inside the run details (with its step tree).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunJob {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub url: Option<String>,
    /// Which runner it ran on; falls back to the first label when GitHub gives no
    /// runner name.
    pub runner: Option<String>,
    pub steps: Vec<RepoRunStep>,
}

/// The job list of one run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunJobsPayload {
    pub kind: &'static str,
    pub repo: String,
    pub run_id: u64,
    pub jobs: Vec<RepoRunJob>,
    pub error: Option<String>,
}

impl RepoRunJobsPayload {
    pub fn found(repo: impl Into<String>, run_id: u64, jobs: Vec<RepoRunJob>) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run_id,
            jobs,
            error: None,
        }
    }

    /// No jobs at all (still queued, or the workflow has no jobs): an answer we
    /// know to be "none".
    pub fn empty(repo: impl Into<String>, run_id: u64) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            run_id,
            jobs: Vec::new(),
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        run_id: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run_id,
            jobs: Vec::new(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, run_id: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            run_id,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

/// One log line: the prefix is split into job / step / time, the rest is the body.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunLogLine {
    pub job: String,
    pub step: String,
    /// ISO8601 (GitHub returns UTC with fractional seconds); empty when unrecognised.
    pub time: String,
    pub text: String,
}

/// The log of one run.
///
/// `clipped` and `capped` are different things and read differently in the UI:
/// `clipped` means we kept only the tail (the log was longer), `capped` means the
/// per-fetch limit was hit (we got the leading chunk and there is more after it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRunLogPayload {
    pub kind: &'static str,
    pub repo: String,
    pub run_id: u64,
    pub lines: Vec<RepoRunLogLine>,
    /// Total number of lines before truncation.
    pub total_lines: usize,
    pub clipped: bool,
    pub capped: bool,
    pub error: Option<String>,
}

impl RepoRunLogPayload {
    pub fn found(
        repo: impl Into<String>,
        run_id: u64,
        lines: Vec<RepoRunLogLine>,
        total_lines: usize,
        clipped: bool,
        capped: bool,
    ) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            run_id,
            lines,
            total_lines,
            clipped,
            capped,
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        run_id: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            run_id,
            lines: Vec::new(),
            total_lines: 0,
            clipped: false,
            capped: false,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, run_id: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            run_id,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

/// An attachment on a release (an installer, say).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoReleaseAsset {
    /// GitHub's asset id: downloads must send it back unchanged.
    pub id: u64,
    pub name: String,
    /// Size in bytes; 0 when GitHub omits it (the UI then shows an indeterminate
    /// state instead of pretending to know the total).
    pub size: u64,
    pub download_count: u64,
    pub content_type: Option<String>,
    pub updated_at: Option<String>,
}

/// A release: the list and the detail view share one shape (the body already
/// comes with the list response, so no extra API call).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoRelease {
    pub id: u64,
    pub tag_name: String,
    /// Release title; falls back to the tag while parsing when empty, so the UI
    /// never has to check again.
    pub name: String,
    /// Markdown body; empty string when GitHub returns null.
    pub body: String,
    pub draft: bool,
    pub prerelease: bool,
    pub created_at: Option<String>,
    pub published_at: Option<String>,
    pub html_url: String,
    pub assets: Vec<RepoReleaseAsset>,
}

/// A repository's release list.
///
/// An empty list is a definite "no releases" and maps to `ready` (unlike the run
/// list: here an empty list is itself a valid, complete answer and the UI just
/// looks at `releases.len()`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoReleasesPayload {
    pub kind: &'static str,
    pub repo: String,
    pub releases: Vec<RepoRelease>,
    pub error: Option<String>,
}

impl RepoReleasesPayload {
    pub fn ready(repo: impl Into<String>, releases: Vec<RepoRelease>) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            releases,
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            releases: Vec::new(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// The current account's permission on a repository (decides whether write
/// actions are offered).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPermissionPayload {
    pub kind: &'static str,
    pub repo: String,
    /// `ADMIN` / `MAINTAIN` / `WRITE` / `TRIAGE` / `READ`; null when unknown.
    pub permission: Option<String>,
    /// Whether write operations are allowed. **True when the lookup fails**: the
    /// buttons still render and GitHub gets to reject them.
    pub can_write: bool,
    pub error: Option<String>,
}

impl RepoPermissionPayload {
    pub fn found(repo: impl Into<String>, permission: Option<String>, can_write: bool) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            permission,
            can_write,
            error: None,
        }
    }

    /// Still needs an answer when the lookup fails: render as "allowed" and let
    /// GitHub reject the write.
    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            permission: None,
            can_write: true,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// What a repository's settings panel needs (description, visibility, and
/// whether they can be changed).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSettingsPayload {
    pub kind: &'static str,
    pub repo: String,
    /// null when there is no description.
    pub description: Option<String>,
    /// `PUBLIC` / `PRIVATE` / `INTERNAL`.
    pub visibility: Option<String>,
    /// Whether settings can be changed / the repository deleted. **True when the
    /// lookup fails**: show the buttons and let GitHub reject them.
    pub can_admin: bool,
    pub error: Option<String>,
}

impl RepoSettingsPayload {
    pub fn found(repo: impl Into<String>, settings: super::repo_admin::RepoSettings) -> Self {
        let can_admin = super::permission::admin_allowed(settings.permission.as_deref());
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            description: settings.description,
            visibility: settings.visibility,
            can_admin,
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            description: None,
            visibility: None,
            can_admin: true,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// Result of a repository admin action (edit description / toggle visibility /
/// delete).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoActionResult {
    pub kind: &'static str,
    pub repo: String,
    pub error: Option<String>,
}

impl RepoActionResult {
    pub fn ok(repo: impl Into<String>) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// The local gh CLI's current login state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusPayload {
    /// `ready` (logged in) / `none` (no host logged in) / `notInstalled` / `error`.
    pub kind: &'static str,
    pub host: Option<String>,
    pub login: Option<String>,
    /// The state gh reports, `success` / `failed` etc.
    pub state: Option<String>,
    pub active: bool,
    /// Where the token comes from (`keyring` etc.). **The token itself never
    /// appears here.**
    pub token_source: Option<String>,
    pub git_protocol: Option<String>,
    pub scopes: Vec<String>,
    pub error: Option<String>,
}

impl AuthStatusPayload {
    pub fn found(account: super::auth::AuthAccount) -> Self {
        Self {
            kind: KIND_READY,
            host: Some(account.host),
            login: account.login,
            state: Some(account.state),
            active: account.active,
            token_source: account.token_source,
            git_protocol: account.git_protocol,
            scopes: account.scopes,
            error: None,
        }
    }

    /// Definite answer: no host is logged in on this machine. Not an error.
    pub fn none() -> Self {
        Self {
            kind: "none",
            host: None,
            login: None,
            state: None,
            active: false,
            token_source: None,
            git_protocol: None,
            scopes: Vec::new(),
            error: None,
        }
    }

    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            kind: KIND_ERROR,
            host: None,
            login: None,
            state: None,
            active: false,
            token_source: None,
            git_protocol: None,
            scopes: Vec::new(),
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed() -> Self {
        Self {
            kind: KIND_NOT_INSTALLED,
            ..Self::failed("未安装 gh CLI（找不到 gh 命令）")
        }
    }
}

/// Result of a login / logout action.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthActionPayload {
    pub kind: &'static str,
    /// What gh printed during browser auth (one-time code, failure reason); null
    /// when there is nothing.
    pub output: Option<String>,
    pub error: Option<String>,
}

impl AuthActionPayload {
    pub fn ok(output: Option<String>) -> Self {
        Self {
            kind: KIND_READY,
            output: output.filter(|text| !text.trim().is_empty()),
            error: None,
        }
    }

    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            kind: KIND_ERROR,
            output: None,
            error: Some(or_no_detail(error.into())),
        }
    }

    /// Aborted by the user (the browser-auth path): not an error, so the UI does
    /// not need a red banner.
    pub fn cancelled(output: Option<String>) -> Self {
        Self {
            kind: "cancelled",
            output: output.filter(|text| !text.trim().is_empty()),
            error: None,
        }
    }

    pub fn not_installed() -> Self {
        Self {
            kind: KIND_NOT_INSTALLED,
            output: None,
            error: Some("未安装 gh CLI（找不到 gh 命令）".to_string()),
        }
    }
}

/// A chunk of output gh printed during browser auth (the one-time code is in it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthLoginProgress {
    pub text: String,
}

/// Progress of an asset download. The backend coalesces at 64 KiB / 100 ms before
/// pushing, so IPC is not hammered per chunk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDownloadProgress {
    /// Download id generated by the frontend, used to match progress to its row.
    pub id: String,
    pub written: u64,
    /// Asset size; 0 when GitHub omits it.
    pub total: u64,
}

/// Outcome of an asset download.
///
/// Cancellation is not an error: the user stopped it, so the UI should not show a
/// red banner. On failure `error` is gh's / the filesystem's own message.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDownloadResult {
    /// `ok` / `cancelled` / `error`.
    pub kind: &'static str,
    /// Final path on success.
    pub path: Option<String>,
    pub error: Option<String>,
}

impl ReleaseDownloadResult {
    pub fn ok(path: impl Into<String>) -> Self {
        Self {
            kind: "ok",
            path: Some(path.into()),
            error: None,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            kind: "cancelled",
            path: None,
            error: None,
        }
    }

    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            kind: "error",
            path: None,
            error: Some(or_no_detail(error.into())),
        }
    }
}

// ------------------------------------------------------------ issue / PR

/// An issue or PR (as used in lists).
///
/// GitHub's `issues` endpoint returns both; PRs additionally carry a
/// `pull_request` object, and that is what `is_pull_request` is derived from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    pub title: String,
    /// Body. Not shown in the list, but the frontend needs it for keyword
    /// filtering, so it is passed along.
    pub body: String,
    /// `open` / `closed`.
    pub state: String,
    pub is_pull_request: bool,
    /// Drafts only exist in PR details; the list endpoint cannot tell, so we
    /// honestly report "not a draft".
    pub is_draft: bool,
    /// Already merged into the base (PR only).
    pub merged: bool,
    pub author: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Comment count.
    pub comments: u32,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub html_url: String,
    /// Locked issues cannot be commented on.
    pub locked: bool,
}

/// A repository's issue / PR list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueListPayload {
    pub kind: &'static str,
    pub repo: String,
    pub issues: Vec<IssueSummary>,
    /// Hit the item limit and the last page was still full: there are likely more.
    pub truncated: bool,
    /// Raw output when `kind` is not `ready`.
    pub error: Option<String>,
}

impl IssueListPayload {
    /// Query succeeded. An empty list maps to `none` (genuinely nothing), not `ready`.
    pub fn found(repo: impl Into<String>, issues: Vec<IssueSummary>, truncated: bool) -> Self {
        if issues.is_empty() {
            return Self::empty(repo);
        }
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            issues,
            truncated,
            error: None,
        }
    }

    pub fn empty(repo: impl Into<String>) -> Self {
        Self {
            kind: KIND_NONE,
            repo: repo.into(),
            issues: Vec::new(),
            truncated: false,
            error: None,
        }
    }

    pub fn failed(kind: &'static str, repo: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            kind,
            repo: repo.into(),
            issues: Vec::new(),
            truncated: false,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// A comment.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: Option<String>,
}

/// One commit of a PR's commit list.
///
/// Only what a single row needs: the full message would not fit one line anyway, and
/// the diff / files of a commit are not fetched.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCommit {
    pub sha: String,
    /// First line of the commit message only.
    pub summary: String,
    pub author: String,
    pub html_url: String,
}

/// PR-only information (plain issues have none of this).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    /// Source branch.
    pub head: String,
    pub head_sha: String,
    /// Target branch.
    pub base: String,
    pub draft: bool,
    pub merged: bool,
    /// `None` = GitHub is still computing (asynchronously), not "cannot merge".
    pub mergeable: Option<bool>,
    pub mergeable_state: String,
    /// Why it cannot merge right now, as a **reason code**: `merged` / `closed` /
    /// `draft` / `conflict` / `computing` / `unknown`. `None` when it can merge.
    ///
    /// A code rather than a sentence: this text is shown to the user and must
    /// follow the UI language, so the UI resolves the wording from the code.
    ///
    /// Computed here rather than in the UI so there is exactly one authority on
    /// "can this merge"; the UI just disables the button accordingly.
    pub merge_blocked: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub commits: u32,
    pub state: String,
    pub author: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub html_url: String,
    pub locked: bool,
}

/// Check status rollup.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSummary {
    pub total: u32,
    pub ok: u32,
    pub failed: u32,
    pub pending: u32,
    /// Only part of the checks were seen (GitHub caps a page at 100). The overall
    /// state must not claim "all green" in that case.
    pub truncated: bool,
    /// `pass` / `fail` / `pending` / `partial` / `none`.
    pub state: &'static str,
}

/// Details of one issue / PR.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub is_pull_request: bool,
    pub is_draft: bool,
    pub merged: bool,
    pub author: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub html_url: String,
    pub locked: bool,
    pub comments: Vec<IssueComment>,
    /// Why the comments are missing. The body is still shown; the comment section
    /// says so itself.
    pub comments_error: Option<String>,
    /// PRs only.
    pub pull_request: Option<PullRequestInfo>,
    /// Why the PR information is missing (this is a PR, but that block failed).
    pub pull_request_error: Option<String>,
    /// PRs only. `None` = unavailable (different from "this PR has no checks",
    /// which is `Some` with `state == "none"`).
    pub checks: Option<CheckSummary>,
    /// PRs only. `None` = unavailable (different from "this PR has no commits",
    /// which is `Some` with an empty list).
    pub commits: Option<Vec<PullRequestCommit>>,
}

/// Result of a single issue / PR detail query.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetailPayload {
    pub kind: &'static str,
    pub repo: String,
    /// `None` on failure.
    pub detail: Option<IssueDetail>,
    pub error: Option<String>,
}

impl IssueDetailPayload {
    pub fn found(repo: impl Into<String>, detail: IssueDetail) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            detail: Some(detail),
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            detail: None,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>) -> Self {
        Self::failed(KIND_NOT_INSTALLED, repo, "未安装 gh CLI（找不到 gh 命令）")
    }
}

/// Result of a write action (comment / open / close / merge / create).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueActionResult {
    pub kind: &'static str,
    pub repo: String,
    /// The new item's number when creating an issue; otherwise the number of the
    /// item acted on.
    pub number: u64,
    pub error: Option<String>,
}

impl IssueActionResult {
    pub fn ok(repo: impl Into<String>, number: u64) -> Self {
        Self {
            kind: KIND_READY,
            repo: repo.into(),
            number,
            error: None,
        }
    }

    pub fn failed(
        kind: &'static str,
        repo: impl Into<String>,
        number: u64,
        error: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            repo: repo.into(),
            number,
            error: Some(or_no_detail(error.into())),
        }
    }

    pub fn not_installed(repo: impl Into<String>, number: u64) -> Self {
        Self::failed(
            KIND_NOT_INSTALLED,
            repo,
            number,
            "未安装 gh CLI（找不到 gh 命令）",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ci_payload_never_carries_a_blank_error_or_a_blank_repo() {
        let payload = RepoCiPayload::failed(KIND_ERROR, "a/b", "   ");
        assert_eq!(payload.kind, KIND_ERROR);
        assert_eq!(payload.repo, "a/b");
        assert_eq!(payload.error.as_deref(), Some(NO_DETAIL));
        assert!(payload.run.is_none());
    }

    #[test]
    fn an_empty_ci_answer_is_not_an_error() {
        let payload = RepoCiPayload::empty("a/b");
        assert_eq!(payload.kind, KIND_NONE);
        assert!(payload.run.is_none());
        assert!(payload.error.is_none());
    }

    #[test]
    fn failed_payload_never_carries_a_blank_error() {
        let payload = RemoteReposPayload::failed(KIND_ERROR, "  ");
        assert_eq!(payload.kind, KIND_ERROR);
        assert!(payload.repos.is_empty());
        assert_eq!(payload.error.as_deref(), Some(NO_DETAIL));

        let payload = RemoteReposPayload::not_installed();
        assert_eq!(payload.kind, KIND_NOT_INSTALLED);
        assert!(payload.login.is_none());
        assert!(payload.error.is_some());
    }

    #[test]
    fn ready_payload_keeps_an_empty_list_distinct_from_failure() {
        let payload = RemoteReposPayload::ready("Zomcxj".into(), None, Vec::new(), false);
        assert_eq!(payload.kind, KIND_READY);
        assert_eq!(payload.login.as_deref(), Some("Zomcxj"));
        assert!(payload.error.is_none());
        assert!(payload.repos.is_empty());
    }
}
