//! Pure logic for the run list, run details (jobs/steps) and logs.
//!
//! The list comes from `repos/{owner}/{repo}/actions/runs?per_page=N`: GitHub returns
//! newest-updated first, so "the last N" is just the first N. Details come from
//! `.../actions/runs/{id}/jobs` (with the step tree) and the log from
//! `gh run view <id> --log` (each line `job\tstep\t<time> body`). Processes are
//! spawned in `commands.rs`; only unit-testable work lives here.

use serde::Deserialize;

use super::types::{RepoActionRun, RepoRunJob, RepoRunLogLine, RepoRunStep};

/// Default number of runs. The UI only shows the most recent ones; nobody scrolls
/// further.
pub const DEFAULT_RUNS: usize = 20;
/// Maximum number of runs per fetch: enough for the recent ones without burying
/// the screen.
pub const MAX_RUNS: usize = 50;
/// Maximum log lines kept: the failure is at the end, so only the tail is kept;
/// more than this would bog the UI down.
pub const MAX_LOG_LINES: usize = 2000;

/// Clamp the requested row count to a sane range.
pub fn clamp_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_RUNS).clamp(1, MAX_RUNS)
}

/// One run as GitHub returns it. Every field may be missing; `convert` decides
/// what that means.
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

/// Only a non-empty string counts as present; GitHub sometimes sends "", which
/// counts as absent.
fn clean(value: Option<String>) -> Option<String> {
    let text = value?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Whether a raw record is usable.
///
/// Without an id it cannot be rerun/cancelled, without a url it cannot be opened,
/// without a status it cannot be drawn; miss any of the three and the row is
/// useless, so drop it. Other fields default to empty (`name` gets a neutral
/// fallback rather than "").
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

/// Parse the run list, returning at most `limit` rows.
///
/// Tolerant per entry (same rule as the repository list): an entry missing required
/// fields is dropped without affecting the page; but if **entries came back and none
/// survived**, parsing is broken and that is reported as an error, never as "no
/// runs", which is exactly what "fail loudly" is meant to prevent.
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

/// A job as GitHub returns it. Steps may be empty (before it starts).
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

/// Whether a job is displayable: it needs an id, a name and a status. Steps without
/// a name are dropped (their row cannot be drawn).
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

/// Parse `repos/{owner}/{repo}/actions/runs/{id}/jobs`.
///
/// Same rule as the run list: drop entries missing required fields, but report an
/// error when the whole page is dropped.
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

/// Parse the output of `gh run view --log`.
///
/// Each line is `job\tstep\t2026-10-20T14:24:56.87Z body` (tab separated, the third
/// field being "time + space + body"). Unrecognised lines are kept as they are: a
/// missing log line is worse than an extra one, so show them verbatim.
pub fn parse_log(text: &str) -> Vec<RepoRunLogLine> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            // The first line may start with a BOM (GitHub's logs do), so keep it out
            // of the timestamp.
            let line = line.trim_start_matches('\u{feff}');
            let mut parts = line.splitn(3, '\t');
            let first = parts.next().unwrap_or_default();
            let second = parts.next();
            let third = parts.next();
            match (second, third) {
                (Some(step), Some(rest)) => {
                    // The third field starts with the timestamp followed by the body;
                    // if it cannot be split, treat the whole field as the body.
                    let (time, message) = split_time(rest);
                    RepoRunLogLine {
                        job: first.trim().to_string(),
                        step: step.trim().to_string(),
                        time,
                        text: message,
                    }
                }
                // No tab-separated prefix: keep the line verbatim.
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

/// `2026-10-20T14:24:56.8724283Z body` → (timestamp, body). With no recognisable time
/// the whole thing is the body.
fn split_time(rest: &str) -> (String, String) {
    let mut parts = rest.splitn(2, ' ');
    // Observed: in GitHub logs the BOM of the first line sits at the start of the
    // third field (before the timestamp), so strip it here.
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

/// Keep only the last `max` lines (the end of a log is what matters); returns
/// (lines, whether anything was cut).
pub fn cap_lines(lines: &[RepoRunLogLine], max: usize) -> (Vec<RepoRunLogLine>, bool) {
    if lines.len() <= max {
        return (lines.to_vec(), false);
    }
    (lines[lines.len() - max..].to_vec(), true)
}

/// Verdict of the post-delete probe for whether the run still exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunProbe {
    /// It cannot be found: the deletion really took effect.
    Gone,
    /// Still there.
    Present,
    /// Unclear (network, permissions, some other error).
    Unknown,
}

/// Turn one probe of a run into a verdict.
///
/// The probe is `gh api repos/{o}/{r}/actions/runs/{id}`: **success** means it is still
/// there; on failure only an explicit 404 / Not Found counts as "gone", and
/// everything else (rate limit, flaky proxy, permissions) is "unclear": "could not
/// check" and "not deleted" are two different things and must not be conflated.
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
        // The second run is unfinished: conclusion is empty but the status still comes
        // through.
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
        // The first lacks html_url (cannot be opened), the second is fine: only the
        // second survives.
        let json = r#"{"workflow_runs": [
            {"id": 1, "status": "completed", "name": "CI"},
            {"id": 2, "status": "completed", "html_url": "u2"}
        ]}"#;
        let runs = parse_runs(json, DEFAULT_RUNS).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, 2);
        // A missing name gets a neutral fallback, never an empty string.
        assert_eq!(runs[0].name, "workflow");
    }

    #[test]
    fn a_page_that_loses_every_entry_is_an_error_not_an_empty_list() {
        // Entries came back but none are usable: that is a parsing problem, not "no
        // CI".
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
        // Lines without a recognised prefix are kept: a missing log line is worse than
        // an extra one.
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
        // Observed: in GitHub logs the BOM of the first line sits before the timestamp
        // (start of the third field), not at the start of the line.
        let mut lines = parse_log(
            "check\tSet up job\t\u{feff}2026-10-20T14:24:56.8724283Z Current runner version\n",
        );
        assert_eq!(lines[0].time, "2026-10-20T14:24:56.8724283Z");
        assert_eq!(lines[0].text, "Current runner version");
        // Should the BOM ever appear at the start of the line, keep it out of the job
        // name too.
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
        // Rate limits, a flaky proxy, missing permissions: all "unclear", never
        // "deleted".
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
