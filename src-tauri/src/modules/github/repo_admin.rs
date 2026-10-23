//! The unit-testable part of repository administration (edit description, toggle
//! visibility, delete).
//!
//! Spawning `gh` lives in `commands.rs`; only parsing and checks are here:
//! - `parse_settings` reads `gh repo view --json description,visibility,viewerPermission`;
//! - `description_problem` rejects what GitHub would certainly refuse (over-long);
//! - `needs_delete_scope` recognises the self-fixable "gh lacks delete_repo scope"
//!   failure.

use serde_json::Value;

/// GitHub's maximum repository description length (exceeding it is an outright error,
/// so better to say so locally).
const DESCRIPTION_MAX_CHARS: usize = 350;

/// The three values of `gh repo view --json description,visibility,viewerPermission`.
#[derive(Debug, Clone, PartialEq)]
pub struct RepoSettings {
    /// None when there is no description (GitHub sends an empty string).
    pub description: Option<String>,
    /// `PUBLIC` / `PRIVATE` / `INTERNAL`; None when GitHub omits it.
    pub visibility: Option<String>,
    /// `ADMIN` / `MAINTAIN` / ...; None when unknown.
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

/// Whether the description passes locally; if not, a message for the user.
///
/// Only what GitHub would certainly reject (over-long). An empty string is valid: it
/// clears the description.
pub fn description_problem(description: &str) -> Option<String> {
    let length = description.trim().chars().count();
    if length > DESCRIPTION_MAX_CHARS {
        return Some(format!(
            "仓库描述最多 {DESCRIPTION_MAX_CHARS} 个字符，现在有 {length} 个"
        ));
    }
    None
}

/// Whether the failure text is "gh lacks the delete_repo scope" — something the user can
/// fix with a single command.
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
