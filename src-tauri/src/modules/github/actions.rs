//! 运行列表与重跑/取消要用的纯逻辑。
//!
//! 列表读 `repos/{owner}/{repo}/actions/runs?per_page=N`：GitHub 按更新时间倒序返回，
//! 所以要「最近 N 条」直接截前 N 条就行。起进程在 `commands.rs`，这里只做能单测的部分。

use serde::Deserialize;

use super::types::RepoActionRun;

/// 默认取多少条运行记录。界面只展示最近这些，再多也没人往下翻。
pub const DEFAULT_RUNS: usize = 20;
/// 一次最多取多少条：够看最近的，又不至于把一屏塞满。
pub const MAX_RUNS: usize = 50;

/// 把界面递来的条数夹到合理范围。
pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_RUNS).clamp(1, MAX_RUNS)
}

/// GitHub 返回的一条运行记录。这些字段都可能缺，缺了由 `convert` 定规则。
#[derive(Debug, Deserialize)]
struct RawRun {
    id: Option<u64>,
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    run_number: Option<u64>,
    head_branch: Option<String>,
    event: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    html_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Body {
    workflow_runs: Vec<RawRun>,
}

/// 非空字符串才算有值；GitHub 偶尔给空串，空串当没有。
fn clean(value: Option<String>) -> Option<String> {
    let text = value?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// 一条原始记录能不能用。
///
/// 没 id 就没法重跑/取消，没 url 就点不开，没 status 就画不出状态 —— 这三样缺任何一样
/// 这条就展示不了，丢掉；其余字段缺了按空处理（`name` 给中性兜底，不留空字符串）。
fn convert(raw: RawRun) -> Option<RepoActionRun> {
    Some(RepoActionRun {
        id: raw.id?,
        name: clean(raw.name).unwrap_or_else(|| "workflow".to_string()),
        status: clean(raw.status)?,
        conclusion: clean(raw.conclusion),
        run_number: raw.run_number.unwrap_or_default(),
        head_branch: clean(raw.head_branch),
        event: clean(raw.event),
        created_at: clean(raw.created_at),
        updated_at: clean(raw.updated_at),
        url: clean(raw.html_url)?,
    })
}

/// 解析运行列表，最多返回 `limit` 条。
///
/// 逐条容错（与仓库列表同一个口径）：单条缺必要字段就丢掉那一条，不影响整页；但**要是
/// 返回里本来有条目、最后一条都没留下**，那就是解析出了问题，如实报错，不能报成「没有
/// 运行记录」——那正是「不静默失败」要挡住的东西。
pub fn parse_runs(json: &str, limit: usize) -> Result<Vec<RepoActionRun>, String> {
    let body: Body = serde_json::from_str(json).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let total = body.workflow_runs.len();
    let runs: Vec<RepoActionRun> = body
        .workflow_runs
        .into_iter()
        .filter_map(convert)
        .take(limit)
        .collect();

    if runs.is_empty() && total > 0 {
        return Err(format!("返回的 {total} 条运行记录都缺少必要字段"));
    }
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_RUNS: &str = r#"{
        "total_count": 42,
        "workflow_runs": [
            {
                "id": 9001,
                "name": "CI",
                "status": "completed",
                "conclusion": "failure",
                "run_number": 48,
                "head_branch": "main",
                "event": "push",
                "created_at": "2026-10-20T11:00:00Z",
                "updated_at": "2026-10-20T11:04:00Z",
                "html_url": "https://github.com/a/b/actions/runs/9001"
            },
            {
                "id": 9000,
                "name": "Release",
                "status": "in_progress",
                "conclusion": null,
                "run_number": 47,
                "head_branch": "release/1.2",
                "event": "workflow_dispatch",
                "created_at": "2026-10-20T10:00:00Z",
                "updated_at": "2026-10-20T10:00:30Z",
                "html_url": "https://github.com/a/b/actions/runs/9000"
            }
        ]
    }"#;

    #[test]
    fn parses_the_list_in_the_order_github_gave_it() {
        let runs = parse_runs(TWO_RUNS, DEFAULT_RUNS).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].id, 9001);
        assert_eq!(runs[0].name, "CI");
        assert_eq!(runs[0].conclusion.as_deref(), Some("failure"));
        assert_eq!(runs[0].event.as_deref(), Some("push"));
        assert_eq!(runs[0].run_number, 48);
        // 第二条还没跑完：conclusion 是空的，状态照旧带出来。
        assert_eq!(runs[1].status, "in_progress");
        assert_eq!(runs[1].conclusion, None);
        assert_eq!(runs[1].head_branch.as_deref(), Some("release/1.2"));
    }

    #[test]
    fn an_empty_list_is_an_empty_list() {
        assert!(parse_runs(r#"{"workflow_runs": []}"#, DEFAULT_RUNS)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn one_unusable_entry_does_not_take_the_page_down() {
        // 第一条缺 html_url（点不开），第二条正常：只有第二条留下。
        let json = r#"{"workflow_runs": [
            {"id": 1, "status": "completed", "name": "CI"},
            {"id": 2, "status": "completed", "html_url": "u2"}
        ]}"#;
        let runs = parse_runs(json, DEFAULT_RUNS).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, 2);
        // 缺 name 的给中性兜底，不留空串。
        assert_eq!(runs[0].name, "workflow");
    }

    #[test]
    fn a_page_that_loses_every_entry_is_an_error_not_an_empty_list() {
        // 有条目、却一条都用不了：这是解析问题，不是「没有 CI」。
        let json = r#"{"workflow_runs": [{"name": "CI"}, {"name": "CI"}]}"#;
        let error = parse_runs(json, DEFAULT_RUNS).unwrap_err();
        assert!(error.contains("2 条"), "{error}");
    }

    #[test]
    fn malformed_output_is_reported_not_guessed() {
        assert!(parse_runs("not json", DEFAULT_RUNS)
            .unwrap_err()
            .contains("JSON"));
        assert!(parse_runs("{}", DEFAULT_RUNS).unwrap_err().contains("JSON"));
    }

    #[test]
    fn the_limit_truncates_after_dropping_unusable_entries() {
        let runs = parse_runs(TWO_RUNS, 1).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, 9001);
    }

    #[test]
    fn the_limit_is_clamped_to_something_sane() {
        assert_eq!(clamp_limit(None), DEFAULT_RUNS);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(5)), 5);
        assert_eq!(clamp_limit(Some(9999)), MAX_RUNS);
    }
}
