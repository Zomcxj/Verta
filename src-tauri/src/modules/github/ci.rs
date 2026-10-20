//! 单个仓库的 CI 状态：读最近一次 workflow 运行。
//!
//! 一次查一个仓库 —— 列表里每个仓库都去查会把 API 配额烧光，所以由界面按需触发。
//! 起进程在 `commands.rs`，这里只放能单测的纯逻辑：仓库名的预检、gh 输出的解析。
//!
//! 读的是 `repos/{owner}/{repo}/actions/runs?per_page=1`：GitHub 按更新时间倒序返回，
//! 第一条就是最近一次运行。

use serde_json::Value;

use super::types::RepoCiRun;

/// 解析一次「最近一次运行」的 JSON。
///
/// 返回 `Ok(None)` 表示仓库里确实没有运行记录（没配 CI 或还没跑过），那是查清楚了的
/// 「没有」，不是解析失败。
pub fn parse_latest_run(stdout: &str) -> Result<Option<RepoCiRun>, String> {
    let value: Value = serde_json::from_str(stdout).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let runs = value
        .get("workflow_runs")
        .and_then(Value::as_array)
        .ok_or_else(|| "返回里没有 workflow_runs".to_string())?;
    let Some(first) = runs.first() else {
        return Ok(None);
    };

    // status 与 url 是判断「跑到哪了、点哪里」的必需品；缺了就说清楚缺什么，别猜。
    let status = text_field(first, "status").ok_or_else(|| "运行里没有 status".to_string())?;
    let url = text_field(first, "html_url").ok_or_else(|| "运行里没有 html_url".to_string())?;

    Ok(Some(RepoCiRun {
        // workflow 名字可能为空（老数据），给个中性兜底而不是空字符串。
        name: text_field(first, "name").unwrap_or_else(|| "workflow".to_string()),
        status,
        // 这几种状态下 GitHub 会给 conclusion 为 null 或直接不写这个字段。
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

/// 取一个非空的字符串字段；null / 空串 / 非字符串一律算没有。
fn text_field(value: &Value, key: &str) -> Option<String> {
    let raw = value.get(key)?.as_str()?.trim();
    (!raw.is_empty()).then(|| raw.to_string())
}

/// 校验界面递过来的 `owner/repo`。
///
/// gh 的参数是一条一条传的（不拼 shell），但 `-` 开头的值仍会被 gh 当成选项，所以先挡掉；
/// 其余只允许 GitHub 真正会用到的字符集，越界的一律拒收而不是让 gh 去报错。
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
        // 没有 workflow 名字时给中性兜底，不留空。
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
        // 有运行但缺 status / url：缺什么说什么。
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
