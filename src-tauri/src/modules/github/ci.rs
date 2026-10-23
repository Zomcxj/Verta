//! CI status for a single repository: read its latest workflow run.
//!
//! One repository per query: querying every repo in the list would burn through the API
//! quota, so the UI triggers this on demand. Process spawning lives in `commands.rs`; only
//! the unit-testable logic is here: validating the repo name and parsing gh's output.
//!
//! The endpoint is `repos/{owner}/{repo}/actions/runs?per_page=1`: GitHub returns
//! newest-updated first, so the first entry is the latest run.

use serde_json::Value;

use super::types::RepoCiRun;

/// Parse the JSON for "the latest run".
///
/// `Ok(None)` means the repository genuinely has no runs (CI not configured, or never
/// run): a definite "nothing", not a parse failure.
pub fn parse_latest_run(stdout: &str) -> Result<Option<RepoCiRun>, String> {
    let value: Value = serde_json::from_str(stdout).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let runs = value
        .get("workflow_runs")
        .and_then(Value::as_array)
        .ok_or_else(|| "返回里没有 workflow_runs".to_string())?;
    let Some(first) = runs.first() else {
        return Ok(None);
    };

    // status and url are needed to know "how far along" and "where to click"; when missing,
    // say which one instead of guessing.
    let status = text_field(first, "status").ok_or_else(|| "运行里没有 status".to_string())?;
    let url = text_field(first, "html_url").ok_or_else(|| "运行里没有 html_url".to_string())?;

    Ok(Some(RepoCiRun {
        // The workflow name may be empty (old data): give a neutral fallback rather than an
        // empty string.
        name: text_field(first, "name").unwrap_or_else(|| "workflow".to_string()),
        status,
        // In these states GitHub either sends conclusion as null or omits the field.
        conclusion: text_field(first, "conclusion"),
        run_number: first
            .get("run_number")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        head_branch: text_field(first, "head_branch"),
        updated_at: text_field(first, "updated_at"),
        url,
    }))
}

/// Take a non-empty string field; null / empty / non-string all count as absent.
fn text_field(value: &Value, key: &str) -> Option<String> {
    let raw = value.get(key)?.as_str()?.trim();
    (!raw.is_empty()).then(|| raw.to_string())
}

/// Validate the `owner/repo` coming from the UI.
///
/// gh's arguments are passed one by one (no shell), but a value starting with `-` would
/// still be read as an option, so it is rejected up front. The rest must match the
/// character set GitHub actually uses; anything outside it is refused here rather than
/// bounced back by gh.
pub fn parse_repo_slug(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("仓库名是空的".to_string());
    }
    if trimmed.starts_with('-') {
        return Err(format!("仓库名不能以 - 开头：{trimmed}"));
    }
    let (owner, name) = trimmed
        .split_once('/')
        .ok_or_else(|| format!("仓库名要是 owner/repo 形式：{trimmed}"))?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return Err(format!("仓库名要是 owner/repo 形式：{trimmed}"));
    }
    if !owner.chars().all(is_slug_char) || !name.chars().all(is_slug_char) {
        return Err(format!("仓库名里有不支持的字符：{trimmed}"));
    }
    Ok(format!("{owner}/{name}"))
}

fn is_slug_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE_RUN: &str = r#"{
        "total_count": 12,
        "workflow_runs": [
            {
                "name": "CI",
                "status": "completed",
                "conclusion": "failure",
                "run_number": 48,
                "head_branch": "main",
                "updated_at": "2026-10-20T12:00:00Z",
                "html_url": "https://github.com/a/b/actions/runs/1"
            }
        ]
    }"#;

    #[test]
    fn parses_the_latest_run() {
        let run = parse_latest_run(ONE_RUN).unwrap().unwrap();
        assert_eq!(run.name, "CI");
        assert_eq!(run.status, "completed");
        assert_eq!(run.conclusion.as_deref(), Some("failure"));
        assert_eq!(run.run_number, 48);
        assert_eq!(run.head_branch.as_deref(), Some("main"));
        assert_eq!(run.url, "https://github.com/a/b/actions/runs/1");
    }

    #[test]
    fn an_empty_run_list_is_a_clear_nothing_not_a_failure() {
        let stdout = r#"{"total_count": 0, "workflow_runs": []}"#;
        assert!(parse_latest_run(stdout).unwrap().is_none());
    }

    #[test]
    fn a_running_run_has_no_conclusion_yet() {
        let stdout = r#"{"workflow_runs": [{
            "name": "CI", "status": "in_progress", "conclusion": null,
            "html_url": "https://github.com/a/b/actions/runs/2"
        }]}"#;
        let run = parse_latest_run(stdout).unwrap().unwrap();
        assert_eq!(run.status, "in_progress");
        assert_eq!(run.conclusion, None);
        assert_eq!(run.run_number, 0);
        // Without a workflow name, use a neutral fallback rather than leaving it empty.
        let unnamed =
            parse_latest_run(r#"{"workflow_runs": [{"status": "queued", "html_url": "u"}]}"#)
                .unwrap()
                .unwrap();
        assert_eq!(unnamed.name, "workflow");
    }

    #[test]
    fn malformed_output_is_reported_not_guessed() {
        assert!(parse_latest_run("not json").unwrap_err().contains("JSON"));
        assert!(parse_latest_run("{}")
            .unwrap_err()
            .contains("workflow_runs"));
        // A run exists but status / url is missing: name what is missing.
        let missing_status = r#"{"workflow_runs": [{"html_url": "u"}]}"#;
        assert!(parse_latest_run(missing_status)
            .unwrap_err()
            .contains("status"));
        let missing_url = r#"{"workflow_runs": [{"status": "queued"}]}"#;
        assert!(parse_latest_run(missing_url)
            .unwrap_err()
            .contains("html_url"));
    }

    #[test]
    fn slug_accepts_the_shapes_github_uses() {
        assert_eq!(parse_repo_slug("Zomcxj/Verta").unwrap(), "Zomcxj/Verta");
        assert_eq!(parse_repo_slug("  a-b/c.d_e  ").unwrap(), "a-b/c.d_e");
        assert_eq!(parse_repo_slug("a/b").unwrap(), "a/b");
    }

    #[test]
    fn slug_rejects_anything_gh_could_read_as_an_option_or_could_not_use() {
        for bad in [
            "",
            "   ",
            "no-slash",
            "a/b/c",
            "/b",
            "a/",
            "-a/b",
            "a b/c",
            "a/b c",
            "a/../b",
            "a/b;rm -rf /",
        ] {
            assert!(parse_repo_slug(bad).is_err(), "{bad:?} 应该被拒");
        }
    }
}
