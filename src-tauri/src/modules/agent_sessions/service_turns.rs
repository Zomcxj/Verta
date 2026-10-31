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

/// The service file is a handful of fields; a larger one is not this file.
const MAX_SERVICE_FILE_BYTES: u64 = 64 * 1024;

/// `/api/session` answers one bounded page, well inside this.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

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
///
/// No `Debug` on purpose: this holds the service's password, and a derived formatter is how a
/// credential reaches a log without anyone deciding to put it there.
#[derive(Clone, PartialEq, Eq)]
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
    if std::fs::metadata(state_dir).ok()?.len() > MAX_SERVICE_FILE_BYTES {
        return None;
    }
    let text = std::fs::read_to_string(state_dir).ok()?;
    endpoint_from_json(&text)
}

/// The same, from the JSON as text, so the parsing can be tested without a file.
pub fn endpoint_from_json(text: &str) -> Option<ServiceEndpoint> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let password = value.get("password")?.as_str()?.to_string();
    if password.is_empty() {
        return None;
    }
    let url = loopback_base(value.get("url")?.as_str()?)?;
    Some(ServiceEndpoint { url, password })
}

/// The base URL of a loopback service, or `None` for anything that is not exactly that.
///
/// The host comes from the parsed URL rather than from its text: `http://127.0.0.1:42000@host`
/// starts with the loopback address and connects to `host`, and this password opens one service on
/// one machine. Only `scheme://host:port` survives, so no file can steer the request at another
/// path, query or fragment while carrying that credential.
fn loopback_base(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let port = url.port()?;
    if port == 0 {
        return None;
    }
    let host = url.host_str()?;
    let host = if host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        host
    };
    let address: std::net::IpAddr = host.trim_matches(['[', ']']).parse().ok()?;
    if !address.is_loopback() {
        return None;
    }
    Some(format!("http://{host}:{port}"))
}

/// `/api/session`'s answer, reduced to the sessions whose turn has not finished.
///
/// The payload nests each session's times under `time`, and subagent sessions carry a `parentID`.
/// Subagents are kept here rather than dropped: their parent is what the list shows, and a parent
/// can spend its whole turn waiting on one of them.
///
/// `None` when the answer is not the shape this endpoint returns, which the caller keeps apart from
/// an empty list: an answer nobody can read has to leave the write times in charge instead of being
/// taken as "nothing is running" and unmarking every row.
pub fn running_ids_from_json(text: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let rows = value.get("data")?.as_array()?;
    let mut ids = Vec::new();
    for row in rows {
        let id = row.get("id")?.as_str()?;
        let time = match row.get("time") {
            None | Some(serde_json::Value::Null) => None,
            Some(value) if value.is_object() => Some(value),
            Some(_) => return None,
        };
        // A missing time and an explicit null both mean "no such stamp"; anything present has to
        // be a number, because a stamp of another type is an answer this code cannot read.
        let read = |key: &str| -> Option<Option<i64>> {
            match time.and_then(|value| value.get(key)) {
                None | Some(serde_json::Value::Null) => Some(None),
                Some(value) => value.as_i64().map(Some),
            }
        };
        let times = TurnTimes {
            id: id.to_string(),
            busy_ms: read("busy")?,
            idle_ms: read("idle")?,
        };
        if times.mid_turn() {
            ids.push(times.id);
        }
    }
    Some(ids)
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
        // The service is on this machine's own loopback interface. A proxy would carry the
        // password elsewhere, and a redirect would carry the authorization header to another
        // origin, so neither is allowed to be negotiated on this request.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
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
    if response
        .content_length()
        .is_some_and(|len| len > MAX_RESPONSE_BYTES)
    {
        return None;
    }
    let body = response.bytes().await.ok()?;
    if body.len() as u64 > MAX_RESPONSE_BYTES {
        return None;
    }
    running_ids_from_json(std::str::from_utf8(&body).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL: &str = r#"{"id":"synthetic-service","version":"2.2.2","url":"http://127.0.0.1:42000","pid":1,"password":"synthetic-password"}"#;

    #[test]
    fn reads_the_endpoint_the_service_wrote() {
        // The shape this machine's service.json actually had.
        let endpoint = endpoint_from_json(REAL).expect("an endpoint");
        assert_eq!(endpoint.url, "http://127.0.0.1:42000");
        assert_eq!(endpoint.password, "synthetic-password");
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
        assert_eq!(running_ids_from_json(text), Some(vec!["ses_running".to_string()]));
    }

    #[test]
    fn an_unreadable_answer_is_no_answer_rather_than_an_error() {
        // The list has write times to fall back on, so a broken answer must not stop it drawing,
        // and it must not read as "nothing is running" either: that would unmark every row.
        assert_eq!(running_ids_from_json(""), None);
        assert_eq!(running_ids_from_json("not json"), None);
        assert_eq!(running_ids_from_json(r#"{"data":"nope"}"#), None);
        assert_eq!(running_ids_from_json(r#"{"data":[{"time":{}}]}"#), None);
        assert_eq!(running_ids_from_json(r#"{"data":[{"id":7}]}"#), None);
        assert_eq!(running_ids_from_json(r#"{"data":[{"id":"a","time":"soon"}]}"#), None);
        assert_eq!(running_ids_from_json(r#"{"data":[{"id":"a","time":{"busy":"now"}}]}"#), None);
    }

    #[test]
    fn an_answer_with_nothing_running_is_an_empty_list() {
        // The other side of the same line: the service answered, and nothing is in flight.
        assert_eq!(running_ids_from_json(r#"{"data":[]}"#), Some(Vec::new()));
        assert_eq!(
            running_ids_from_json(r#"{"data":[{"id":"a","time":{"busy":1,"idle":2}}]}"#),
            Some(Vec::new())
        );
    }

    #[test]
    fn the_service_file_sits_under_the_tools_state() {
        let path = service_file_under(std::path::Path::new("/home/x"));
        assert!(path.ends_with(".local/state/opencode/service.json"), "{path:?}");
    }

    #[test]
    fn rejects_a_remote_host_hidden_after_loopback_userinfo() {
        for url in [
            "http://127.0.0.1:42000@example.invalid:12345",
            "http://localhost:42000@example.invalid:12345",
            "http://user:secret@127.0.0.1:42000",
        ] {
            let fixture = serde_json::json!({"url": url, "password": "synthetic-password"});
            assert!(endpoint_from_json(&fixture.to_string()).is_none(), "{url}");
        }
    }

    #[test]
    fn rejects_overrides_of_the_session_endpoint() {
        for url in [
            "http://127.0.0.1:42000/other",
            "http://127.0.0.1:42000?token=unused",
            "http://127.0.0.1:42000#unused",
            "http://127.0.0.1:0",
            "http://127.0.0.1:70000",
        ] {
            let fixture = serde_json::json!({"url": url, "password": "synthetic-password"});
            assert!(endpoint_from_json(&fixture.to_string()).is_none(), "{url}");
        }
    }

    #[test]
    fn does_not_read_an_oversized_service_file() {
        let file = tempfile::NamedTempFile::new().expect("service file");
        let contents = format!(
            "{}{}",
            " ".repeat(70 * 1024),
            r#"{"url":"http://127.0.0.1:42000","password":"synthetic-password"}"#
        );
        std::fs::write(file.path(), contents).expect("write fixture");
        assert!(read_endpoint(file.path()).is_none());
    }

    fn serve_response(
        status: &str,
        headers: &str,
        body: &str,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback server");
        // Only the accept loop polls: an accepted socket has to block for the request, or the
        // non-blocking flag it inherits makes the read fail with `WouldBlock`.
        listener.set_nonblocking(true).expect("nonblocking accept");
        let address = listener.local_addr().expect("server address");
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept test request: {error}"),
                }
            };
            stream
                .set_nonblocking(false)
                .expect("blocking request read");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("request timeout");
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while request.len() < 8192 {
                let count = stream.read(&mut buffer).expect("read request");
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8(request).expect("HTTP request text")
        });
        (format!("http://{address}"), handle)
    }

    fn service_fixture(url: &str) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().expect("service file");
        let contents = serde_json::json!({"url": url, "password": "secret"});
        std::fs::write(file.path(), contents.to_string()).expect("write service fixture");
        file
    }

    #[tokio::test]
    async fn authenticates_only_the_validated_session_request() {
        let (url, server) = serve_response(
            "200 OK",
            "Content-Type: application/json\r\n",
            r#"{"data":[{"id":"ses_running","time":{"busy":200,"idle":100}}]}"#,
        );
        let fixture = service_fixture(&url);
        let ids = running_ids(fixture.path()).await;
        let request = server.join().expect("server completed");
        assert_eq!(ids, Some(vec!["ses_running".to_string()]));
        assert!(request.starts_with("GET /api/session HTTP/1.1\r\n"));
        let auth = request.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("authorization").then_some(value.trim())
        });
        assert_eq!(auth, Some("Basic b3BlbmNvZGU6c2VjcmV0"));
    }

    #[tokio::test]
    async fn does_not_follow_a_service_redirect() {
        let target = std::net::TcpListener::bind("127.0.0.1:0").expect("redirect target");
        target.set_nonblocking(true).expect("nonblocking target");
        let location = format!(
            "Location: http://{}/api/session\r\n",
            target.local_addr().expect("target address")
        );
        let (url, server) = serve_response("302 Found", &location, "");
        let fixture = service_fixture(&url);
        let ids = running_ids(fixture.path()).await;
        server.join().expect("server completed");
        assert_eq!(ids, None);
        let error = target.accept().expect_err("no redirected connection");
        assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    }

    #[tokio::test]
    async fn a_malformed_service_response_is_not_an_idle_answer() {
        for body in ["not json", r#"{"data":"wrong"}"#] {
            let (url, server) = serve_response("200 OK", "", body);
            let fixture = service_fixture(&url);
            let ids = running_ids(fixture.path()).await;
            server.join().expect("server completed");
            assert_eq!(ids, None);
        }
    }

    #[tokio::test]
    async fn an_oversized_service_response_is_no_answer() {
        let body = format!("{}{{\"data\":[]}}", " ".repeat(4 * 1024 * 1024 + 1));
        let (url, server) = serve_response("200 OK", "", &body);
        let fixture = service_fixture(&url);
        let ids = running_ids(fixture.path()).await;
        server.join().expect("server completed");
        assert_eq!(ids, None);
    }
}
