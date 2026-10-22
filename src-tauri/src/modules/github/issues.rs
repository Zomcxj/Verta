//! issue / PR 的纯逻辑：把 gh 的 JSON 翻成 wire 结构，并做参数预检。
//!
//! 取数与编排在 `commands.rs`，这里只放能被单测覆盖的判断。
//!
//! 一个 GitHub 事实上的细节：`issues` 端点**同时返回 issue 和 PR**，PR 多带一个
//! `pull_request` 对象。列表因此一次就能拿全两类，靠这个字段区分。

use serde::Deserialize;

use super::types::{CheckSummary, IssueComment, IssueDetail, IssueSummary, PullRequestInfo};

/// 列表一次要几条。上限与运行列表同一档。
pub const ISSUES_MAX_LIMIT: usize = 100;
/// 列表默认条数。
pub const ISSUES_DEFAULT_LIMIT: usize = 50;

// ------------------------------------------------------------ gh 的原始形状

#[derive(Deserialize)]
struct RawUser {
    login: Option<String>,
}

#[derive(Deserialize)]
struct RawLabel {
    name: Option<String>,
}

/// issue 端点里 PR 额外带的那一小块。
///
/// 只有 `merged_at` 有用：它非空就说明这个 PR 已经合进基线了。
/// `draft` 不在这里（那是 PR 详情才有的字段），所以列表里判不出草稿。
#[derive(Deserialize)]
struct RawPullRef {
    merged_at: Option<String>,
}

#[derive(Deserialize)]
struct RawIssue {
    number: Option<u64>,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    user: Option<RawUser>,
    created_at: Option<String>,
    updated_at: Option<String>,
    comments: Option<u32>,
    labels: Option<Vec<RawLabel>>,
    assignees: Option<Vec<RawUser>>,
    html_url: Option<String>,
    locked: Option<bool>,
    pull_request: Option<RawPullRef>,
}

#[derive(Deserialize)]
struct RawRef {
    r#ref: Option<String>,
    sha: Option<String>,
}

#[derive(Deserialize)]
struct RawPull {
    state: Option<String>,
    draft: Option<bool>,
    merged: Option<bool>,
    mergeable: Option<bool>,
    mergeable_state: Option<String>,
    user: Option<RawUser>,
    created_at: Option<String>,
    updated_at: Option<String>,
    labels: Option<Vec<RawLabel>>,
    assignees: Option<Vec<RawUser>>,
    html_url: Option<String>,
    locked: Option<bool>,
    head: Option<RawRef>,
    base: Option<RawRef>,
    additions: Option<u32>,
    deletions: Option<u32>,
    changed_files: Option<u32>,
    commits: Option<u32>,
}

#[derive(Deserialize)]
struct RawComment {
    id: Option<u64>,
    body: Option<String>,
    user: Option<RawUser>,
    created_at: Option<String>,
}

#[derive(Deserialize)]
struct RawCheck {
    status: Option<String>,
    conclusion: Option<String>,
}

#[derive(Deserialize)]
struct RawMerge {
    merged: Option<bool>,
    message: Option<String>,
}

#[derive(Deserialize)]
struct RawCheckRuns {
    total_count: Option<u32>,
    check_runs: Option<Vec<RawCheck>>,
}

// ------------------------------------------------------------ 解析

/// 解析 `repos/{slug}/issues` 的响应体。
///
/// 逐条容错：缺 `number` 的条目直接丢掉，不影响整页；正文 / 标签 / 指派人缺省当空。
pub fn parse_issue_list(json: &str) -> Result<Vec<IssueSummary>, serde_json::Error> {
    let raw: Vec<RawIssue> = serde_json::from_str(json)?;
    Ok(raw.into_iter().filter_map(convert_issue).collect())
}

/// 解析单条 issue（详情用）。
///
/// 详情比列表多两块：评论列表，以及留给 PR 专属信息 / 检查状态的空位
/// （那两块要在拿到 PR 信息之后才填）。
pub fn parse_issue(json: &str) -> Result<IssueDetail, serde_json::Error> {
    let raw: RawIssue = serde_json::from_str(json)?;
    Ok(convert_detail(raw))
}

fn convert_detail(raw: RawIssue) -> IssueDetail {
    let is_pull_request = raw.pull_request.is_some();
    let merged = raw
        .pull_request
        .as_ref()
        .and_then(|pr| pr.merged_at.as_ref())
        .is_some_and(|at| !at.is_empty());
    IssueDetail {
        number: raw.number.unwrap_or(0),
        title: raw.title.unwrap_or_default(),
        body: raw.body.unwrap_or_default(),
        state: raw.state.unwrap_or_else(|| "open".to_string()),
        is_pull_request,
        is_draft: false,
        merged,
        author: raw
            .user
            .and_then(|user| user.login)
            .unwrap_or_default(),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        labels: names(raw.labels),
        assignees: logins(raw.assignees),
        html_url: raw.html_url.unwrap_or_default(),
        locked: raw.locked.unwrap_or(false),
        comments: Vec::new(),
        comments_error: None,
        pull_request: None,
        pull_request_error: None,
        checks: None,
    }
}

fn convert_issue(raw: RawIssue) -> Option<IssueSummary> {
    let number = raw.number?;
    let is_pull_request = raw.pull_request.is_some();
    let merged = raw
        .pull_request
        .as_ref()
        .and_then(|pr| pr.merged_at.as_ref())
        .is_some_and(|at| !at.is_empty());
    Some(IssueSummary {
        number,
        title: raw.title.unwrap_or_default(),
        body: raw.body.unwrap_or_default(),
        state: raw.state.unwrap_or_else(|| "open".to_string()),
        is_pull_request,
        // 草稿只有 PR 详情里有；列表端点给不出，如实当不是草稿。
        is_draft: false,
        merged,
        author: raw
            .user
            .and_then(|user| user.login)
            .unwrap_or_default(),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        comments: raw.comments.unwrap_or(0),
        labels: names(raw.labels),
        assignees: logins(raw.assignees),
        html_url: raw.html_url.unwrap_or_default(),
        locked: raw.locked.unwrap_or(false),
    })
}

/// 解析 `repos/{slug}/issues/{n}/comments`。
pub fn parse_comments(json: &str) -> Result<Vec<IssueComment>, serde_json::Error> {
    let raw: Vec<RawComment> = serde_json::from_str(json)?;
    Ok(raw
        .into_iter()
        .filter_map(|comment| {
            Some(IssueComment {
                id: comment.id?,
                author: comment
                    .user
                    .and_then(|user| user.login)
                    .unwrap_or_default(),
                body: comment.body.unwrap_or_default(),
                created_at: comment.created_at,
            })
        })
        .collect())
}

/// 解析 `repos/{slug}/pulls/{n}`。
pub fn parse_pull_request(json: &str) -> Result<PullRequestInfo, serde_json::Error> {
    let raw: RawPull = serde_json::from_str(json)?;
    let mut pr = PullRequestInfo {
        head: raw
            .head
            .as_ref()
            .and_then(|head| head.r#ref.clone())
            .unwrap_or_default(),
        head_sha: raw
            .head
            .as_ref()
            .and_then(|head| head.sha.clone())
            .unwrap_or_default(),
        base: raw
            .base
            .as_ref()
            .and_then(|base| base.r#ref.clone())
            .unwrap_or_default(),
        draft: raw.draft.unwrap_or(false),
        merged: raw.merged.unwrap_or(false),
        // mergeable 是 Option：GitHub 异步算，刚开的 PR 这一栏是 null，
        // 意思是「还不知道」，不是「不能合」。
        mergeable: raw.mergeable,
        mergeable_state: raw.mergeable_state.unwrap_or_default(),
        merge_blocked: None,
        additions: raw.additions.unwrap_or(0),
        deletions: raw.deletions.unwrap_or(0),
        changed_files: raw.changed_files.unwrap_or(0),
        commits: raw.commits.unwrap_or(0),
        state: raw.state.unwrap_or_else(|| "open".to_string()),
        author: raw
            .user
            .and_then(|user| user.login)
            .unwrap_or_default(),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
        labels: names(raw.labels),
        assignees: logins(raw.assignees),
        html_url: raw.html_url.unwrap_or_default(),
        locked: raw.locked.unwrap_or(false),
    };
    pr.merge_blocked = merge_block_code(&pr).map(str::to_string);
    Ok(pr)
}

/// `check-runs` 一页多少条（GitHub 上限）。
pub const CHECKS_PER_PAGE: u32 = 100;
/// 最多翻多少页。100 × 10 = 1000 条检查，已经远超真实仓库。
pub const CHECKS_MAX_PAGES: u32 = 10;

/// 某一页 `check-runs` 的路径（`{slug}` 由调用方替换）。
pub fn checks_page_path(sha: &str, page: u32) -> String {
    format!("repos/{{slug}}/commits/{sha}/check-runs?per_page={CHECKS_PER_PAGE}&page={page}")
}

/// 把各页的 `check-runs` 原始 JSON 合起来数一遍。
///
/// 一个仓库的检查超过 100 条时得一页页取，但**计数与状态只该在合起来之后算一次**：
/// 每页各自算再相加会丢掉「还有没取到的」这个事实。`total` 取各页里最大的 `total_count`，
/// 拿到的条数仍然少于它就算 `truncated` —— 跟只取一页时是同一条规则。
pub fn summarize_check_pages(pages: &[String]) -> Result<CheckSummary, serde_json::Error> {
    let mut total = 0u32;
    let mut seen = 0u32;
    let mut ok = 0;
    let mut failed = 0;
    let mut pending = 0;
    for json in pages {
        let raw: RawCheckRuns = serde_json::from_str(json)?;
        let runs = raw.check_runs.unwrap_or_default();
        seen += runs.len() as u32;
        total = total.max(raw.total_count.unwrap_or(runs.len() as u32));
        for run in &runs {
            match check_outcome(run) {
                Outcome::Success => ok += 1,
                Outcome::Failure => failed += 1,
                Outcome::Pending => pending += 1,
            }
        }
    }
    let truncated = seen < total;
    Ok(CheckSummary {
        total,
        ok,
        failed,
        pending,
        truncated,
        state: check_state(total, failed, pending, truncated),
    })
}

/// 这一页是否说明「检查还没取完」：满页就继续，不满页或到了页数上限就停。
pub fn checks_have_more(page_rows: usize, page: u32) -> bool {
    page_rows >= CHECKS_PER_PAGE as usize && page < CHECKS_MAX_PAGES
}

/// 一页 `check-runs` 里有几条（解不开就是 None，调用方据此当作没有下一页）。
pub fn count_check_runs(json: &str) -> Option<usize> {
    let raw: RawCheckRuns = serde_json::from_str(json).ok()?;
    Some(raw.check_runs.unwrap_or_default().len())
}

enum Outcome {
    Success,
    Failure,
    Pending,
}

fn check_outcome(run: &RawCheck) -> Outcome {
    let status = run.status.as_deref().unwrap_or("");
    // 还在排队 / 在跑：结论还没出来，一律算「进行中」。
    if matches!(status, "queued" | "in_progress" | "waiting" | "requested" | "pending") {
        return Outcome::Pending;
    }
    match run.conclusion.as_deref().unwrap_or("") {
        "success" | "neutral" | "skipped" => Outcome::Success,
        "failure" | "cancelled" | "timed_out" | "action_required" | "stale" | "startup_failure" => {
            Outcome::Failure
        }
        // 结论缺失但状态是 completed：说不好算什么，如实当「进行中」。
        _ => Outcome::Pending,
    }
}

/// 整体检查状态：先看失败，再看进行中，最后才敢说通过。
///
/// 一个失败就盖过其它：整体是「红」的，不能因为还有几个在跑就说「进行中」。
///
/// `truncated`（只看到了一部分检查）时**绝不能**报 `pass` —— 没看到的那几条可能正红着，
/// 报「全部通过」就是在骗人。被看到的那部分全绿时改报 `partial`，让界面如实说「只统计到前 N 项」。
pub fn check_state(
    total: u32,
    failed: u32,
    pending: u32,
    truncated: bool,
) -> &'static str {
    if total == 0 {
        "none"
    } else if failed > 0 {
        "fail"
    } else if pending > 0 {
        "pending"
    } else if truncated {
        "partial"
    } else {
        "pass"
    }
}

/// 合并按钮现在该不该禁着，以及禁的**原因码**。
///
/// 返回 `None` 表示可以合。GitHub 算 mergeable 是异步的，刚开的 PR 会返回
/// `mergeable: null` / `mergeable_state: "unknown"` —— 这时**不能**当成「不能合」
/// （那是「还不知道」），但也不能放行，得等它算完。
///
/// 给码不给句子：这句话是要显示给用户的，得跟着界面语言走，所以文案由界面按码取。
/// 码是 `merged` / `closed` / `draft` / `conflict` / `computing` / `unknown`。
pub fn merge_block_code(pr: &PullRequestInfo) -> Option<&'static str> {
    if pr.merged {
        return Some("merged");
    }
    if pr.state != "open" {
        return Some("closed");
    }
    if pr.draft {
        return Some("draft");
    }
    match pr.mergeable {
        Some(true) => None,
        Some(false) => Some("conflict"),
        None => {
            if pr.mergeable_state == "unknown" || pr.mergeable_state.is_empty() {
                Some("computing")
            } else {
                Some("unknown")
            }
        }
    }
}

/// 解析合并 PR 的响应体。
///
/// GitHub 有个坑：合并**没成功**时也可能返回 200，body 里是
/// `{"merged": false, "message": "..."}`。只看退出码会把「没合」当成「合了」，
/// 所以这里看 body 里的 `merged`。
pub fn parse_merge_result(json: &str) -> Result<(), String> {
    let raw: RawMerge = serde_json::from_str(json)
        .map_err(|error| format!("gh 返回的合并结果无法解析：{error}"))?;
    if raw.merged.unwrap_or(false) {
        return Ok(());
    }
    let message = raw
        .message
        .unwrap_or_else(|| "GitHub 没有说为什么没合上".to_string());
    Err(message)
}

// ------------------------------------------------------------ 参数预检

/// 编号不合法时的说明。0 只可能是界面传错了。
pub fn number_problem(number: u64) -> Option<String> {
    if number == 0 {
        Some("编号不合法：0".to_string())
    } else {
        None
    }
}

/// 标题不合法时的说明。
pub fn title_problem(title: &str) -> Option<String> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        Some("标题不能为空".to_string())
    } else if trimmed.chars().count() > 256 {
        Some("标题太长了（GitHub 最多 256 个字符）".to_string())
    } else {
        None
    }
}

/// 评论正文不合法时的说明。
pub fn body_problem(body: &str) -> Option<String> {
    if body.trim().is_empty() {
        Some("内容不能为空".to_string())
    } else if body.chars().count() > 65536 {
        Some("内容太长了（GitHub 最多 65536 个字符）".to_string())
    } else {
        None
    }
}

/// 合并方式不合法时的说明。
pub fn merge_method_problem(method: &str) -> Option<String> {
    match method {
        "merge" | "squash" | "rebase" => None,
        other => Some(format!("未知的合并方式：{other}")),
    }
}

/// 合并时要带上的 head sha 不合法时的说明。
///
/// 空串是允许的（详情没读到 / 老版本调用方）：那样就不带这道保险，照常合并。
/// 但一旦给了值，它必须是 40 位十六进制 —— 拿个别的字符串去请求，GitHub 只会回一句
/// 很难看懂的错，不如在本地就说清。
pub fn head_sha_problem(sha: &str) -> Option<String> {
    let sha = sha.trim();
    if sha.is_empty() {
        return None;
    }
    let hex = sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit());
    if hex {
        None
    } else {
        Some(format!("PR 的 head sha 看起来不对：{sha}"))
    }
}

/// 把逗号 / 空格分隔的标签串拆开，并去掉空项与前导 `#`。
pub fn parse_labels(raw: &str) -> Vec<String> {
    raw.split([',', ' ', '\t', '\n'])
        .map(|label| label.trim().trim_start_matches('#'))
        .filter(|label| !label.is_empty())
        .map(|label| label.to_string())
        .collect()
}

/// 列表状态参数不合法时的说明。
pub fn state_problem(state: &str) -> Option<String> {
    match state {
        "open" | "closed" | "all" => None,
        other => Some(format!("未知的筛选状态：{other}")),
    }
}

/// 列表条数夹到合法范围。
pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(ISSUES_DEFAULT_LIMIT)
        .clamp(1, ISSUES_MAX_LIMIT)
}

// ------------------------------------------------------------ 小工具

fn names(labels: Option<Vec<RawLabel>>) -> Vec<String> {
    labels
        .unwrap_or_default()
        .into_iter()
        .filter_map(|label| label.name)
        .filter(|name| !name.is_empty())
        .collect()
}

fn logins(users: Option<Vec<RawUser>>) -> Vec<String> {
    users
        .unwrap_or_default()
        .into_iter()
        .filter_map(|user| user.login)
        .filter(|login| !login.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUCCESS_RUN: &str = r#"{"status": "completed", "conclusion": "success"}"#;
    const FAILURE_RUN: &str = r#"{"status": "completed", "conclusion": "failure"}"#;

    #[test]
    fn a_list_holds_both_issues_and_pull_requests() {
        let json = r#"[
            {"number": 3, "title": "普通 issue", "state": "open", "user": {"login": "ann"},
             "comments": 2, "labels": [{"name": "bug"}], "assignees": [{"login": "bo"}],
             "created_at": "2026-10-01T00:00:00Z", "html_url": "https://github.com/o/r/issues/3"},
            {"number": 4, "title": "一个 PR", "state": "open", "user": {"login": "cid"},
             "pull_request": {"merged_at": null}, "comments": 0}
        ]"#;
        let rows = parse_issue_list(json).expect("应能解析");
        assert_eq!(rows.len(), 2);
        assert!(!rows[0].is_pull_request, "普通 issue 不该被当成 PR");
        assert!(rows[1].is_pull_request, "带 pull_request 的就是 PR");
        assert_eq!(rows[0].labels, vec!["bug".to_string()]);
        assert_eq!(rows[0].assignees, vec!["bo".to_string()]);
        assert_eq!(rows[0].author, "ann");
        assert_eq!(rows[0].comments, 2);
    }

    #[test]
    fn a_merged_pull_request_is_marked_merged() {
        let json = r#"[{"number": 9, "title": "PR", "state": "closed",
                       "pull_request": {"merged_at": "2026-10-02T00:00:00Z"}}]"#;
        let rows = parse_issue_list(json).expect("应能解析");
        assert!(rows[0].merged, "merged_at 非空就是合过了");
        assert!(rows[0].is_pull_request);
    }

    #[test]
    fn a_broken_entry_does_not_take_the_whole_list_down() {
        // 缺 number 的条目丢掉，其余照常。
        let json = r#"[{"title": "没有编号"}, {"number": 5, "title": "好的"}]"#;
        let rows = parse_issue_list(json).expect("应能解析");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].number, 5);
    }

    #[test]
    fn comments_keep_their_author_and_body() {
        let json = r#"[{"id": 11, "body": "看着不错", "user": {"login": "dan"},
                       "created_at": "2026-10-03T00:00:00Z"}]"#;
        let comments = parse_comments(json).expect("应能解析");
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, 11);
        assert_eq!(comments[0].author, "dan");
        assert_eq!(comments[0].body, "看着不错");
    }

    #[test]
    fn a_pull_request_keeps_its_branches_and_size() {
        let json = r#"{"number": 7, "state": "open", "draft": false, "merged": false,
            "mergeable": true, "mergeable_state": "clean",
            "head": {"ref": "feature/x", "sha": "abc123"},
            "base": {"ref": "main", "sha": "def456"},
            "additions": 12, "deletions": 3, "changed_files": 2, "commits": 1}"#;
        let pr = parse_pull_request(json).expect("应能解析");
        assert_eq!(pr.head, "feature/x");
        assert_eq!(pr.head_sha, "abc123");
        assert_eq!(pr.base, "main");
        assert_eq!(pr.additions, 12);
        assert_eq!(pr.deletions, 3);
        assert_eq!(pr.changed_files, 2);
        assert_eq!(pr.mergeable, Some(true));
        assert!(merge_block_code(&pr).is_none(), "能合的不该被拦");
        // 「能不能合」要随 wire 一起送出去：界面只照着禁按钮。
        assert!(pr.merge_blocked.is_none());
    }

    #[test]
    fn an_unknown_mergeable_blocks_the_merge_without_saying_it_cannot_merge() {
        // GitHub 刚建 PR 时 mergeable 是 null：这是「还不知道」，不是「合不了」。
        let json = r#"{"number": 8, "state": "open", "mergeable": null,
            "mergeable_state": "unknown", "head": {"ref": "f"}, "base": {"ref": "main"}}"#;
        let pr = parse_pull_request(json).expect("应能解析");
        let code = merge_block_code(&pr).expect("这时该拦着");
        assert_eq!(code, "computing", "「还不知道」与「合不了」不是一回事");
    }

    #[test]
    fn a_conflicted_pull_request_cannot_be_merged() {
        let json = r#"{"number": 8, "state": "open", "mergeable": false,
            "mergeable_state": "dirty", "head": {"ref": "f"}, "base": {"ref": "main"}}"#;
        let pr = parse_pull_request(json).expect("应能解析");
        let code = merge_block_code(&pr).expect("该拦着");
        assert_eq!(code, "conflict");
    }

    #[test]
    fn a_draft_or_closed_pull_request_cannot_be_merged() {
        let draft = parse_pull_request(
            r#"{"number": 1, "state": "open", "draft": true, "mergeable": true,
                "head": {"ref": "f"}, "base": {"ref": "main"}}"#,
        )
        .expect("应能解析");
        assert_eq!(merge_block_code(&draft).unwrap(), "draft");

        let closed = parse_pull_request(
            r#"{"number": 2, "state": "closed", "mergeable": true,
                "head": {"ref": "f"}, "base": {"ref": "main"}}"#,
        )
        .expect("应能解析");
        assert_eq!(merge_block_code(&closed).unwrap(), "closed");

        let merged = parse_pull_request(
            r#"{"number": 3, "state": "closed", "merged": true, "mergeable": true,
                "head": {"ref": "f"}, "base": {"ref": "main"}}"#,
        )
        .expect("应能解析");
        assert_eq!(merge_block_code(&merged).unwrap(), "merged");
    }

    #[test]
    fn a_failed_check_beats_a_pending_one() {
        assert_eq!(check_state(0, 0, 0, false), "none");
        assert_eq!(check_state(3, 0, 0, false), "pass");
        assert_eq!(check_state(3, 0, 1, false), "pending");
        // 一个失败就盖过还在跑的：整体是红的。
        assert_eq!(check_state(3, 1, 1, false), "fail");
        // 只看到一部分时不许报通过：没看到的那几条可能正红着。
        assert_eq!(check_state(140, 0, 0, true), "partial");
        // 但看到的那些里已经有失败 / 还在跑，照旧如实报。
        assert_eq!(check_state(140, 1, 0, true), "fail");
        assert_eq!(check_state(140, 0, 2, true), "pending");
    }

    #[test]
    fn check_runs_are_counted_by_outcome() {
        let json = r#"{"total_count": 3, "check_runs": [
            {"status": "completed", "conclusion": "success"},
            {"status": "completed", "conclusion": "failure"},
            {"status": "in_progress", "conclusion": null}
        ]}"#;
        let checks = summarize_check_pages(&[json.to_string()]).expect("应能解析");
        assert_eq!(checks.total, 3);
        assert_eq!(checks.ok, 1);
        assert_eq!(checks.failed, 1);
        assert_eq!(checks.pending, 1);
        assert!(!checks.truncated, "三条都在，没少看");
        assert_eq!(checks.state, "fail");
    }

    #[test]
    fn a_truncated_check_page_never_reports_a_pass() {
        // GitHub 一页最多 100 条：拿到 2 条而总数 140 时，整体只能是 partial ——
        // 报「140 项检查全部通过」等于把没看到的 138 项当成绿的。
        let json = r#"{"total_count": 140, "check_runs": [
            {"status": "completed", "conclusion": "success"},
            {"status": "completed", "conclusion": "success"}]}"#;
        let checks = summarize_check_pages(&[json.to_string()]).expect("应能解析");
        assert_eq!(checks.total, 140);
        assert_eq!(checks.ok, 2);
        assert!(checks.truncated, "只看到 2 条，140 条没看完");
        assert_eq!(checks.state, "partial");
    }

    #[test]
    fn paging_every_checked_run_can_end_in_a_pass_again() {
        // 140 条检查分成两页取全了：这时才敢说「全部通过」。
        let first = format!(
            r#"{{"total_count": 4, "check_runs": [{}, {}]}}"#,
            SUCCESS_RUN, SUCCESS_RUN
        );
        let second = format!(
            r#"{{"total_count": 4, "check_runs": [{}, {}]}}"#,
            SUCCESS_RUN, SUCCESS_RUN
        );
        let checks =
            summarize_check_pages(&[first, second]).expect("应能解析");
        assert_eq!(checks.total, 4);
        assert_eq!((checks.ok, checks.failed), (4, 0));
        assert!(!checks.truncated);
        assert_eq!(checks.state, "pass", "全取到并且全绿才报通过");
    }

    #[test]
    fn a_failure_on_a_later_page_is_not_filed_away() {
        let first = format!(
            r#"{{"total_count": 4, "check_runs": [{}, {}]}}"#,
            SUCCESS_RUN, SUCCESS_RUN
        );
        let second = format!(
            r#"{{"total_count": 4, "check_runs": [{}, {}]}}"#,
            SUCCESS_RUN, FAILURE_RUN
        );
        let checks = summarize_check_pages(&[first, second]).expect("应能解析");
        assert_eq!((checks.ok, checks.failed), (3, 1));
        assert_eq!(checks.state, "fail", "看到失败就报失败");
    }

    #[test]
    fn a_second_page_that_never_arrived_still_says_partial() {
        // 只拿到了第一页：哪怕这一页全绿也不能说通。
        let first = format!(
            r#"{{"total_count": 140, "check_runs": [{}, {}]}}"#,
            SUCCESS_RUN, SUCCESS_RUN
        );
        let checks = summarize_check_pages(&[first]).expect("应能解析");
        assert!(checks.truncated);
        assert_eq!(checks.state, "partial");
    }

    #[test]
    fn paging_stops_on_a_short_page_or_at_the_cap() {
        assert!(checks_have_more(100, 1));
        assert!(!checks_have_more(99, 1));
        assert!(!checks_have_more(100, CHECKS_MAX_PAGES));
        assert_eq!(count_check_runs(r#"{"check_runs":[{},{}]}"#), Some(2));
        assert_eq!(count_check_runs("not json"), None);
        assert!(checks_page_path("abc", 2).contains("per_page=100&page=2"));
    }

    #[test]
    fn arguments_are_checked_before_spending_a_request() {
        assert!(number_problem(0).is_some());
        assert!(number_problem(7).is_none());
        assert!(title_problem("   ").is_some());
        assert!(title_problem("好好好").is_none());
        assert!(body_problem("\n\t ").is_some());
        assert!(body_problem("有内容").is_none());
        assert!(merge_method_problem("squash").is_none());
        assert!(merge_method_problem("rebase").is_none());
        assert!(merge_method_problem("nope").is_some());
        assert!(state_problem("all").is_none());
        assert!(state_problem("weird").is_some());
    }

    #[test]
    fn a_merge_guard_sha_must_be_a_real_sha_but_may_be_missing() {
        assert!(head_sha_problem("").is_none());
        assert!(head_sha_problem("   ").is_none());
        assert!(head_sha_problem("abc123").is_some());
        let sha = "0123456789abcdef0123456789abcdef01234567";
        assert!(head_sha_problem(sha).is_none());
        assert!(head_sha_problem(&format!(" {sha} ")).is_none());
        assert!(head_sha_problem(&sha.replace('a', "g")).is_some());
        assert!(head_sha_problem(&format!("{sha}00")).is_some());
    }

    #[test]
    fn labels_are_split_and_cleaned() {
        assert_eq!(parse_labels("bug, ux #help\twindows"), vec![
            "bug".to_string(),
            "ux".to_string(),
            "help".to_string(),
            "windows".to_string()
        ]);
        assert!(parse_labels("  ,  ").is_empty());
    }

    #[test]
    fn a_merge_that_did_not_happen_is_not_a_success() {
        // GitHub 会用 200 + merged:false 回答一次没合上的合并：只看退出码会误报成功。
        assert!(parse_merge_result(r#"{"merged": true, "sha": "abc"}"#).is_ok());
        let failed = parse_merge_result(
            r#"{"merged": false, "message": "Pull Request is not mergeable"}"#,
        )
        .expect_err("没合上就该是失败");
        assert!(failed.contains("not mergeable"), "{failed}");
        // 连 body 都没有：不能当成成功，如实说不知道。
        assert!(parse_merge_result("").is_err());
    }

    #[test]
    fn the_limit_is_clamped_to_a_sane_range() {
        assert_eq!(clamp_limit(None), ISSUES_DEFAULT_LIMIT);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(9999)), ISSUES_MAX_LIMIT);
    }
}
