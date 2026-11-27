//! Diff comments: what a reviewer wrote on a diff line, and the single line it becomes
//! for a terminal.
//!
//! A comment is working state, not a project file, so it lives under the app's config
//! directory rather than in the repository - putting it in the tree would show up in
//! `git status` and would not travel with the code anyway.

pub mod format;

pub use format::{format_comment, format_comments};

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::modules::workspace::WorkspaceRegistry;

/// One review note anchored to a line of a diff.
///
/// `start_line` is the beginning of a range and `line_number` its end; a note on one
/// line has `start_line` equal to `line_number` or `None`. The camelCase wire form is
/// the project's convention (`agent_sessions/types.rs`), so the frontend reads
/// `sessionId` / `filePath` / `startLine` / `lineNumber` / `sentAt`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffComment {
    pub id: String,
    /// Which session the note is for; also names the file it is stored in.
    pub session_id: String,
    pub file_path: String,
    /// Beginning of the range, when the note covers more than one line.
    pub start_line: Option<u32>,
    /// The line the note is anchored to, and the end of the range when there is one.
    pub line_number: u32,
    pub body: String,
    /// Which diff the line was read from: `"unstaged" | "staged" | "branch"`.
    pub scope: String,
    /// Set once the note has been sent to the agent, so it can be shown as sent.
    pub sent_at: Option<i64>,
}

/// Where diff comments live: `<app config dir>/diff-comments`, created and authorised
/// on first use.
///
/// The grant is the point: the ordinary write commands need the folder to be an
/// authorized parent, and a folder that has never been seen is not one. Same reason as
/// `themes_dir` in `workspace.rs`.
fn diff_comments_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = Manager::path(app)
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("diff-comments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Manager::state::<WorkspaceRegistry>(app)
        .authorize(&dir)
        .map_err(|e| e.to_string())
}

/// The file one session's comments are stored in, from the session id alone.
///
/// The id names the file, so it has to be exactly one safe component: a traversal or a
/// separator would write outside the folder.
fn file_for(session_id: &str) -> Result<String, String> {
    let id = session_id.trim();
    let usable = !id.is_empty()
        && id.len() <= 200
        && id != "."
        && id != ".."
        && !id.contains("..")
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if !usable {
        return Err(format!("invalid session id: {session_id:?}"));
    }
    Ok(format!("{id}.json"))
}

/// A file that is not there yet is no comments, not an error; text that is there but is
/// not JSON is an error, because silently dropping it would lose the user's notes.
fn parse_or_empty(text: &str) -> Result<Vec<DiffComment>, serde_json::Error> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(text)
}

/// Write through a temp file in the same directory and rename, so a crash mid-write
/// cannot leave a half-written JSON that `parse_or_empty` then rejects forever. The
/// same rule `fs::file::write_atomic` follows for editor saves.
fn write_atomic(target: &std::path::Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = target.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has no parent")
    })?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.as_file_mut().write_all(content)?;
    tmp.as_file_mut().sync_all()?;
    tmp.persist(target).map_err(|error| error.error)?;
    Ok(())
}

/// The folder diff comments are written to, created and authorised.
#[tauri::command]
pub async fn diff_comments_dir(app: AppHandle) -> Result<String, String> {
    crate::modules::fs::blocking(move || {
        let canonical = diff_comments_path(&app)?;
        Ok(crate::modules::fs::to_canon(&canonical))
    })
    .await
}

/// Every comment stored for a session.
#[tauri::command]
pub async fn diff_comments_list(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<DiffComment>, String> {
    crate::modules::fs::blocking(move || {
        let dir = diff_comments_path(&app)?;
        let file = dir.join(file_for(&session_id)?);
        let text = match std::fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.to_string()),
        };
        parse_or_empty(&text).map_err(|e| e.to_string())
    })
    .await
}

/// Replace a session's stored comments with `comments`.
#[tauri::command]
pub async fn diff_comments_save(
    app: AppHandle,
    session_id: String,
    comments: Vec<DiffComment>,
) -> Result<(), String> {
    crate::modules::fs::blocking(move || {
        let dir = diff_comments_path(&app)?;
        let file = dir.join(file_for(&session_id)?);
        let text = serde_json::to_string_pretty(&comments).map_err(|e| e.to_string())?;
        write_atomic(&file, text.as_bytes()).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_is_derived_from_the_session_id_only() {
        assert_eq!(file_for("b282aa01-3997").unwrap(), "b282aa01-3997.json");
        assert!(file_for("../escape").is_err());
        assert!(file_for("").is_err());
        assert!(file_for("a/b").is_err());
    }

    #[test]
    fn a_missing_file_reads_as_no_comments() {
        // list() on a session with no file returns Ok(vec![]) rather than an error:
        // the caller draws an empty layer, not an error state.
        assert!(parse_or_empty("").unwrap().is_empty());
        assert!(parse_or_empty("not json").is_err());
    }
}
