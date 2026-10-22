//! 会话列表要显示的几个数字：**轮数**、**tokens 合计**、**最后对话时间（到日）**。
//!
//! 这里只放纯逻辑：两种工具各有一套原始写法，怎么折成数字、以及折不出来时怎么如实说「不知道」。
//! 取数（读文件 / 读 sqlite）在各自的模块里，它们的测试只覆盖 SQL 与遍历那一层。

use serde::Serialize;

/// 一个会话的三个数字，前端照着画。
///
/// `None` 一律表示**这个工具的存储里没有这项数据**，不是零。界面上要说「—」，
/// 不能说 0 —— 那会让人以为真的没聊过。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// 对话轮数（用户发起的回合数）。
    pub turns: Option<u32>,
    /// 累计 tokens（输入 + 输出 + 缓存读 + 缓存写，由各工具自己的口径给）。
    pub tokens: Option<u64>,
    /// 最后一次对话的时间（毫秒）。
    pub last_at_ms: Option<i64>,
}

/// pi 的一行 `message` 里有没有 `usage`，有就把 `totalTokens` 累加。
///
/// pi 的 usage 记在**助手消息**上，一条消息一个 usage；用户消息没有。
pub fn pi_tokens_of_message(value: &serde_json::Value) -> Option<u64> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("message") {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    usage_total(usage)
}

/// pi 的 usage 口径：有 `totalTokens` 就用它，否则把四个分项加起来。
pub fn usage_total(usage: &serde_json::Value) -> Option<u64> {
    if let Some(total) = as_u64(usage.get("totalTokens")) {
        return Some(total);
    }
    let parts = ["input", "output", "cacheRead", "cacheWrite"];
    let mut sum = 0u64;
    let mut found = false;
    for key in parts {
        if let Some(value) = as_u64(usage.get(key)) {
            sum = sum.saturating_add(value);
            found = true;
        }
    }
    found.then_some(sum)
}

fn as_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    match value? {
        serde_json::Value::Number(number) => number.as_u64().or_else(|| {
            // 有些字段是浮点（cost 写成 0.0），tokens 不该是，但别因此丢掉整条。
            number.as_f64().filter(|v| *v >= 0.0).map(|v| v as u64)
        }),
        _ => None,
    }
}

/// 把一串「一条消息的 tokens」累加起来；一条都没有就是 `None`。
pub fn sum_tokens<I: IntoIterator<Item = u64>>(values: I) -> Option<u64> {
    let mut total = 0u64;
    let mut found = false;
    for value in values {
        total = total.saturating_add(value);
        found = true;
    }
    found.then_some(total)
}

/// 折「最后对话时间」：有消息时间就用消息时间，否则退回文件/记录的更新时间。
///
/// 用消息时间是因为有些工具改写元数据也会刷新 `time_updated`，那不代表有人说过话。
pub fn last_talked_at(message_ms: Option<i64>, fallback_ms: i64) -> i64 {
    message_ms.unwrap_or(fallback_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pi_tokens_come_from_assistant_usage_with_total_first() {
        let line = json!({
            "type": "message",
            "message": { "role": "assistant", "usage": { "input": 100, "output": 20, "cacheRead": 5, "cacheWrite": 1, "totalTokens": 126 } }
        });
        assert_eq!(pi_tokens_of_message(&line), Some(126));
    }

    #[test]
    fn pi_tokens_fall_back_to_the_parts_when_total_is_missing() {
        let usage = json!({ "input": 100, "output": 20, "cacheRead": 5, "cacheWrite": 1 });
        assert_eq!(usage_total(&usage), Some(126));
    }

    #[test]
    fn a_user_message_and_a_usage_less_reply_have_no_tokens() {
        assert_eq!(
            pi_tokens_of_message(&json!({ "type": "message", "message": { "role": "user", "content": "hi" } })),
            None
        );
        assert_eq!(
            pi_tokens_of_message(&json!({ "type": "message", "message": { "role": "assistant" } })),
            None
        );
        assert_eq!(pi_tokens_of_message(&json!({ "type": "session_info" })), None);
    }

    #[test]
    fn summing_nothing_is_none_not_zero() {
        assert_eq!(sum_tokens(std::iter::empty()), None);
        assert_eq!(sum_tokens([1u64, 2, 3]), Some(6));
    }

    #[test]
    fn the_last_talked_time_prefers_messages_over_metadata_touches() {
        assert_eq!(last_talked_at(Some(500), 900), 500);
        assert_eq!(last_talked_at(None, 900), 900);
    }
}
