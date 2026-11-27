//! Turning a comment into the one line a terminal can take.
//!
//! `pty_write` sends keyboard bytes, so a newline in the prompt is the Enter key: a
//! multi-line prompt would be submitted on its first line and the rest left in the
//! shell. Everything here keeps the result on one line, and escapes the separators a
//! reader uses to find the boundaries again.

use super::DiffComment;

/// One comment as a single line, marker included.
pub fn format_comment(comment: &DiffComment) -> String {
    format!("[git diff review] {}", format_entry(comment))
}

/// Several comments as one line: the marker once, then each note joined by ` ;; `.
///
/// The marker is not repeated per note - the spec draws it once and separates the rest -
/// so a reader takes the first marker as the start of the block and splits on ` ;; `.
pub fn format_comments(comments: &[DiffComment]) -> String {
    if comments.is_empty() {
        return String::new();
    }
    let body = comments
        .iter()
        .map(format_entry)
        .collect::<Vec<_>>()
        .join(" ;; ");
    format!("[git diff review] {body}")
}

/// One note without the marker: `File: x | Lines: 42-45 | body`.
fn format_entry(comment: &DiffComment) -> String {
    let lines = match comment.start_line {
        Some(start) if start != comment.line_number => {
            format!("Lines: {start}-{}", comment.line_number)
        }
        _ => format!("Line: {}", comment.line_number),
    };
    format!(
        "File: {} | {} | {}",
        comment.file_path,
        lines,
        escape_body(&comment.body)
    )
}

/// Keep the body on one line, and escape the separators so a reader can split again.
///
/// Order matters: backslashes first, so the ones added for `|` and `;` are not doubled.
fn escape_body(body: &str) -> String {
    body.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(';', "\\;")
        .replace("\r\n", " ")
        .replace(['\n', '\r'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::diff_comments::DiffComment;

    fn comment(file: &str, start: Option<u32>, line: u32, body: &str) -> DiffComment {
        DiffComment {
            id: format!("{file}-{line}"),
            session_id: "s".into(),
            file_path: file.into(),
            start_line: start,
            line_number: line,
            body: body.into(),
            scope: "unstaged".into(),
            sent_at: None,
        }
    }

    #[test]
    fn one_comment_is_a_single_line() {
        let c = comment("src/a.rs", Some(42), 45, "这里没处理过期");
        assert_eq!(
            format_comment(&c),
            "[git diff review] File: src/a.rs | Lines: 42-45 | 这里没处理过期"
        );
        assert!(!format_comment(&c).contains('\n'));
    }

    #[test]
    fn a_single_line_comment_says_line_not_lines() {
        let c = comment("src/a.rs", None, 42, "少了错误处理");
        assert_eq!(
            format_comment(&c),
            "[git diff review] File: src/a.rs | Line: 42 | 少了错误处理"
        );
    }

    #[test]
    fn newlines_in_the_body_become_spaces() {
        let c = comment("src/a.rs", None, 7, "第一行\n第二行");
        assert!(!format_comment(&c).contains('\n'));
        assert!(format_comment(&c).contains("第一行 第二行"));
    }

    #[test]
    fn separators_in_the_body_are_escaped() {
        let c = comment("src/a.rs", None, 7, "a | b ;; c");
        let out = format_comment(&c);
        assert!(out.contains("a \\| b \\;\\; c"), "got {out}");
    }

    #[test]
    fn several_comments_join_on_one_line() {
        // The marker appears once, at the front, and each note after it is separated by
        // ` ;; ` - the format the spec draws. The agent reads the first marker and then
        // splits on the separator.
        let out = format_comments(&[
            comment("a.rs", None, 1, "x"),
            comment("b.rs", None, 2, "y"),
        ]);
        assert!(!out.contains('\n'));
        assert_eq!(out.matches("[git diff review]").count(), 1);
        assert!(out.starts_with("[git diff review] "));
        assert!(out.contains(" ;; "));
    }
}
