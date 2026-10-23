//! The current account's permission on a repository; the UI decides from it whether to
//! offer write actions.
//!
//! Fetched via `gh repo view <slug> --json viewerPermission --jq .viewerPermission`.
//! Process spawning lives in `commands.rs`; only unit-testable logic is here.

/// Read the output of `--jq .viewerPermission` as a permission name; empty output means
/// unknown.
pub fn parse_permission(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Whether this permission allows write operations.
///
/// GitHub reports `ADMIN` / `MAINTAIN` / `WRITE` / `TRIAGE` / `READ`, of which the first
/// three may write. **Unknown or unrecognised levels return true**: the buttons still
/// render, and GitHub rejects the click with its own message. Hiding them instead would
/// leave a perfectly capable user with no way in.
pub fn write_allowed(permission: Option<&str>) -> bool {
    let Some(level) = permission else {
        return true;
    };
    !matches!(level.trim().to_ascii_uppercase().as_str(), "TRIAGE" | "READ")
}

/// Whether the repository settings may be changed (edit description / toggle visibility
/// / delete).
///
/// GitHub only allows admins to do these, so this is stricter than [`write_allowed`]:
/// only `ADMIN` counts. **Unknown or unrecognised levels also return true**: for the same
/// reason as write access, better to let GitHub reject it.
pub fn admin_allowed(permission: Option<&str>) -> bool {
    let Some(level) = permission else {
        return true;
    };
    let level = level.trim().to_ascii_uppercase();
    match level.as_str() {
        // Empty output means unknown; unrecognised levels likewise render as "allowed" and
        // let GitHub reject the click.
        "" | "ADMIN" => true,
        // Among the recognised levels, anything but ADMIN is insufficient for settings.
        "MAINTAIN" | "WRITE" | "TRIAGE" | "READ" => false,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::github::types::RepoPermissionPayload;

    #[test]
    fn admin_maintain_and_write_may_write() {
        for level in ["ADMIN", "MAINTAIN", "WRITE"] {
            assert!(write_allowed(Some(level)), "{level} 应该能写");
        }
    }

    #[test]
    fn triage_and_read_may_not_write() {
        for level in ["TRIAGE", "READ"] {
            assert!(!write_allowed(Some(level)), "{level} 不应该能写");
        }
    }

    #[test]
    fn an_unknown_permission_keeps_the_buttons() {
        assert!(write_allowed(None));
        assert!(write_allowed(Some("SOMETHING_NEW")));
    }

    #[test]
    fn the_level_is_matched_regardless_of_case() {
        assert!(write_allowed(Some("admin")));
        assert!(!write_allowed(Some("read")));
    }

    #[test]
    fn parse_permission_keeps_the_name_and_ignores_blank_output() {
        assert_eq!(parse_permission("ADMIN\n").as_deref(), Some("ADMIN"));
        assert_eq!(parse_permission("  READ  ").as_deref(), Some("READ"));
        assert_eq!(parse_permission("\n"), None);
        assert_eq!(parse_permission(""), None);
    }

    #[test]
    fn a_failed_probe_still_allows_writes() {
        let payload = RepoPermissionPayload::failed("error", "me/app", "rate limited");
        assert_eq!(payload.kind, "error");
        assert!(payload.can_write);
        assert!(payload.permission.is_none());
        assert_eq!(payload.error.as_deref(), Some("rate limited"));

        let missing = RepoPermissionPayload::not_installed("me/app");
        assert!(missing.can_write);
    }

    #[test]
    fn only_admins_may_change_repo_settings() {
        assert!(admin_allowed(Some("ADMIN")));
        assert!(admin_allowed(Some("admin")));
        for level in ["MAINTAIN", "WRITE", "TRIAGE", "READ"] {
            assert!(!admin_allowed(Some(level)), "{level} 不该能改设置");
        }
    }

    #[test]
    fn an_unknown_permission_keeps_the_settings_buttons() {
        assert!(admin_allowed(None));
        assert!(admin_allowed(Some("SOMETHING_NEW")));
        assert!(admin_allowed(Some("")));
    }

    #[test]
    fn a_read_only_probe_forbids_writes() {
        let payload = RepoPermissionPayload::found("me/app", Some("READ".into()), false);
        assert_eq!(payload.kind, "ready");
        assert!(!payload.can_write);
        assert_eq!(payload.permission.as_deref(), Some("READ"));
        assert!(payload.error.is_none());
    }
}
