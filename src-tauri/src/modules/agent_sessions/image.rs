//! Reads an image an agent attached to a message.
//!
//! The terminal shows such an image as a filename, because a TUI has no way to
//! hand over pixels that every terminal understands. The image itself is stored
//! inline in the message rather than written to disk, so the session database is
//! the only place the bytes exist: the picture the user sees in the terminal has
//! to be reassembled from here.
//!
//! The database holds gigabytes, so the search is narrowed before it runs. A
//! terminal's own working directory picks out the sessions opencode was started
//! in, and the index on that table turns reading one session's messages into a
//! scan of a few hundred rows.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{params, Connection};
use serde_json::Value;

use super::opencode::{default_db_path, open_read_only};

/// Messages read before giving up on one query.
const MATCH_LIMIT: i64 = 4;

/// Sessions considered for one directory, newest first. The terminal shows an
/// image attached in a recent message, so the newest sessions are the ones
/// worth reading.
const SESSION_LIMIT: i64 = 8;

/// The message table opencode 2.0 writes. The older `message` and `part` tables
/// hold nothing on a migrated database.
const TABLE: &str = "session_message";

/// Sessions live here since opencode 2.0; an older database has no such table
/// and falls through to the whole-table search.
const SESSIONS: &str = "session_v2";

/// Returns a data URL for the image the terminal names, or `None` when the name
/// matches nothing. A miss is not an error: the name may have been truncated
/// beyond recognition, and the caller's fallback is to leave the terminal as it
/// was.
///
/// `directory` is the terminal's working directory, used only to narrow the
/// search.
pub(crate) fn data_url_by_name(
    name: &str,
    directory: Option<&str>,
    skip: usize,
) -> Result<Option<String>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let path = default_db_path().ok_or("找不到用户主目录，无法定位 opencode 数据库")?;
    lookup(&path, trimmed, directory, skip)
}

/// How far back the whole-table search looks. Every lookup reasons about a
/// picture the terminal is showing right now, so the message that attached it
/// is recent; bounding the search this way keeps a name that matches nothing
/// from scanning gigabytes, which measured ten seconds.
const FALLBACK_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn lookup(
    path: &Path,
    name: &str,
    directory: Option<&str>,
    skip: usize,
) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Err(format!(
            "这台机器上没有 opencode 数据库：{}。",
            path.display()
        ));
    }
    let conn = open_read_only(path)?;
    let patterns = name_patterns(name);
    // One more than asked for: the wanted one is the last of them.
    let wanted = skip + 1;
    let mut found: Vec<Attachment> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(directory) = directory.map(normalize_directory) {
        for session in sessions_for_directory(&conn, &directory) {
            for pattern in &patterns {
                search_in_session(&conn, &session, pattern, name, wanted, &mut found, &mut seen)?;
                if found.len() >= wanted {
                    return Ok(found.into_iter().nth(skip).map(|entry| entry.url));
                }
            }
        }
    }
    // Either the terminal is somewhere no session was started, or the image
    // belongs to a session older than the ones consulted above.
    let since = now_millis() - FALLBACK_WINDOW_MS;
    for pattern in &patterns {
        search_recent(&conn, pattern, name, since, wanted, &mut found, &mut seen)?;
        if found.len() >= wanted {
            break;
        }
    }
    Ok(found.into_iter().nth(skip).map(|entry| entry.url))
}

/// One attachment found in the database.
struct Attachment {
    url: String,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// opencode records the directory it was started in with forward slashes, while
/// a terminal reports the platform's own form.
fn normalize_directory(directory: &str) -> String {
    let slashed = directory.replace('\\', "/");
    let trimmed = slashed.trim_end_matches('/');
    if trimmed.is_empty() {
        slashed
    } else {
        trimmed.to_string()
    }
}

/// Sessions opencode was started in this directory, newest first. Failures are
/// not reported: a database too old to have the table simply narrows nothing.
fn sessions_for_directory(conn: &Connection, directory: &str) -> Vec<String> {
    let sql = format!(
        "SELECT id FROM {SESSIONS} WHERE directory = ?1 ORDER BY time_updated DESC LIMIT {SESSION_LIMIT}"
    );
    let Ok(mut statement) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let Ok(mut rows) = statement.query(params![directory]) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    while let Ok(Some(row)) = rows.next() {
        if let Ok(id) = row.get::<_, String>(0) {
            sessions.push(id);
        }
    }
    sessions
}

/// Messages of one session, newest first. Reading through the session index
/// measured an order of magnitude faster than walking the whole table.
fn search_in_session(
    conn: &Connection,
    session: &str,
    pattern: &str,
    name: &str,
    wanted: usize,
    found: &mut Vec<Attachment>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let sql = format!(
        "SELECT id, data FROM {TABLE} WHERE session_id = ?1 AND data LIKE ?2 ESCAPE '\\' \
         ORDER BY time_created DESC LIMIT {MATCH_LIMIT}"
    );
    collect(conn, &sql, params![session, pattern], name, wanted, found, seen)
}

/// Messages written since a cut-off, newest first. The range uses the index on
/// `time_created`, so this reads a bounded slice of the table rather than
/// walking all of it.
fn search_recent(
    conn: &Connection,
    pattern: &str,
    name: &str,
    since: i64,
    wanted: usize,
    found: &mut Vec<Attachment>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let sql = format!(
        "SELECT id, data FROM {TABLE} WHERE time_created >= ?1 AND data LIKE ?2 ESCAPE '\\' \
         ORDER BY time_created DESC LIMIT {MATCH_LIMIT}"
    );
    collect(conn, &sql, params![since, pattern], name, wanted, found, seen)
}

fn collect<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    parameters: P,
    name: &str,
    wanted: usize,
    found: &mut Vec<Attachment>,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let mut statement = match conn.prepare(sql) {
        Ok(statement) => statement,
        // A database old enough to have no such table simply has no image.
        Err(_) => return Ok(()),
    };
    let mut rows = statement
        .query(parameters)
        .map_err(|e| format!("读取 opencode 消息失败：{e}"))?;
    while found.len() < wanted {
        let Some(row) = rows
            .next()
            .map_err(|e| format!("读取 opencode 消息失败：{e}"))?
        else {
            break;
        };
        let message: String = row
            .get(0)
            .map_err(|e| format!("读取 opencode 消息失败：{e}"))?;
        if seen.contains(&message) {
            continue;
        }
        seen.insert(message.clone());
        let raw: String = row
            .get(1)
            .map_err(|e| format!("读取 opencode 消息失败：{e}"))?;
        for url in extract(&raw, name) {
            found.push(Attachment { url });
        }
    }
    Ok(())
}

/// Match patterns for the stored JSON, most specific first. The terminal can
/// only show as many columns as it has, so the printed text is often just the
/// end of the stored name; the reverse is possible in principle too. `LIKE`
/// treats `%` and `_` as wildcards and screenshot names are full of
/// underscores, so both are escaped.
fn name_patterns(name: &str) -> Vec<String> {
    let escaped = escape_like(name);
    vec![
        format!("%\"name\":\"{escaped}\"%"),
        format!("%\"name\":\"%{escaped}\"%"),
        format!("%\"name\":\"{escaped}%\""),
    ]
}

fn escape_like(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(character, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// Pulls the attachment out of one message. A message can hold several images,
/// so the entry is chosen by name rather than by position.
fn extract(raw: &str, name: &str) -> Vec<String> {
    let Ok(message) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(files) = message.get("files").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    for file in files {
        let Some(candidate) = file.get("name").and_then(Value::as_str) else {
            continue;
        };
        if !name_matches(candidate, name) {
            continue;
        }
        let Some(data) = file.get("data").and_then(Value::as_str) else {
            continue;
        };
        // A picture whose format nothing here can name is not drawn: the mosaic the terminal already
        // reserved stays as it is, which is that terminal's own way of showing a picture, rather than
        // a `data:` URL the browser will fail to decode.
        let Some(mime) = mime_of(data) else {
            continue;
        };
        urls.push(format!("data:{mime};base64,{data}"));
    }
    urls
}

/// The printed name can be a prefix or a suffix of the stored one, depending on
/// which end the terminal ran out of columns for.
fn name_matches(candidate: &str, name: &str) -> bool {
    candidate == name || candidate.starts_with(name) || candidate.ends_with(name)
}

/// The head of the base64 is enough to name the format, so no separate mime
/// field is needed.
///
/// A format this does not recognize answers `None` rather than `image/png`: a
/// `data:` URL is not sniffed by the browser, so naming bytes a PNG that are not
/// one drew a broken picture where there was simply no picture to draw - and a
/// broken picture reads as a bug in the pane rather than as a format nothing here
/// decodes. `.bmp` is the case this was found on: the terminal lists it, nothing
/// named it, every BMP came out as a broken PNG.
fn mime_of(base64: &str) -> Option<&'static str> {
    if base64.starts_with("iVBOR") {
        Some("image/png")
    } else if base64.starts_with("/9j/") {
        Some("image/jpeg")
    } else if base64.starts_with("R0lGOD") {
        Some("image/gif")
    } else if base64.starts_with("UklGR") {
        Some("image/webp")
    } else if base64.starts_with("Qk") {
        // `BM`, the two bytes every bitmap starts with.
        Some("image/bmp")
    } else if base64.starts_with("AAAB") {
        // `00 00 01 00`, an icon's header.
        Some("image/x-icon")
    } else if base64.starts_with("AAAAIGZ0eXBhdmlm") {
        // `00 00 00 20 ftyp avif`: an AVIF's own box. A file whose box is another size is not
        // matched, and is refused rather than guessed at.
        Some("image/avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_HEAD: &str = "iVBORw0KGgoAAAANSUhEUg";
    const JPEG_HEAD: &str = "/9j/4AAQSkZJRgABAQ";

    #[test]
    fn the_format_is_read_off_the_bytes() {
        // Measured heads: a PNG, a JPEG, a GIF, a WebP, a bitmap (`BM`), an icon (`00 00 01 00`) and
        // an AVIF (`00 00 00 20 ftyp avif`).
        assert_eq!(mime_of(PNG_HEAD), Some("image/png"));
        assert_eq!(mime_of(JPEG_HEAD), Some("image/jpeg"));
        assert_eq!(mime_of("R0lGODlhAQABAIAAAP"), Some("image/gif"));
        assert_eq!(mime_of("UklGRiQAAABXRUJQ"), Some("image/webp"));
        assert_eq!(mime_of("Qk1mAAAAAAAAADYAAAAo"), Some("image/bmp"));
        assert_eq!(mime_of("AAABAAEAAQEAAAEAIAAw"), Some("image/x-icon"));
        assert_eq!(mime_of("AAAAIGZ0eXBhdmlmAAAAAG1p"), Some("image/avif"));
    }

    #[test]
    fn a_format_nothing_names_is_refused_rather_than_called_a_png() {
        // The bytes of a TIFF, and a string that is not an image at all. Naming these `image/png` is
        // what drew a broken picture: a `data:` URL is not sniffed by the browser.
        assert_eq!(mime_of("SUkqAAgAAAAA"), None);
        assert_eq!(mime_of("JVBERi0xLjQ"), None);
        assert_eq!(mime_of(""), None);
    }
    const DIRECTORY: &str = "F:/VibeCoding_workspace/Verta";

    fn temp_db() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("opencode.db");
        let conn = Connection::open(&path).expect("open");
        conn.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                parent_id TEXT,
                title TEXT,
                directory TEXT NOT NULL,
                time_updated INTEGER NOT NULL
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .expect("create tables");
        (dir, path)
    }

    fn insert_session(path: &Path, id: &str, directory: &str, time_updated: i64) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO session_v2 (id, directory, time_updated) VALUES (?1, ?2, ?3)",
            params![id, directory, time_updated],
        )
        .expect("insert session");
    }

    fn insert_message(path: &Path, id: &str, session: &str, time_created: i64, data: &str) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO session_message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            params![id, session, time_created, data],
        )
        .expect("insert message");
    }

    fn attachment(name: &str, head: &str) -> String {
        format!(
            "{{\"text\":\"[Image 1]\",\"files\":[{{\"name\":\"{name}\",\"data\":\"{head}AAAA\"}}]}}"
        )
    }

    fn png() -> String {
        format!("data:image/png;base64,{PNG_HEAD}AAAA")
    }

    #[test]
    fn returns_the_attachment_named_by_the_terminal() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(&path, "m1", "ses_1", 10, &attachment("图片 131455.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "图片 131455.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
    }

    #[test]
    fn reads_the_session_the_terminal_is_in() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_here", DIRECTORY, 10);
        insert_session(&path, "ses_elsewhere", "F:/other", 20);
        insert_message(&path, "m1", "ses_here", 10, &attachment("图 131455.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "图 131455.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
    }

    #[test]
    fn prefers_the_newest_message_of_the_session() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(&path, "old", "ses_1", 10, &attachment("图 131455.png", JPEG_HEAD));
        insert_message(&path, "new", "ses_1", 20, &attachment("图 131455.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "图 131455.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
    }

    #[test]
    fn reads_recent_messages_when_the_directory_matches_no_session() {
        let (_dir, path) = temp_db();
        let now = now_millis();
        insert_session(&path, "ses_elsewhere", "F:/other", now);
        insert_message(&path, "m1", "ses_elsewhere", now, &attachment("图 131455.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "图 131455.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
    }

    #[test]
    fn stops_at_the_fallback_window_rather_than_reading_the_whole_table() {
        let (_dir, path) = temp_db();
        let old = now_millis() - FALLBACK_WINDOW_MS - 60_000;
        insert_message(&path, "m1", "ses_elsewhere", old, &attachment("图 131455.png", PNG_HEAD));
        assert_eq!(lookup(&path, "图 131455.png", None, 0).expect("lookup"), None);
    }

    #[test]
    fn matches_a_windows_style_directory() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(&path, "m1", "ses_1", 10, &attachment("图 131455.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "图 131455.png", Some(r"F:\VibeCoding_workspace\Verta\"), 0)
                .expect("lookup"),
            Some(png())
        );
    }

    #[test]
    fn treats_underscores_in_a_name_as_literal_characters() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(&path, "m1", "ses_1", 10, &attachment("局部截取_20261018.png", JPEG_HEAD));
        insert_message(&path, "m2", "ses_1", 20, &attachment("局部X截取X20261018.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "局部截取_20261018.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(format!("data:image/jpeg;base64,{JPEG_HEAD}AAAA"))
        );
    }

    #[test]
    fn finds_an_image_whose_printed_name_was_truncated() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(
            &path,
            "m1",
            "ses_1",
            10,
            &attachment("截取_前面这半截在窄终端里看不到_20261018_153945.png", PNG_HEAD),
        );
        assert_eq!(
            lookup(&path, "20261018_153945.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
    }

    #[test]
    fn counts_the_same_name_from_the_newest_attachment() {
        // Images pasted from the clipboard are all called `clipboard`, so a
        // name alone does not say which one the terminal is showing.
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(&path, "old", "ses_1", 10, &attachment("clipboard", JPEG_HEAD));
        insert_message(&path, "new", "ses_1", 20, &attachment("clipboard", PNG_HEAD));
        assert_eq!(
            lookup(&path, "clipboard", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
        assert_eq!(
            lookup(&path, "clipboard", Some(DIRECTORY), 1).expect("lookup"),
            Some(format!("data:image/jpeg;base64,{JPEG_HEAD}AAAA"))
        );
        assert_eq!(lookup(&path, "clipboard", Some(DIRECTORY), 2).expect("lookup"), None);
    }

    #[test]
    fn counts_each_picture_of_one_message_separately() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        let data = format!(
            "{{\"text\":\"[Image 1] [Image 2]\",\"files\":[\
             {{\"name\":\"clipboard\",\"data\":\"{PNG_HEAD}AAAA\"}},\
             {{\"name\":\"clipboard\",\"data\":\"{JPEG_HEAD}BBBB\"}}]}}"
        );
        insert_message(&path, "m1", "ses_1", 10, &data);
        assert_eq!(
            lookup(&path, "clipboard", Some(DIRECTORY), 0).expect("lookup"),
            Some(png())
        );
        assert_eq!(
            lookup(&path, "clipboard", Some(DIRECTORY), 1).expect("lookup"),
            Some(format!("data:image/jpeg;base64,{JPEG_HEAD}BBBB"))
        );
    }

    #[test]
    fn picks_the_matching_entry_when_a_message_holds_several_images() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        let data = format!(
            "{{\"text\":\"[Image 1] [Image 2]\",\"files\":[\
             {{\"name\":\"a_20261018_153945.png\",\"data\":\"{PNG_HEAD}AAAA\"}},\
             {{\"name\":\"b_20261018_153951.png\",\"data\":\"{JPEG_HEAD}BBBB\"}}]}}"
        );
        insert_message(&path, "m1", "ses_1", 10, &data);
        assert_eq!(
            lookup(&path, "b_20261018_153951.png", Some(DIRECTORY), 0).expect("lookup"),
            Some(format!("data:image/jpeg;base64,{JPEG_HEAD}BBBB"))
        );
    }

    #[test]
    fn a_name_that_matches_nothing_is_not_an_error() {
        let (_dir, path) = temp_db();
        insert_session(&path, "ses_1", DIRECTORY, 10);
        insert_message(&path, "m1", "ses_1", 10, &attachment("a_20261018.png", PNG_HEAD));
        assert_eq!(
            lookup(&path, "b_20261018.png", Some(DIRECTORY), 0).expect("lookup"),
            None
        );
    }

    #[test]
    fn a_missing_database_is_reported() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = lookup(&dir.path().join("absent.db"), "a.png", None, 0).expect_err("error");
        // A lookup still fails: the caller asked for one image, and this says where it looked. What
        // it must not do is conclude anything about the installation; see `claude::list_at`.
        assert!(error.contains("这台机器上没有 opencode 数据库"), "{error}");
        assert!(error.contains("absent.db"), "{error}");
    }
}