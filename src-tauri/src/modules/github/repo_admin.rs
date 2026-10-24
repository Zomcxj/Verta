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

/// Whether the failure text is "gh lacks the delete_repo scope": something the user can
/// fix with a single command.
pub fn needs_delete_scope(text: &str) -> bool {
    const HINTS: [&str; 3] = ["delete_repo", "oauth scope", "reauthenticate"];
    let lower = text.to_ascii_lowercase();
    HINTS.iter().any(|hint| lower.contains(hint))
}

/// Whether a repository name passes the rules GitHub actually enforces.
///
/// Checked locally because the round trip is slow and gh's own wording ("invalid name")
/// does not say what is wrong. GitHub allows letters, digits, `.`, `_` and `-`, up to 100
/// characters.
pub fn repo_name_problem(name: &str) -> Option<String> {
    const NAME_MAX_CHARS: usize = 100;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Some("仓库名不能为空".to_string());
    }
    let length = trimmed.chars().count();
    if length > NAME_MAX_CHARS {
        return Some(format!(
            "仓库名最多 {NAME_MAX_CHARS} 个字符，现在有 {length} 个"
        ));
    }
    if let Some(bad) = trimmed
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
    {
        return Some(format!(
            "仓库名里的 {bad:?} 不能用：只允许字母、数字、点、下划线、连字符"
        ));
    }
    None
}

/// The `gh repo create` arguments for one repository.
///
/// `gitignore` and `license` are template names gh knows (`Rust`, `Node`, `mit`, ...); no
/// template means no file is generated, which is a different thing from an empty one.
pub fn create_args(
    name: &str,
    private: bool,
    description: &str,
    gitignore: Option<&str>,
    license: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "repo".to_string(),
        "create".to_string(),
        name.trim().to_string(),
        if private { "--private" } else { "--public" }.to_string(),
    ];
    let description = description.trim();
    if !description.is_empty() {
        args.push("--description".to_string());
        args.push(description.to_string());
    }
    if let Some(template) = gitignore.map(str::trim).filter(|t| !t.is_empty()) {
        args.push("--gitignore".to_string());
        args.push(template.to_string());
    }
    if let Some(template) = license.map(str::trim).filter(|t| !t.is_empty()) {
        args.push("--license".to_string());
        args.push(template.to_string());
    }
    args
}

/// The slug `gh repo create` reports, read from the URL it prints on success.
///
/// None when the output is not a repository URL: the caller then falls back to the name it
/// asked for instead of pretending to know better.
pub fn slug_from_create_output(stdout: &str) -> Option<String> {
    // gh prints the URL on success; any other line is ignored rather than guessed at.
    let line = stdout.lines().map(str::trim).find(|line| {
        line.starts_with("https://github.com/")
            || line.starts_with("http://github.com/")
            || line.starts_with("git@github.com:")
    })?;
    let rest = line
        .trim_start_matches("https://github.com/")
        .trim_start_matches("http://github.com/")
        .trim_start_matches("git@github.com:");
    let mut parts = rest
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .split('/');
    let owner = parts.next()?.trim();
    let name = parts.next()?.trim();
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    Some(format!("{owner}/{name}"))
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

    #[test]
    fn a_name_github_would_refuse_is_reported_local() {
        assert!(repo_name_problem("  ").is_some());
        assert!(repo_name_problem("我的仓库").is_some(), "非 ASCII 名字");
        assert!(repo_name_problem("has space").is_some());
        assert!(repo_name_problem("has/slash").is_some());
        assert!(repo_name_problem(&"x".repeat(101)).is_some());
    }

    #[test]
    fn the_names_github_accepts_are_left_alone() {
        assert_eq!(repo_name_problem("Verta"), None);
        assert_eq!(repo_name_problem("verta-cli_v2.1"), None);
        assert_eq!(repo_name_problem(".github"), None);
        assert_eq!(repo_name_problem(&"x".repeat(100)), None);
        // The field takes a name, not a slug: the owner comes from the account.
        assert!(repo_name_problem("Zomcxj/verta").is_some());
    }

    #[test]
    fn create_args_only_ask_for_what_was_given() {
        assert_eq!(
            create_args("repo", true, "", None, None),
            vec!["repo", "create", "repo", "--private"]
        );
        assert_eq!(
            create_args("repo", false, "  ", Some("  "), Some("")),
            vec!["repo", "create", "repo", "--public"]
        );
        assert_eq!(
            create_args("repo", true, " 说明 ", Some("Rust"), Some(" mit ")),
            vec![
                "repo",
                "create",
                "repo",
                "--private",
                "--description",
                "说明",
                "--gitignore",
                "Rust",
                "--license",
                "mit",
            ]
        );
    }

    #[test]
    fn the_created_slug_comes_from_the_url_gh_prints() {
        assert_eq!(
            slug_from_create_output("https://github.com/Zomcxj/verta\n"),
            Some("Zomcxj/verta".to_string())
        );
        assert_eq!(
            slug_from_create_output("noise\nhttps://github.com/Zomcxj/verta/\n"),
            Some("Zomcxj/verta".to_string())
        );
        assert_eq!(
            slug_from_create_output("git@github.com:Zomcxj/verta.git"),
            Some("Zomcxj/verta".to_string())
        );
        assert_eq!(slug_from_create_output("created\n"), None);
    }
}
