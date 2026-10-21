//! 一个仓库的当前账号权限：界面据此决定写操作按钮在不在。
//!
//! 取数走 `gh repo view <slug> --json viewerPermission --jq .viewerPermission`，
//! 起进程在 `commands.rs`，这里只放能单测的纯逻辑。

/// 把 `--jq .viewerPermission` 的输出读成权限名；空输出算查不到。
pub fn parse_permission(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 这个权限能不能做写操作。
///
/// GitHub 给的是 `ADMIN` / `MAINTAIN` / `WRITE` / `TRIAGE` / `READ`，前三个能写。
/// **查不到、或者是我们不认识的档位时返回 true**：按钮照常渲染，点下去由 GitHub 拒绝并透传原文。
/// 反过来把按钮全藏了，会让一个本来能操作的用户彻底没入口。
pub fn write_allowed(permission: Option<&str>) -> bool {
    let Some(level) = permission else {
        return true;
    };
    !matches!(level.trim().to_ascii_uppercase().as_str(), "TRIAGE" | "READ")
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
    fn a_read_only_probe_forbids_writes() {
        let payload = RepoPermissionPayload::found("me/app", Some("READ".into()), false);
        assert_eq!(payload.kind, "ready");
        assert!(!payload.can_write);
        assert_eq!(payload.permission.as_deref(), Some("READ"));
        assert!(payload.error.is_none());
    }
}
