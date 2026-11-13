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

/// Whether a Claude Code `assistant` line carries `usage`, whose four parts get summed.
///
/// Claude Code writes Anthropic's own names on its assistant messages - `input_tokens`,
/// `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` - one usage per message,
/// and none on user messages. Measured on a real transcript rather than assumed.
pub fn claude_tokens_of_message(value: &serde_json::Value) -> Option<u64> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
        return None;
    }
    let usage = value.get("message")?.get("usage")?;
    let mut sum = 0u64;
    let mut found = false;
    for key in [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ] {
        if let Some(part) = as_u64(usage.get(key)) {
            sum = sum.saturating_add(part);
            found = true;
        }
    }
    found.then_some(sum)
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

/// An ISO-8601 UTC timestamp, to milliseconds.
///
/// pi and Claude Code both write `2026-11-13T01:05:59.276Z` on their conversation events, so the
/// parser lives here rather than in either of them. Anything it does not recognise answers `None`
/// rather than being guessed at: a wrong time would silently reorder the list.
pub(crate) fn iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> {
        text.get(range)?.parse::<i64>().ok()
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hour, minute, second) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let millis = text
        .get(19..)
        .and_then(|rest| rest.strip_prefix('.'))
        .filter(|rest| rest.len() >= 3)
        .and_then(|rest| rest.get(0..3))
        .and_then(|digits| digits.parse::<i64>().ok())
        .unwrap_or(0);
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + minute * 60 + second.min(59);
    Some(secs * 1_000 + millis)
}

pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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
