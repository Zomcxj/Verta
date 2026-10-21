//! 仓库管理（改描述、切可见性、删仓库）里能单测的那部分。
//!
//! 起 `gh` 进程在 `commands.rs`，这里只放解析与判定：
//! - `parse_settings` 读 `gh repo view --json description,visibility,viewerPermission`；
//! - `description_problem` 在本地拦掉 GitHub 一定会拒的输入（超长）；
//! - `needs_delete_scope` 认出「gh 缺 delete_repo 授权」这种能自己补救的失败。

use serde_json::Value;

/// GitHub 对仓库描述的长度上限（超出会直接报错，不如在本地就说清楚）。
const DESCRIPTION_MAX_CHARS: usize = 350;

/// `gh repo view --json description,visibility,viewerPermission` 的三样结果。
#[derive(Debug, Clone, PartialEq)]
pub struct RepoSettings {
    /// 没有描述时是 None（GitHub 给的是空串）。
    pub description: Option<String>,
    /// `PUBLIC` / `PRIVATE` / `INTERNAL`；GitHub 没给时是 None。
    pub visibility: Option<String>,
    /// `ADMIN` / `MAINTAIN` / ... ；查不到时是 None。
    pub permission: Option<String>,
}

pub fn parse_settings(stdout: &str) -> Result<RepoSettings, String> {
    let value: Value =
        serde_json::from_str(stdout).map_err(|e| format!("gh 返回的仓库信息无法解析：{e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "gh 返回的仓库信息不是对象".to_string())?;

    let text = |key: &str| -> Option<String> {
        object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };

    Ok(RepoSettings {
        description: text("description"),
        visibility: text("visibility"),
        permission: text("viewerPermission"),
    })
}

/// 描述在本地能不能过；不能过就给一句给用户看的话。
///
/// 只拦 GitHub 必然拒绝的（超长）。空串是合法的：那表示清空描述。
pub fn description_problem(description: &str) -> Option<String> {
    let length = description.trim().chars().count();
    if length > DESCRIPTION_MAX_CHARS {
        return Some(format!(
            "仓库描述最多 {DESCRIPTION_MAX_CHARS} 个字符，现在有 {length} 个"
        ));
    }
    None
}

/// 失败文本是不是「gh 缺 delete_repo 授权」——这种用户自己一条命令就能补救。
pub fn needs_delete_scope(text: &str) -> bool {
    const HINTS: [&str; 3] = ["delete_repo", "oauth scope", "reauthenticate"];
    let lower = text.to_ascii_lowercase();
    HINTS.iter().any(|hint| lower.contains(hint))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(description: &str, visibility: &str, permission: &str) -> String {
        format!(
            r#"{{"description":{description},"visibility":{visibility},"viewerPermission":{permission}}}"#
        )
    }

    #[test]
    fn parse_settings_reads_all_three_fields() {
        let settings = parse_settings(&json(
            r#""a desktop tool""#,
            r#""PUBLIC""#,
            r#""ADMIN""#,
        ))
        .expect("应该能解析");
        assert_eq!(settings.description.as_deref(), Some("a desktop tool"));
        assert_eq!(settings.visibility.as_deref(), Some("PUBLIC"));
        assert_eq!(settings.permission.as_deref(), Some("ADMIN"));
    }

    #[test]
    fn parse_settings_treats_an_empty_description_as_none() {
        let settings = parse_settings(&json(r#""""#, r#""PRIVATE""#, r#""READ""#)).expect("应该能解析");
        assert_eq!(settings.description, None);
        assert_eq!(settings.visibility.as_deref(), Some("PRIVATE"));
        assert_eq!(settings.permission.as_deref(), Some("READ"));
    }

    #[test]
    fn parse_settings_keeps_missing_fields_as_none() {
        let settings = parse_settings(r#"{"visibility":"INTERNAL"}"#).expect("应该能解析");
        assert_eq!(settings.description, None);
        assert_eq!(settings.visibility.as_deref(), Some("INTERNAL"));
        assert_eq!(settings.permission, None);
    }

    #[test]
    fn parse_settings_rejects_junk_and_non_objects() {
        assert!(parse_settings("not json").is_err());
        assert!(parse_settings("[]").is_err());
        assert!(parse_settings("\"a string\"").is_err());
    }

    #[test]
    fn a_description_at_the_limit_is_fine_and_one_past_it_is_not() {
        assert_eq!(description_problem(&"x".repeat(DESCRIPTION_MAX_CHARS)), None);
        let too_long = "x".repeat(DESCRIPTION_MAX_CHARS + 1);
        let problem = description_problem(&too_long).expect("超长应该被拦下");
        assert!(problem.contains("350"), "实际：{problem}");
        assert!(problem.contains("351"), "实际：{problem}");
    }

    #[test]
    fn an_empty_description_is_allowed_it_clears_the_field() {
        assert_eq!(description_problem(""), None);
        assert_eq!(description_problem("   "), None);
    }

    #[test]
    fn needs_delete_scope_recognises_the_oauth_scope_complaints() {
        assert!(needs_delete_scope(
            "failed to delete: requires the delete_repo OAuth scope, run gh auth refresh -s delete_repo"
        ));
        assert!(needs_delete_scope("HTTP 403: missing required scopes [delete_repo]"));
        assert!(needs_delete_scope("please reauthenticate and try again"));
        assert!(!needs_delete_scope("HTTP 404: Not Found"));
        assert!(!needs_delete_scope("must have admin rights to Repository"));
    }
}
