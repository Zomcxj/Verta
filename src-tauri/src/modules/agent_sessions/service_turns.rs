//! Whether an opencode session is in the middle of a turn, asked of the service that runs it.
//!
//! The session list marks a session that has nobody looking at it, and the only signal it had was
//! "this session's store was written to recently". That is right most of the time and wrong exactly
//! when it matters: a long tool call writes nothing for minutes, so a session that is plainly
//! working reads as finished.
//!
//! opencode runs a background service to hold its sessions, and that service answers the question
//! directly: `GET /api/session/active` returns the sessions it currently has running, and its own
//! contract says "Sessions absent from the result are inactive". That is the whole point of asking
//! instead of guessing, so this module reads that and nothing else.
//!
//! It used to read the times on `/api/session` instead - `busy` when a turn started, `idle` when one
//! ended - and compare them. Measured on this machine (2026-11-03), those stamps are not reliable
//! enough to answer it: a session that was staying at its prompt had `busy` later than `idle`, so it
//! read as running, and adding an `outcome` check to silence it was worse - the session the active
//! endpoint called running *also* carried `outcome: "succeeded"`, so that check would have hidden a
//! turn in flight. There is no reading of the stamps that gets both cases right, which is why the
//! endpoint exists.
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

/// `/api/session/active` is a map of the running sessions, well inside this.
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

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

/// Where a tool keeps the record of how to reach its service.
///
/// `home` is this machine's home directory for a local read; a distro's service file is the same
/// relative path inside it and is read by the caller with whatever mechanism reaches that
/// filesystem.
pub fn service_file_under(home: &std::path::Path) -> PathBuf {
    home.join(SERVICE_FILE)
}

/// The sessions this service says it is running right now.
///
/// `GET /api/session/active` is the service's own answer to this question, and its contract is
/// explicit: "Sessions absent from the result are inactive". So unlike the paged `/api/session`,
/// this map is the whole answer - a session missing from it is one the service is not running, not
/// one that fell past a page boundary.
///
/// Returns `None` when the question could not be asked at all - no `service.json`, a service that is
/// not listening, an answer that is not the shape this endpoint returns. That is deliberately
/// distinct from `Some(vec![])`: the first leaves the caller's write times in charge, the second is
/// the service saying nothing is running. A stopped service is the common case of the first, and it
/// must not unmark every row.
///
/// The read is local: the service only listens on the loopback interface, and the password in
/// `service.json` opens that one service.
pub async fn running_ids(state_dir: &std::path::Path) -> Option<Vec<String>> {
    let endpoint = read_endpoint(state_dir)?;
    // Before the client is built: reqwest here has no bundled TLS provider, so a client built
    // without one fails and the failure would read as "the service said nothing".
    crate::modules::tls::ensure_crypto_provider();
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
        .get(format!("{}/api/session/active", endpoint.url))
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
    active_ids_from_json(std::str::from_utf8(&body).ok()?)
}

/// The ids in `/api/session/active`'s answer.
///
/// The payload is `{"data": {"<session id>": {"type": "running"}}}` - a map, so the ids are its
/// keys. `None` when that is not the shape, which the caller keeps apart from an empty map: an
/// answer nobody can read must leave the write times in charge rather than unmark every row.
pub fn active_ids_from_json(text: &str) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let map = value.get("data")?.as_object()?;
    let mut ids = Vec::with_capacity(map.len());
    for (id, entry) in map {
        // Every entry is an active session by contract; the `type` is checked so a payload that
        // carries something else is refused rather than read as running.
        if entry.get("type")?.as_str()? != "running" {
            return None;
        }
        ids.push(id.clone());
    }
    Some(ids)
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
    fn reads_the_running_sessions_out_of_the_active_endpoint() {
        // The shape `/api/session/active` actually returns: a map keyed by session id.
        let body = r#"{"data":{"ses_a":{"type":"running"},"ses_b":{"type":"running"}}}"#;
        let mut ids = active_ids_from_json(body).expect("an answer");
        ids.sort();
        assert_eq!(ids, vec!["ses_a".to_string(), "ses_b".to_string()]);
    }

    #[test]
    fn an_answer_with_nothing_running_is_an_empty_list() {
        // The other side of the same line: the service answered, and nothing is in flight. This is
        // a real answer, not a failure, and it is what unmarks the rows.
        assert_eq!(active_ids_from_json(r#"{"data":{}}"#), Some(Vec::new()));
    }

    #[test]
    fn an_unreadable_answer_is_no_answer_rather_than_an_error() {
        // The list has write times to fall back on, so a broken answer must not stop it drawing,
        // and it must not read as "nothing is running" either: that would unmark every row.
        assert_eq!(active_ids_from_json(""), None);
        assert_eq!(active_ids_from_json("not json"), None);
        assert_eq!(active_ids_from_json(r#"{"data":"nope"}"#), None);
        assert_eq!(active_ids_from_json(r#"{"data":[]}"#), None);
        assert_eq!(active_ids_from_json(r#"{"data":{"ses_a":{}}}"#), None);
        assert_eq!(active_ids_from_json(r#"{"data":{"ses_a":{"type":"paused"}}}"#), None);
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
            r#"{"data":{"ses_running":{"type":"running"}}}"#,
        );
        let fixture = service_fixture(&url);
        let answer = running_ids(fixture.path()).await;
        let request = server.join().expect("server completed");
        assert_eq!(answer, Some(vec!["ses_running".to_string()]));
        assert!(request.starts_with("GET /api/session/active HTTP/1.1\r\n"));
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
            "Location: http://{}/api/session/active\r\n",
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
