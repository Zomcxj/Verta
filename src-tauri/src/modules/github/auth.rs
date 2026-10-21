//! 登录态：读 `gh auth status --json hosts`，以及粘 PAT 之前能在本地拦掉的东西。
//!
//! **token 一律交给 gh 管**：这里只做解析与判定，粘贴的串直接写进 gh 的 stdin，不落任何存储。

use serde_json::Value;

/// 一个已登录（或登录失败）的账号，字段取自 gh 的 JSON。
#[derive(Debug, Clone, PartialEq)]
pub struct AuthAccount {
    pub host: String,
    pub login: Option<String>,
    /// gh 给的 `success` / `failed` 等。
    pub state: String,
    /// 是不是当前活跃账号。
    pub active: bool,
    /// `keyring` / `GH_TOKEN` 等，说明 token 从哪来。
    pub token_source: Option<String>,
    pub git_protocol: Option<String>,
    /// 已授权的能力，逗号分隔的那串拆开。
    pub scopes: Vec<String>,
}

/// 从 `gh auth status --json hosts` 的输出里挑出要展示的那个账号。
///
/// 返回 `None` 表示这台机器一个 host 都没登录（gh 给的是 `{"hosts":{}}`），不是错误。
pub fn parse_status(stdout: &str) -> Result<Option<AuthAccount>, String> {
    let value: Value =
        serde_json::from_str(stdout).map_err(|e| format!("gh 返回的登录态无法解析：{e}"))?;
    let hosts = value
        .get("hosts")
        .and_then(Value::as_object)
        .ok_or_else(|| "gh 返回的登录态里没有 hosts".to_string())?;

    // 优先 github.com 上的活跃账号；没有活跃的就退而取第一个能解析的。
    let mut fallback: Option<AuthAccount> = None;
    for (host, entry) in hosts {
        let accounts = entry
            .as_array()
            .ok_or_else(|| format!("{host} 下面的账号不是数组"))?;
        for raw in accounts {
            let Some(object) = raw.as_object() else {
                return Err(format!("{host} 下面有一个账号不是对象"));
            };
            let text = |key: &str| -> Option<String> {
                object
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            let account = AuthAccount {
                host: text("host").unwrap_or_else(|| host.clone()),
                login: text("login"),
                state: text("state").unwrap_or_else(|| "unknown".to_string()),
                active: object.get("active").and_then(Value::as_bool).unwrap_or(false),
                token_source: text("tokenSource"),
                git_protocol: text("gitProtocol"),
                scopes: text("scopes")
                    .map(|raw| {
                        raw.split(',')
                            .map(str::trim)
                            .filter(|scope| !scope.is_empty())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            if account.active && account.host == "github.com" {
                return Ok(Some(account));
            }
            if fallback.is_none() {
                fallback = Some(account);
            }
        }
    }
    Ok(fallback)
}

/// 粘贴的 token 在本地能不能过；不能过就给一句话。
///
/// 只拦明显不对的（空、带空白、短得不可能）。真正的判断交给 gh —— 它会去问 GitHub，
/// 我们不该在这里假装能验真伪。
pub fn token_problem(token: &str) -> Option<String> {
    // 前后空白是粘贴常态，先去掉；中间的空白才是真问题（多半粘了两段）。
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Some("还没有粘贴 token".to_string());
    }
    if trimmed.split_whitespace().count() > 1 {
        return Some("token 里不能有空白（是不是粘了两段？）".to_string());
    }
    // gh 的 PAT 最短也有几十个字符；太短的一律是粘错了。
    if trimmed.chars().count() < 20 {
        return Some("token 太短了，像是没粘全".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_accounts(accounts: &str) -> String {
        format!(r#"{{"hosts":{{"github.com":[{accounts}]}}}}"#)
    }

    const ONE_ACCOUNT: &str = r#"{"state":"success","active":true,"host":"github.com","login":"Zomcxj","tokenSource":"keyring","scopes":"repo, read:org, gist","gitProtocol":"https"}"#;

    #[test]
    fn parse_status_reads_the_active_account() {
        let account = parse_status(&json_accounts(ONE_ACCOUNT))
            .expect("应该能解析")
            .expect("应该有一个账号");
        assert_eq!(account.host, "github.com");
        assert_eq!(account.login.as_deref(), Some("Zomcxj"));
        assert_eq!(account.state, "success");
        assert!(account.active);
        assert_eq!(account.token_source.as_deref(), Some("keyring"));
        assert_eq!(account.git_protocol.as_deref(), Some("https"));
        assert_eq!(account.scopes, vec!["repo", "read:org", "gist"]);
    }

    #[test]
    fn parse_status_says_none_when_no_host_is_logged_in() {
        assert_eq!(parse_status(r#"{"hosts":{}}"#).expect("应该能解析"), None);
    }

    #[test]
    fn parse_status_prefers_the_active_account_over_the_first_one() {
        let accounts = format!(
            r#"{{"state":"success","active":false,"host":"github.com","login":"old"}},{ONE_ACCOUNT}"#
        );
        let account = parse_status(&json_accounts(&accounts))
            .expect("应该能解析")
            .expect("应该有一个账号");
        assert_eq!(account.login.as_deref(), Some("Zomcxj"));
    }

    #[test]
    fn parse_status_survives_a_failed_account_and_missing_fields() {
        let account = parse_status(&json_accounts(
            r#"{"state":"failed","active":true,"host":"github.com"}"#,
        ))
        .expect("应该能解析")
        .expect("失败账号也要能展示");
        assert_eq!(account.state, "failed");
        assert_eq!(account.login, None);
        assert_eq!(account.token_source, None);
        assert!(account.scopes.is_empty());
    }

    #[test]
    fn parse_status_rejects_junk() {
        assert!(parse_status("not json").is_err());
        assert!(parse_status(r#"{"hosts":[]}"#).is_err());
        assert!(parse_status(r#"{"hosts":{"github.com":{}}}"#).is_err());
    }

    #[test]
    fn token_problem_catches_the_obviously_wrong_ones() {
        assert!(token_problem("").is_some());
        assert!(token_problem("   ").is_some());
        assert!(token_problem("abc").is_some());
        assert!(token_problem("ghp_short").is_some());
        // 带空白的（粘进来时最常见的脏东西）
        assert!(token_problem("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa ghp_b").is_some());
    }

    #[test]
    fn token_problem_lets_plausible_tokens_through() {
        assert_eq!(
            token_problem("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            None
        );
        assert_eq!(
            token_problem("github_pat_11ABCDEFG0abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCD"),
            None
        );
        // 前后空白是粘贴常态，先 trim 再判。
        assert_eq!(
            token_problem("  ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"),
            None
        );
    }
}
