//! Pure logic for the remote repository list: build paging paths, parse gh's JSON,
//! classify failures.
//!
//! Nothing here spawns processes, reads credentials or touches the network, so the
//! tests can call it directly.

use serde::Deserialize;

use super::types::{RemoteRepo, KIND_ERROR, KIND_NOT_LOGGED_IN};

/// The largest page size GitHub's `user/repos` allows.
pub const MAX_PER_PAGE: usize = 100;
/// Page limit. 10 pages × 100 rows covers the vast majority of accounts; beyond that
/// it only spends time on the network.
pub const MAX_PAGES: usize = 10;

/// The paged path for fetching repos with `gh api`. All three affiliations are needed:
/// owned, collaborator, and visible through organization membership.
pub fn page_path(page: usize, per_page: usize) -> String {
    format!(
        "user/repos?per_page={per_page}&page={page}&sort=pushed&affiliation=owner,collaborator,organization_member"
    )
}

/// Whether a page means "there is more": keep paging only when the row count equals the
/// page size. A short page means the end (the endpoint is ordered and never returns a
/// short page mid-way).
pub fn should_continue_page(count: usize, per_page: usize) -> bool {
    per_page > 0 && count >= per_page
}

/// Which category a failed gh call falls into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    NotLoggedIn,
    Error,
}

impl Failure {
    pub fn kind(self) -> &'static str {
        match self {
            Failure::NotLoggedIn => KIND_NOT_LOGGED_IN,
            Failure::Error => KIND_ERROR,
        }
    }
}

/// Classify by gh's own wording. `text` is the stdout + stderr of this hop.
///
/// Rules:
/// - when logged out, gh points at `gh auth login` ("To get started with GitHub CLI,
///   please run: gh auth login") → `notLoggedIn`;
/// - an expired keyring token leaves `gh auth status` exiting 0 with "token in keyring
///   is invalid" in the output, which also counts as `notLoggedIn`;
/// - `bad credentials` / `HTTP 401` mean invalid credentials, likewise `notLoggedIn`;
/// - `HTTP 403` is not logged-out: it is far more often a rate limit ("API rate limit
///   exceeded") or insufficient permissions ("Resource not accessible by integration"),
///   where logging in again does not help, so it is honestly an `error`.
pub fn classify_failure(text: &str) -> Failure {
    const NOT_LOGGED_IN_HINTS: [&str; 7] = [
        "gh auth login",
        "token in keyring is invalid",
        "authentication required",
        "requires authentication",
        "not logged in",
        "bad credentials",
        "http 401",
    ];
    let lower = text.to_ascii_lowercase();
    if NOT_LOGGED_IN_HINTS
        .iter()
        .any(|needle| lower.contains(needle))
    {
        Failure::NotLoggedIn
    } else {
        Failure::Error
    }
}

/// A single value printed by `gh api ... --jq <expr>`.
///
/// Empty output, or the `null` jq prints for a null value, both count as "absent";
/// trailing newlines and surrounding spaces are trimmed.
pub fn parse_login(text: &str) -> Option<String> {
    let value = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    if value == "null" {
        None
    } else {
        Some(value.to_string())
    }
}

/// Parse the body of `gh api user/repos`.
///
/// Tolerant per entry: an entry without `full_name` (or not shaped like `owner/name`) is
/// dropped without affecting the page; `fork` / `archived` / `private` default to false;
/// a missing `owner.login` is filled from the first half of `full_name` rather than
/// panicking.
pub fn parse_repos(json: &str) -> Result<Vec<RemoteRepo>, serde_json::Error> {
    let raw: Vec<RawRepo> = serde_json::from_str(json)?;
    Ok(raw.into_iter().filter_map(convert).collect())
}

/// gh's failure text is passed to the frontend verbatim, but without the whole usage
/// dump: at most 5 lines / 600 characters.
pub fn error_excerpt(text: &str) -> String {
    const MAX_LINES: usize = 5;
    const MAX_CHARS: usize = 600;

    let mut out = String::new();
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
    {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    let excerpt = if out.is_empty() {
        text.trim().to_string()
    } else {
        out
    };
    if excerpt.chars().count() > MAX_CHARS {
        let head: String = excerpt.chars().take(MAX_CHARS).collect();
        return format!("{head}…");
    }
    excerpt
}

#[derive(Deserialize)]
struct RawRepo {
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    owner: Option<RawOwner>,
}

#[derive(Deserialize)]
struct RawOwner {
    #[serde(default)]
    login: Option<String>,
}

fn convert(raw: RawRepo) -> Option<RemoteRepo> {
    let full_name = raw.full_name?.trim().to_string();
    let (owner_part, name_part) = full_name.split_once('/')?;
    if owner_part.is_empty() || name_part.is_empty() {
        return None;
    }
    let owner = non_empty(raw.owner.and_then(|owner| owner.login))
        .unwrap_or_else(|| owner_part.to_string());
    let name = non_empty(raw.name).unwrap_or_else(|| name_part.to_string());
    let web_url =
        non_empty(raw.html_url).unwrap_or_else(|| format!("https://github.com/{full_name}"));
    Some(RemoteRepo {
        full_name,
        owner,
        name,
        is_private: raw.private,
        is_fork: raw.fork,
        is_archived: raw.archived,
        language: non_empty(raw.language),
        pushed_at: non_empty(raw.pushed_at),
        description: non_empty(raw.description),
        web_url,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(json: serde_json::Value) -> Vec<RemoteRepo> {
        parse_repos(&json.to_string()).expect("valid json")
    }

    #[test]
    fn parses_a_full_repo_record() {
        let repos = parse(json!([{
            "full_name": "Zomcxj/Verta",
            "name": "Verta",
            "private": true,
            "fork": true,
            "archived": true,
            "language": "Rust",
            "pushed_at": "2026-02-01T08:30:00Z",
            "description": "桌面工作台",
            "html_url": "https://github.com/Zomcxj/Verta",
            "owner": { "login": "Zomcxj" }
        }]));

        assert_eq!(repos.len(), 1);
        let repo = &repos[0];
        assert_eq!(repo.full_name, "Zomcxj/Verta");
        assert_eq!(repo.owner, "Zomcxj");
        assert_eq!(repo.name, "Verta");
        assert!(repo.is_private);
        assert!(repo.is_fork);
        assert!(repo.is_archived);
        assert_eq!(repo.language.as_deref(), Some("Rust"));
        assert_eq!(repo.pushed_at.as_deref(), Some("2026-02-01T08:30:00Z"));
        assert_eq!(repo.description.as_deref(), Some("桌面工作台"));
        assert_eq!(repo.web_url, "https://github.com/Zomcxj/Verta");
    }

    #[test]
    fn null_description_and_language_become_none() {
        let repos = parse(json!([{
            "full_name": "Zomcxj/empty",
            "description": null,
            "language": null,
            "pushed_at": null
        }]));

        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].description, None);
        assert_eq!(repos[0].language, None);
        assert_eq!(repos[0].pushed_at, None);
    }

    #[test]
    fn drops_the_entries_that_cannot_be_identified() {
        let repos = parse(json!([
            { "name": "no-full-name", "owner": { "login": "Zomcxj" } },
            { "full_name": "" },
            { "full_name": "no-slash" },
            { "full_name": "Zomcxj/kept" }
        ]));

        assert_eq!(repos.len(), 1, "只有能拼出 owner/name 的才留下");
        assert_eq!(repos[0].full_name, "Zomcxj/kept");
    }

    #[test]
    fn missing_flags_default_to_false() {
        let repos = parse(json!([{ "full_name": "Zomcxj/Verta" }]));

        assert_eq!(repos.len(), 1);
        assert!(!repos[0].is_private);
        assert!(!repos[0].is_fork);
        assert!(!repos[0].is_archived);
    }

    #[test]
    fn a_missing_owner_login_falls_back_to_the_full_name() {
        let repos = parse(json!([{ "full_name": "Zomcxj/Verta", "name": "Verta" }]));
        assert_eq!(repos[0].owner, "Zomcxj");

        let repos = parse(json!([{ "full_name": "Zomcxj/Verta", "owner": {} }]));
        assert_eq!(repos[0].owner, "Zomcxj");
    }

    #[test]
    fn missing_web_url_is_derived_from_the_full_name() {
        let repos = parse(json!([{ "full_name": "Zomcxj/Verta" }]));
        assert_eq!(repos[0].web_url, "https://github.com/Zomcxj/Verta");
    }

    #[test]
    fn a_non_array_body_is_an_error() {
        assert!(parse_repos("{\"message\":\"Bad credentials\"}").is_err());
        assert!(parse_repos("<html>").is_err());
        assert!(parse_repos("[]").expect("array").is_empty());
    }

    #[test]
    fn page_path_carries_paging_and_every_affiliation() {
        let path = page_path(3, 50);
        assert!(path.starts_with("user/repos?"), "{path}");
        assert!(path.contains("per_page=50"), "{path}");
        assert!(path.contains("page=3"), "{path}");
        assert!(path.contains("sort=pushed"), "{path}");
        assert!(
            path.contains("affiliation=owner,collaborator,organization_member"),
            "三类 affiliation 都要在：{path}"
        );
    }

    #[test]
    fn classify_failure_knows_the_unlogged_in_wording() {
        // An expired keyring token: `gh auth status` still exits 0, but prints this line.
        assert_eq!(
            classify_failure("The token in keyring is invalid. Run gh auth login to renew."),
            Failure::NotLoggedIn
        );
        assert_eq!(
            classify_failure(
                "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable"
            ),
            Failure::NotLoggedIn
        );
        assert_eq!(
            classify_failure("gh: Bad credentials (HTTP 401)"),
            Failure::NotLoggedIn
        );
        assert_eq!(Failure::NotLoggedIn.kind(), KIND_NOT_LOGGED_IN);
    }

    #[test]
    fn classify_failure_keeps_transport_and_rate_limit_errors_apart() {
        for text in [
            "error: Post \"https://api.github.com/user/repos\": dial tcp 140.82.112.5:443: connect: connection refused",
            "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
            "gh: Resource not accessible by integration (HTTP 403)",
        ] {
            assert_eq!(classify_failure(text), Failure::Error, "{text}");
        }
        assert_eq!(Failure::Error.kind(), KIND_ERROR);
    }

    #[test]
    fn should_continue_page_only_on_a_full_page() {
        assert!(should_continue_page(100, 100));
        assert!(should_continue_page(101, 100), "多出来的条数也算没到末尾");
        assert!(!should_continue_page(99, 100));
        assert!(!should_continue_page(0, 100));
        assert!(!should_continue_page(50, 0), "每页 0 条会死循环，必须停");
    }

    #[test]
    fn parse_login_trims_the_jq_output() {
        assert_eq!(parse_login("Zomcxj\n"), Some("Zomcxj".into()));
        assert_eq!(parse_login("Zomcxj"), Some("Zomcxj".into()));
        assert_eq!(parse_login("  Zomcxj  \r\n"), Some("Zomcxj".into()));
        assert_eq!(parse_login("null\n"), None, "jq 对空值打印 null");
        assert_eq!(parse_login(""), None);
        assert_eq!(parse_login("\n \n"), None);
    }

    #[test]
    fn error_excerpt_caps_lines_and_length() {
        assert_eq!(
            error_excerpt("gh: Not Found (HTTP 404)"),
            "gh: Not Found (HTTP 404)"
        );
        assert_eq!(error_excerpt("\n  \n"), "");
        assert_eq!(
            error_excerpt("a\nb\nc\nd\ne\nf\ng"),
            "a\nb\nc\nd\ne",
            "只留前几行"
        );

        let long = "x".repeat(900);
        let excerpt = error_excerpt(&long);
        assert_eq!(excerpt.chars().count(), 601, "600 字符 + 省略号");
        assert!(excerpt.ends_with('…'));
    }
}
