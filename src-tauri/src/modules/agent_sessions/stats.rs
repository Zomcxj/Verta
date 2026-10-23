//! The numbers the session list shows: **turns**, **total tokens**, and **last talked
//! at (to the day)**.
//!
//! Only pure logic lives here: each tool has its own raw format, and this is how it folds
//! into numbers, and how it honestly says "unknown" when it cannot. Fetching (reading
//! files / sqlite) lives in the per-tool modules, whose tests only cover SQL and traversal.

use serde::Serialize;

/// A session's three numbers, which the frontend renders as-is.
///
/// `None` always means **the tool's storage does not track this**, not zero. The UI must
/// show an em-dash, never 0, which would suggest nothing was ever discussed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// Number of turns (rounds the user started).
    pub turns: Option<u32>,
    /// Total tokens (input + output + cache read + cache write, by each tool's own
    /// accounting).
    pub tokens: Option<u64>,
    /// When the last conversation happened (milliseconds).
    pub last_at_ms: Option<i64>,
}

/// Whether a pi `message` line carries `usage`, whose `totalTokens` gets summed.
///
/// pi records usage on **assistant messages**, one usage per message; user messages have
/// none.
pub fn pi_tokens_of_message(value: &serde_json::Value) -> Option<u64> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("message") {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    usage_total(usage)
}

/// pi's usage accounting: use `totalTokens` when present, otherwise sum the four parts.
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
            // Some fields are floats (cost written as 0.0); tokens should not be, but do not
            // drop the whole entry over it.
            number.as_f64().filter(|v| *v >= 0.0).map(|v| v as u64)
        }),
        _ => None,
    }
}

/// Sum a series of per-message token counts; none at all means `None`.
pub fn sum_tokens<I: IntoIterator<Item = u64>>(values: I) -> Option<u64> {
    let mut total = 0u64;
    let mut found = false;
    for value in values {
        total = total.saturating_add(value);
        found = true;
    }
    found.then_some(total)
}

/// Compute "last talked at": the message time when there is one, else the file/record
/// update time.
///
/// Message time wins because some tools refresh `time_updated` when rewriting metadata,
/// which does not mean anyone said anything.
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
