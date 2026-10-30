//! Whether a repository has anything new to look at: the newest update among its open pull
//! requests and issues.
//!
//! One repository per query, on demand, for the same reason CI status is: asking about every
//! repository in the list would burn through the API quota. Process spawning lives in
//! `commands.rs`; only the parsing is here.
//!
//! The endpoint is `repos/{owner}/{repo}/issues?state=open&sort=updated&direction=desc&per_page=1`.
//! GitHub's issue list covers pull requests too, and `sort=updated` puts the newest change first, so
//! the first entry carries the answer in one request.

use serde_json::Value;

/// Parse the JSON for "the newest update among what is open".
///
/// `Ok(None)` means the repository has nothing open: a definite "nothing", not a parse failure -
/// and exactly what the caller needs to hear to stay quiet.
pub fn parse_latest_activity(stdout: &str) -> Result<Option<String>, String> {
    let value: Value = serde_json::from_str(stdout).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let items = value
        .as_array()
        .ok_or_else(|| "返回不是一个数组".to_string())?;
    let Some(first) = items.first() else {
        return Ok(None);
    };
    // The timestamp is the whole answer; without one there is nothing honest to compare, and
    // inventing a time would either light a dot forever or hide a real one.
    let updated = first
        .get("updated_at")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| "条目里没有 updated_at".to_string())?;
    Ok(Some(updated.to_string()))
}

#[cfg(test)]
mod tests {
    use super::parse_latest_activity;

    #[test]
    fn reads_the_newest_update() {
        let json = r#"[{"number":7,"updated_at":"2026-10-29T03:00:00Z"}]"#;
        assert_eq!(
            parse_latest_activity(json).unwrap().as_deref(),
            Some("2026-10-29T03:00:00Z")
        );
    }

    #[test]
    fn no_open_items_is_a_definite_answer() {
        // An empty list is not an error: it says this repository has nothing open, which is
        // exactly what the caller needs to hear to stay quiet.
        assert_eq!(parse_latest_activity("[]").unwrap(), None);
    }

    #[test]
    fn an_entry_without_a_timestamp_is_an_error_not_a_guess() {
        assert!(parse_latest_activity(r#"[{"number":7}]"#).is_err());
        assert!(parse_latest_activity(r#"[{"number":7,"updated_at":null}]"#).is_err());
        assert!(parse_latest_activity(r#"[{"number":7,"updated_at":"  "}]"#).is_err());
    }

    #[test]
    fn broken_json_says_so() {
        assert!(parse_latest_activity("not json").is_err());
        assert!(parse_latest_activity(r#"{"message":"Not Found"}"#).is_err());
    }
}
