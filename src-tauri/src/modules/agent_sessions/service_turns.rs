//! Whether an opencode session is in the middle of a turn, asked of the service that runs it.
//!
//! The session list marks a session that has nobody looking at it, and the only signal it had was
//! "this session's store was written to recently". That is right most of the time and wrong exactly
//! when it matters: a long tool call writes nothing for minutes, so a session that is plainly
//! working reads as finished.
//!
//! opencode runs a background service to hold its sessions, and that service knows the answer
//! directly. Each session carries two times: `busy`, when its current turn started, and `idle`,
//! when its last turn ended. The turn in progress is the one where `busy` is later than `idle` -
//! the service stamps `idle` as the turn finishes, so a session between turns has them the other
//! way round.
//!
//! The service listens on the loopback interface and asks for HTTP Basic authentication. Its
//! password is written to `service.json` beside its own state, which is how its own command-line
//! client finds it; nothing here is stored beyond the life of one read.

use std::path::PathBuf;

/// Where the service records how to reach it, under the tool's state directory.
const SERVICE_FILE: &str = ".local/state/opencode/service.json";

/// The user the service's Basic authentication expects. Its own client sends this one, and the
/// empty string and `admin` are both refused, so the value is not a guess that happened to work.
const SERVICE_USER: &str = "opencode";

/// One session's view of the service, reduced to the two times that answer the question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnTimes {
    pub id: String,
    pub busy_ms: Option<i64>,
    pub idle_ms: Option<i64>,
}

impl TurnTimes {
    /// Whether the turn this session started has not finished yet.
    ///
    /// A missing `busy` is a session that has never run a turn; a missing `idle` is one whose first
    /// turn is still going. Both are answered by comparing the two, so a missing `idle` counts as
    /// "the last turn ended long ago" rather than "no turn at all".
    pub fn mid_turn(&self) -> bool {
        match (self.busy_ms, self.idle_ms) {
            (Some(busy), Some(idle)) => busy > idle,
            (Some(_), None) => true,
            _ => false,
        }
    }
}

/// How to reach one service.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceEndpoint {
    pub url: String,
    pub password: String,
}

/// The ids of sessions whose turn is still running, from one `service.json`.
///
/// A missing or unreadable file is not an error to report: an opencode that has never been run, or
/// one whose service is stopped, simply has nothing to say about its sessions, and the caller falls
/// back to the write times it already has.
pub fn read_endpoint(state_dir: &std::path::Path) -> Option<ServiceEndpoint> {
    let text = std::fs::read_to_string(state_dir).ok()?;
    endpoint_from_json(&text)
}

/// The same, from the JSON as text, so the parsing can be tested without a file.
pub fn endpoint_from_json(text: &str) -> Option<ServiceEndpoint> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let url = value.get("url")?.as_str()?.trim_end_matches('/').to_string();
    let password = value.get("password")?.as_str()?.to_string();
    if url.is_empty() || password.is_empty() {
        return None;
    }
    // Only the loopback interface: a password from this file is not for anywhere else.
    if !(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:")) {
        return None;
    }
    Some(ServiceEndpoint { url, password })
}

/// `/api/session`'s answer, reduced to the sessions whose turn has not finished.
///
/// The payload nests each session's times under `time`, and subagent sessions carry a `parentID`.
/// Subagents are kept here rather than dropped: their parent is what the list shows, and a parent
/// can spend its whole turn waiting on one of them.
pub fn running_ids_from_json(text: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(rows) = value.get("data").and_then(|data| data.as_array()) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(|id| id.as_str()) else {
            continue;
        };
        let time = row.get("time");
        let read = |key: &str| time.and_then(|t| t.get(key)).and_then(|v| v.as_i64());
        let times = TurnTimes {
            id: id.to_string(),
            busy_ms: read("busy"),
            idle_ms: read("idle"),
        };
        if times.mid_turn() {
            ids.push(times.id);
        }
    }
    ids
}

/// Where a tool keeps the record of how to reach its service.
///
/// `home` is this machine's home directory for a local read; a distro's service file is the same
/// relative path inside it and is read by the caller with whatever mechanism reaches that
/// filesystem.
pub fn service_file_under(home: &std::path::Path) -> PathBuf {
    home.join(SERVICE_FILE)
}

/// Asks one service which of its sessions are mid-turn.
///
/// Returns `None` when the question could not be asked at all - no `service.json`, a service that is
/// not listening, an answer that is not what `/api/session` returns. That is deliberately distinct
/// from `Some(vec![])`, which means the service answered and said nothing is running: the caller
/// keeps its write times for the first and may trust the second. A stopped service is the common
/// case of the first, and it must not make every row unmarked.
///
/// The read is local: the service only listens on the loopback interface, and the password in
/// `service.json` opens that one service.
pub async fn running_ids(state_dir: &std::path::Path) -> Option<Vec<String>> {
    let endpoint = read_endpoint(state_dir)?;
    // Before the client is built: reqwest here has no bundled TLS provider, so a client built
    // without one fails and the failure would read as "the service said nothing".
    crate::modules::net::clients::ensure_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let response = client
        .get(format!("{}/api/session", endpoint.url))
        .basic_auth(SERVICE_USER, Some(&endpoint.password))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().await.ok()?;
    Some(running_ids_from_json(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = r#"{"id":"d1578675-3407-4165-ac46-c08d5f0ea93b","version":"2.2.2","url":"http://127.0.0.1:42000","pid":13300,"password":"LIKDAEBsXG0piNHwmUdwFWSOe7b7Tf4Ksa2oBSn9ojQ"}"#;

    #[test]
    fn reads_the_endpoint_the_service_wrote() {
        // The shape this machine's service.json actually had.
        let endpoint = endpoint_from_json(REAL).expect("an endpoint");
        assert_eq!(endpoint.url, "http://127.0.0.1:42000");
        assert_eq!(endpoint.password, "LIKDAEBsXG0piNHwmUdwFWSOe7b7Tf4Ksa2oBSn9ojQ");
    }

    #[test]
    fn refuses_an_endpoint_that_is_not_loopback() {
        // The password in that file opens that service and nothing else, so a file naming another
        // host is either corrupt or not what it claims to be.
        let text = REAL.replace("127.0.0.1", "10.0.0.5");
        assert!(endpoint_from_json(&text).is_none());
        let lan = REAL.replace("http://127.0.0.1:42000", "https://example.com");
        assert!(endpoint_from_json(&lan).is_none());
    }

    #[test]
    fn a_file_without_a_password_is_no_endpoint() {
        let text = r#"{"url":"http://127.0.0.1:42000","password":""}"#;
        assert!(endpoint_from_json(text).is_none());
        assert!(endpoint_from_json("not json").is_none());
        assert!(endpoint_from_json("{}").is_none());
    }

    #[test]
    fn a_trailing_slash_is_dropped_so_paths_join_cleanly() {
        let text = REAL.replace(":42000\"", ":42000/\"");
        let endpoint = endpoint_from_json(&text).expect("an endpoint");
        assert_eq!(endpoint.url, "http://127.0.0.1:42000");
    }

    #[test]
    fn a_turn_is_running_while_busy_is_later_than_idle() {
        let running = TurnTimes { id: "a".into(), busy_ms: Some(200), idle_ms: Some(100) };
        assert!(running.mid_turn());
        // Measured on this machine, PTZ rdk: the last turn ended 59s ago, so busy (833s ago) is
        // earlier - correctly not a running turn, and the write times are what keep that row lit.
        let finished = TurnTimes { id: "b".into(), busy_ms: Some(100), idle_ms: Some(200) };
        assert!(!finished.mid_turn());
        let equal = TurnTimes { id: "c".into(), busy_ms: Some(100), idle_ms: Some(100) };
        assert!(!equal.mid_turn());
    }

    #[test]
    fn a_session_that_never_ran_is_not_running_and_one_still_in_its_first_turn_is() {
        let never = TurnTimes { id: "a".into(), busy_ms: None, idle_ms: Some(100) };
        assert!(!never.mid_turn());
        let first = TurnTimes { id: "b".into(), busy_ms: Some(100), idle_ms: None };
        assert!(first.mid_turn());
        let bare = TurnTimes { id: "c".into(), busy_ms: None, idle_ms: None };
        assert!(!bare.mid_turn());
    }

    #[test]
    fn reads_the_running_sessions_out_of_an_answer() {
        // The fields this machine's `/api/session` returned, trimmed to what is read here.
        let text = r#"{"data":[
            {"id":"ses_running","time":{"created":1,"updated":2,"busy":1793342926936,"idle":1793342041167}},
            {"id":"ses_finished","time":{"created":1,"updated":2,"busy":1793342926936,"idle":1793343500016}},
            {"id":"ses_child","parentID":"ses_running","time":{"busy":1793342971895,"idle":1793343126756}},
            {"id":"ses_never","time":{"created":1,"updated":2}}
        ]}"#;
        assert_eq!(running_ids_from_json(text), vec!["ses_running".to_string()]);
    }

    #[test]
    fn an_unreadable_answer_is_no_answer_rather_than_an_error() {
        // The list has write times to fall back on, so a broken answer must not stop it drawing.
        assert!(running_ids_from_json("").is_empty());
        assert!(running_ids_from_json("not json").is_empty());
        assert!(running_ids_from_json(r#"{"data":"nope"}"#).is_empty());
        assert!(running_ids_from_json(r#"{"data":[{"time":{}}]}"#).is_empty());
    }

    #[test]
    fn the_service_file_sits_under_the_tools_state() {
        let path = service_file_under(std::path::Path::new("/home/x"));
        assert!(path.ends_with(".local/state/opencode/service.json"), "{path:?}");
    }
}
