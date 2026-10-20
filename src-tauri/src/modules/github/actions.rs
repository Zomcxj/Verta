//! 运行列表、运行详情（job/step）与日志要用的纯逻辑。
//!
//! 列表读 `repos/{owner}/{repo}/actions/runs?per_page=N`：GitHub 按更新时间倒序返回，
//! 所以要「最近 N 条」直接截前 N 条就行。详情读 `.../actions/runs/{id}/jobs`（含步骤树），
//! 日志来自 `gh run view <id> --log`（每行 `job\tstep\t<时间> 正文`）。起进程在
//! `commands.rs`，这里只做能单测的部分。

use serde::Deserialize;

use super::types::{RepoActionRun, RepoRunJob, RepoRunLogLine, RepoRunStep};

/// 默认取多少条运行记录。界面只展示最近这些，再多也没人往下翻。
pub const DEFAULT_RUNS: usize = 20;
/// 一次最多取多少条：够看最近的，又不至于把一屏塞满。
pub const MAX_RUNS: usize = 50;
/// 日志最多留多少行：失败现场在结尾，所以留尾部；再多就把界面拖死了。
pub const MAX_LOG_LINES: usize = 2000;

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

/// GitHub 返回的一个 job。步骤可能为空（还没开始跑时）。
#[derive(Debug, Deserialize)]
struct RawJob {
    id: Option<u64>,
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    started_at: Option<String>,
    completed_at: Option<String>,
    html_url: Option<String>,
    runner_name: Option<String>,
    labels: Option<Vec<String>>,
    steps: Option<Vec<RawStep>>,
}

#[derive(Debug, Deserialize)]
struct RawStep {
    number: Option<u64>,
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
}

/// 一个 job 能不能展示：要有 id、名字和状态。步骤缺名字的丢掉（画不出那一行）。
fn convert_job(raw: RawJob) -> Option<RepoRunJob> {
    let steps = raw
        .steps
        .unwrap_or_default()
        .into_iter()
        .filter_map(convert_step)
        .collect();
    Some(RepoRunJob {
        id: raw.id?,
        name: clean(raw.name)?,
        status: clean(raw.status)?,
        conclusion: clean(raw.conclusion),
        started_at: clean(raw.started_at),
        completed_at: clean(raw.completed_at),
        url: clean(raw.html_url),
        runner: clean(raw.runner_name)
            .or_else(|| raw.labels.and_then(|labels| labels.into_iter().next()))
            .and_then(|value| clean(Some(value))),
        steps,
    })
}

fn convert_step(raw: RawStep) -> Option<RepoRunStep> {
    Some(RepoRunStep {
        number: raw.number.unwrap_or_default(),
        name: clean(raw.name)?,
        status: clean(raw.status).unwrap_or_else(|| "completed".to_string()),
        conclusion: clean(raw.conclusion),
    })
}

/// 解析 `repos/{owner}/{repo}/actions/runs/{id}/jobs`。
///
/// 与运行列表同一口径：单条缺必要字段就丢掉那一条，但整页都丢光时如实报错。
pub fn parse_jobs(json: &str) -> Result<Vec<RepoRunJob>, String> {
    #[derive(Deserialize)]
    struct Body {
        jobs: Vec<RawJob>,
    }
    let body: Body = serde_json::from_str(json).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let total = body.jobs.len();
    let jobs: Vec<RepoRunJob> = body.jobs.into_iter().filter_map(convert_job).collect();
    if jobs.is_empty() && total > 0 {
        return Err(format!("返回的 {total} 个 job 都缺少必要字段"));
    }
    Ok(jobs)
}

/// 解析 `gh run view --log` 的输出。
///
/// 每行是 `job\tstep\t2026-10-20T14:24:56.87Z 正文`（制表符分隔，第三段是「时间 + 空格 +
/// 正文」）。认不出来的一行也照样留着——日志里漏一行比多一行糟糕，宁可原样显示。
pub fn parse_log(text: &str) -> Vec<RepoRunLogLine> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            // 第一行开头可能带 BOM（GitHub 的日志就是这样），别让它混进时间戳里。
            let line = line.trim_start_matches('\u{feff}');
            let mut parts = line.splitn(3, '\t');
            let first = parts.next().unwrap_or_default();
            let second = parts.next();
            let third = parts.next();
            match (second, third) {
                (Some(step), Some(rest)) => {
                    // 第三段开头是时间戳，后面是正文；切不出来就整段当正文。
                    let (time, message) = split_time(rest);
                    RepoRunLogLine {
                        job: first.trim().to_string(),
                        step: step.trim().to_string(),
                        time,
                        text: message,
                    }
                }
                // 没有制表符前缀：原样留着，别丢。
                _ => RepoRunLogLine {
                    job: String::new(),
                    step: String::new(),
                    time: String::new(),
                    text: line.to_string(),
                },
            }
        })
        .collect()
}

/// `2026-10-20T14:24:56.8724283Z 正文` →（时间戳, 正文）。认不出时间就整段当正文。
fn split_time(rest: &str) -> (String, String) {
    let mut parts = rest.splitn(2, ' ');
    // 实测：GitHub 日志第一行的 BOM 坐在第三段开头（时间戳前面），得在这儿剥掉。
    let head = parts
        .next()
        .unwrap_or_default()
        .trim_start_matches('\u{feff}');
    let body = parts.next().unwrap_or_default();
    if body.is_empty() || !head.contains('T') || !head.ends_with('Z') {
        return (String::new(), rest.to_string());
    }
    (head.to_string(), body.to_string())
}

/// 只留最后 `max` 行（日志看的是结尾），返回（行, 是否裁过）。
pub fn cap_lines(lines: &[RepoRunLogLine], max: usize) -> (Vec<RepoRunLogLine>, bool) {
    if lines.len() <= max {
        return (lines.to_vec(), false);
    }
    (lines[lines.len() - max..].to_vec(), true)
}

/// 删除后回查那条运行还在不在的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunProbe {
    /// 查不到它了：删除真的生效。
    Gone,
    /// 还在。
    Present,
    /// 说不清（网络、权限、别的错）。
    Unknown,
}

/// 把一次「回查运行」的结果翻成结论。
///
/// 回查用的是 `gh api repos/{o}/{r}/actions/runs/{id}`：**成功**就说明它还在；失败时只有
/// 明确是 404 / Not Found 才算「没了」，其余（限流、代理抽风、权限）一律归「说不清」——
/// 删不掉和没删掉是两件事，不能混。
pub fn classify_run_probe(exited_ok: bool, failure_text: &str) -> RunProbe {
    if exited_ok {
        return RunProbe::Present;
    }
    let lower = failure_text.to_ascii_lowercase();
    if lower.contains("http 404") || lower.contains("not found") {
        RunProbe::Gone
    } else {
        RunProbe::Unknown
    }
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

    const ONE_JOB: &str = r#"{
        "total_count": 1,
        "jobs": [{
            "id": 118683439289,
            "name": "check",
            "status": "completed",
            "conclusion": "cancelled",
            "started_at": "2026-10-20T14:24:55Z",
            "completed_at": "2026-10-20T14:26:10Z",
            "html_url": "https://github.com/a/b/actions/runs/1/job/118683439289",
            "runner_name": "GitHub Actions 1000001241",
            "labels": ["windows-latest"],
            "steps": [
                {"number": 1, "name": "Set up job", "status": "completed", "conclusion": "success"},
                {"number": 4, "name": "Clippy", "status": "completed", "conclusion": "cancelled"},
                {"number": 5, "name": "测试", "status": "completed", "conclusion": "skipped"}
            ]
        }]
    }"#;

    #[test]
    fn parses_jobs_with_their_steps() {
        let jobs = parse_jobs(ONE_JOB).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].name, "check");
        assert_eq!(jobs[0].conclusion.as_deref(), Some("cancelled"));
        assert_eq!(jobs[0].runner.as_deref(), Some("GitHub Actions 1000001241"));
        assert_eq!(jobs[0].steps.len(), 3);
        assert_eq!(jobs[0].steps[1].number, 4);
        assert_eq!(jobs[0].steps[1].conclusion.as_deref(), Some("cancelled"));
    }

    #[test]
    fn a_job_without_a_runner_name_falls_back_to_its_first_label() {
        let json = r#"{"jobs": [{"id": 1, "name": "check", "status": "queued",
            "labels": ["self-hosted", "linux"]}]}"#;
        let jobs = parse_jobs(json).unwrap();
        assert_eq!(jobs[0].runner.as_deref(), Some("self-hosted"));
        assert!(jobs[0].steps.is_empty());
        assert_eq!(jobs[0].status, "queued");
    }

    #[test]
    fn a_job_page_that_loses_every_entry_is_an_error_too() {
        let json = r#"{"jobs": [{"name": "check"}, {"name": "check"}]}"#;
        assert!(parse_jobs(json).unwrap_err().contains("2 个"));
        assert!(parse_jobs("not json").unwrap_err().contains("JSON"));
    }

    #[test]
    fn parses_the_tab_prefixed_log_lines() {
        let text = "check\tSet up job\t2026-10-20T14:24:56.8724283Z Current runner version\n\
                    check\tClippy\t2026-10-20T14:25:10.1000000Z error: could not compile\n";
        let lines = parse_log(text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].job, "check");
        assert_eq!(lines[0].step, "Set up job");
        assert_eq!(lines[0].time, "2026-10-20T14:24:56.8724283Z");
        assert_eq!(lines[0].text, "Current runner version");
        assert_eq!(lines[1].step, "Clippy");
        assert_eq!(lines[1].text, "error: could not compile");
    }

    #[test]
    fn a_log_line_without_the_prefix_is_kept_as_it_is() {
        // 认不出前缀的行照样留着：日志里漏一行比多一行糟糕。
        let lines = parse_log("plain line\n\ncheck\tstep\tno timestamp here");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].job, "");
        assert_eq!(lines[0].time, "");
        assert_eq!(lines[0].text, "plain line");
        assert_eq!(lines[1].job, "check");
        assert_eq!(lines[1].time, "");
        assert_eq!(lines[1].text, "no timestamp here");
    }

    #[test]
    fn a_leading_bom_does_not_get_into_the_timestamp() {
        // 实测：GitHub 日志第一行的 BOM 坐在「时间戳」前面（第三段开头），不是行首。
        let mut lines = parse_log(
            "check\tSet up job\t\u{feff}2026-10-20T14:24:56.8724283Z Current runner version\n",
        );
        assert_eq!(lines[0].time, "2026-10-20T14:24:56.8724283Z");
        assert_eq!(lines[0].text, "Current runner version");
        // 万一哪天 BOM 跑到行首，也别让它混进 job 名。
        lines = parse_log("\u{feff}check\tSet up job\t2026-10-20T14:24:56.8724283Z hi\n");
        assert_eq!(lines[0].job, "check");
        assert_eq!(lines[0].time, "2026-10-20T14:24:56.8724283Z");
    }

    #[test]
    fn a_run_probe_only_claims_gone_on_a_clear_not_found() {
        assert_eq!(classify_run_probe(true, ""), RunProbe::Present);
        assert_eq!(
            classify_run_probe(false, "gh: Not Found (HTTP 404)"),
            RunProbe::Gone
        );
        // 限流、代理抽风、权限不足：都是「说不清」，不能说成「已删除」。
        assert_eq!(
            classify_run_probe(false, "gh: API rate limit exceeded (HTTP 403)"),
            RunProbe::Unknown
        );
        assert_eq!(
            classify_run_probe(
                false,
                "Get \"https://api.github.com\": proxyconnect tcp: EOF"
            ),
            RunProbe::Unknown
        );
        assert_eq!(classify_run_probe(false, ""), RunProbe::Unknown);
    }

    #[test]
    fn cap_lines_keeps_the_tail_and_says_it_did() {
        let lines: Vec<RepoRunLogLine> = (0..5)
            .map(|i| RepoRunLogLine {
                job: String::new(),
                step: String::new(),
                time: String::new(),
                text: i.to_string(),
            })
            .collect();
        let (kept, clipped) = cap_lines(&lines, 2);
        assert!(clipped);
        let texts: Vec<&str> = kept.iter().map(|line| line.text.as_str()).collect();
        assert_eq!(texts, vec!["3", "4"]);
        let (all, clipped) = cap_lines(&lines, 9);
        assert!(!clipped);
        assert_eq!(all.len(), 5);
    }
}
