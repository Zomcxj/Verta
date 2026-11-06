//! Reading a `.csv` as a table.
//!
//! A CSV file is text, so the source editor can show it - but a file of a thousand rows is not
//! something anyone reads as text. This reads it the way a spreadsheet would: the delimiter the
//! file actually uses, the encoding it was written in, and the fields as RFC 4180 defines them
//! (quotes, escaped quotes, newlines inside a field).
//!
//! The file is *not* modified by any of this: the pane draws the table, and the source stop keeps
//! editing the text.

use std::path::Path;

use serde::Serialize;
use tauri::Manager;

use super::docx::{guard_of, DocxGuard};
use super::fs::blocking;
use super::workspace::{
    authorize_parent, authorize_read, resolve_path, WorkspaceEnv, WorkspaceRegistry,
};

/// A file past this is read up to the cap and reported as truncated; a table nobody scrolls to the
/// end of is not worth a gigabyte of memory.
const MAX_CSV_BYTES: u64 = 16 * 1024 * 1024;
/// Rows and columns the pane is willing to draw. A spreadsheet with more is a database.
const MAX_ROWS: usize = 5000;
const MAX_COLUMNS: usize = 200;

/// A table read out of a file.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CsvDocument {
    /// The character the fields are separated by, as it is in the file.
    pub delimiter: String,
    /// Fields, row by row. Rows may be shorter than the widest one.
    pub rows: Vec<Vec<String>>,
    /// How many fields the widest row has, so the pane can lay out a column for each.
    pub columns: usize,
    /// Whether the file was longer than the pane will draw.
    pub truncated: bool,
    /// The file's identity when it was read, so a cell written later can check it is still the file
    /// it read rather than one somebody has changed underneath it.
    pub guard: DocxGuard,
}

/// A CSV file as a table. Read-only: nothing here writes.
#[tauri::command]
pub async fn fs_read_csv(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<CsvDocument, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_read(&app.state::<WorkspaceRegistry>(), &target)?;
        read_csv_sync(&target)
    })
    .await
}

fn read_csv_sync(path: &Path) -> Result<CsvDocument, String> {
    let meta = std::fs::metadata(path).map_err(|error| {
        log::debug!("fs_read_csv stat({}) failed: {error}", path.display());
        error.to_string()
    })?;
    let bytes = std::fs::read(path).map_err(|error| {
        log::debug!("fs_read_csv read({}) failed: {error}", path.display());
        error.to_string()
    })?;
    // A file with a BOM is UTF-8 whatever else it says; a file without one is UTF-8 unless it is
    // not, and then it is very likely one of the Chinese encodings - a `.csv` exported from Excel
    // on a Chinese system is GB18030, and read as UTF-8 every field would be a row of 分块.
    let (text, truncated_file) = decode(&bytes);
    let mut document = parse_csv(&text, truncated_file);
    document.guard = guard_of(&meta);
    Ok(document)
}

/// One cell's new text.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CsvCellWrite {
    pub row: u32,
    pub column: u32,
    pub text: String,
}

/// Change one field of a `.csv`.
///
/// Only that field's bytes are replaced: the rest of the file - its quoting, its line endings, the
/// fields nobody touched - is written back exactly as it was. Re-serializing the whole table would
/// have been easier and would have quietly rewritten every line of a file somebody had formatted.
#[tauri::command]
pub async fn fs_write_csv_cell(
    app: tauri::AppHandle,
    path: String,
    row: u32,
    column: u32,
    text: String,
    guard: DocxGuard,
    workspace: Option<WorkspaceEnv>,
) -> Result<DocxGuard, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_parent(&app.state::<WorkspaceRegistry>(), &target)?;
        write_csv_cell_sync(&target, row, column, &text, &guard)
    })
    .await
}

fn write_csv_cell_sync(
    path: &Path,
    row: u32,
    column: u32,
    value: &str,
    guard: &DocxGuard,
) -> Result<DocxGuard, String> {
    let meta = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let current = guard_of(&meta);
    if current != *guard {
        // The pane read a file that is not this one any more, and writing into it would land on
        // whatever changed it.
        return Err("文件在磁盘上被改过，没有覆盖它".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let (text, _) = decode(&bytes);
    let ranges = field_ranges(&text, detect_delimiter(&text));
    let field = ranges
        .get(row as usize)
        .and_then(|fields| fields.get(column as usize))
        .ok_or_else(|| format!("表格里没有第 {row} 行第 {column} 列"))?;
    let delimiter = detect_delimiter(&text);
    let escaped = if field.quoted {
        // Already inside quotes: only the value's own quotes have to be doubled.
        value.replace('"', "\"\"")
    } else {
        escape_field(value, delimiter)
    };
    let mut written = String::with_capacity(text.len() + escaped.len());
    written.push_str(&text[..field.start]);
    written.push_str(&escaped);
    written.push_str(&text[field.end..]);
    // The write is atomic and the guard was checked, so this cannot land on a file that moved.
    let temporary = path.with_extension("csv.tmp");
    std::fs::write(&temporary, written.as_bytes()).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    let meta = std::fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(guard_of(&meta))
}

/// The file's text, and whether it was longer than the cap.
fn decode(bytes: &[u8]) -> (String, bool) {
    let capped = bytes.len() as u64 > MAX_CSV_BYTES;
    let slice = if capped {
        &bytes[..MAX_CSV_BYTES as usize]
    } else {
        bytes
    };
    if let Ok(text) = std::str::from_utf8(slice) {
        return (text.trim_start_matches('\u{feff}').to_string(), capped);
    }
    // GB18030 is a superset of GBK, which most Chinese files actually are, and it never fails:
    // every byte sequence has an answer, so the reader does not need a second guess.
    let (text, _, _) = encoding_rs::GB18030.decode(slice);
    (text.trim_start_matches('\u{feff}').to_string(), capped)
}

/// The delimiter the file uses, by trying each one on the first line.
///
/// Counting characters is not enough - a semicolon-separated file whose only commas are inside
/// fields looks comma-separated. Parsing the first line and seeing which delimiter yields the most
/// fields does not have that problem, because a delimiter inside quotes does not split anything.
fn detect_delimiter(text: &str) -> char {
    const CANDIDATES: [char; 3] = [',', ';', '\t'];
    let line = first_line(text);
    let mut best = (',', 1usize);
    for candidate in CANDIDATES {
        let fields = split_fields(line, candidate).len();
        if fields > best.1 {
            best = (candidate, fields);
        }
    }
    best.0
}

/// The first line of the text, ending at a newline that is not inside quotes.
fn first_line(text: &str) -> &str {
    let mut quoted = false;
    for (index, character) in text.char_indices() {
        match character {
            '"' => quoted = !quoted,
            '\r' | '\n' if !quoted => return &text[..index],
            _ => {}
        }
    }
    text
}

/// One line's fields, split on `delimiter` the way RFC 4180 says.
fn split_fields(line: &str, delimiter: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' {
                // A doubled quote inside a quoted field is one quote, not the end of the field.
                if characters.peek() == Some(&'"') {
                    characters.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
        } else if character == '"' && field.is_empty() {
            quoted = true;
        } else if character == delimiter {
            fields.push(std::mem::take(&mut field));
        } else {
            field.push(character);
        }
    }
    fields.push(field);
    fields
}

/// The whole file as rows, up to the caps. A row is one record: a newline inside quotes is not one.
fn parse_csv(text: &str, truncated_file: bool) -> CsvDocument {
    let delimiter = detect_delimiter(text);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut columns = 0usize;
    let mut truncated = truncated_file;

    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if quoted {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    characters.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }
        match character {
            '"' if field.is_empty() => quoted = true,
            '\r' => {
                // A lone `\r` ends the record as well; `\r\n` is one break, not two.
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                finish_row(&mut rows, &mut row, &mut field, &mut columns);
                if rows.len() >= MAX_ROWS {
                    truncated = true;
                    break;
                }
            }
            '\n' => {
                finish_row(&mut rows, &mut row, &mut field, &mut columns);
                if rows.len() >= MAX_ROWS {
                    truncated = true;
                    break;
                }
            }
            _ if character == delimiter => {
                row.push(std::mem::take(&mut field));
                if row.len() > MAX_COLUMNS {
                    truncated = true;
                    row.truncate(MAX_COLUMNS);
                }
            }
            _ => field.push(character),
        }
    }
    // What is left is the last record when the file does not end in a newline. A file that ends
    // with one leaves nothing behind, and an empty last row is not a row.
    if !field.is_empty() || !row.is_empty() {
        finish_row(&mut rows, &mut row, &mut field, &mut columns);
    }
    CsvDocument {
        delimiter: delimiter.to_string(),
        rows,
        columns,
        truncated,
        guard: DocxGuard::default(),
    }
}

fn finish_row(
    rows: &mut Vec<Vec<String>>,
    row: &mut Vec<String>,
    field: &mut String,
    columns: &mut usize,
) {
    row.push(std::mem::take(field));
    *columns = (*columns).max(row.len());
    rows.push(std::mem::take(row));
}

/// One field's content, by byte offset into the file's text (quotes excluded, since they are the
/// file's and not the value's).
#[derive(Debug, PartialEq, Eq, Clone)]
struct FieldRange {
    start: usize,
    end: usize,
    /// Whether the file had this field in quotes. The quotes are the file's: they stay, and what
    /// goes between them is the value with any quote of its own doubled.
    quoted: bool,
}

/// Where each field's content starts and ends, row by row.
fn field_ranges(text: &str, delimiter: char) -> Vec<Vec<FieldRange>> {
    let mut rows: Vec<Vec<FieldRange>> = Vec::new();
    let mut row: Vec<FieldRange> = Vec::new();
    let mut start: Option<usize> = None;
    // Where a quoted value ended: the closing quote is the file's, so the value stops in front of it.
    let mut end: Option<usize> = None;
    let mut quoted = false;
    let mut characters = text.char_indices().peekable();
    while let Some((index, character)) = characters.next() {
        if quoted {
            if character == '"' {
                if characters.peek().map(|(_, next)| *next) == Some('"') {
                    // A doubled quote is part of the value, so the value's range keeps growing.
                    characters.next();
                    start.get_or_insert(index);
                } else {
                    quoted = false;
                    end = Some(index);
                }
            } else {
                start.get_or_insert(index);
            }
            continue;
        }
        match character {
            '"' if start.is_none() => quoted = true,
            '\r' | '\n' => {
                if character == '\r' && characters.peek().map(|(_, next)| *next) == Some('\n') {
                    characters.next();
                }
                row.push(FieldRange {
                    start: start.unwrap_or(index),
                    end: end.unwrap_or(index),
                    quoted: end.is_some(),
                });
                rows.push(std::mem::take(&mut row));
                start = None;
                end = None;
            }
            _ if character == delimiter => {
                row.push(FieldRange {
                    start: start.unwrap_or(index),
                    end: end.unwrap_or(index),
                    quoted: end.is_some(),
                });
                start = None;
                end = None;
            }
            _ => {
                start.get_or_insert(index);
            }
        }
    }
    if start.is_some() || !row.is_empty() {
        row.push(FieldRange {
            start: start.unwrap_or(text.len()),
            end: end.unwrap_or(text.len()),
            quoted: end.is_some(),
        });
        rows.push(row);
    }
    rows
}

/// A value as a field: quoted only when it has to be.
fn escape_field(value: &str, delimiter: char) -> String {
    let needs_quotes = value.contains(delimiter)
        || value.contains('"')
        || value.contains('\n')
        || value.contains('\r');
    if needs_quotes {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_comma_file_reads_field_by_field() {
        let table = parse_csv("a,b,c\n1,2,3\n", false);
        assert_eq!(table.delimiter, ",");
        assert_eq!(
            table.rows,
            vec![
                vec!["a".to_string(), "b".into(), "c".into()],
                vec!["1".to_string(), "2".into(), "3".into()],
            ]
        );
        assert_eq!(table.columns, 3);
        assert!(!table.truncated);
    }

    #[test]
    fn a_semicolon_file_is_not_read_as_one_column() {
        // The usual export from a machine with a comma for a decimal separator. Counting either
        // character would call this file comma-separated; parsing the first line does not.
        let table = parse_csv("name;price\nPonytail;0,5\n", false);
        assert_eq!(table.delimiter, ";");
        assert_eq!(table.rows[0], vec!["name".to_string(), "price".into()]);
        assert_eq!(table.rows[1], vec!["Ponytail".to_string(), "0,5".into()]);
    }

    #[test]
    fn a_tab_file_is_read_as_tab_separated() {
        let table = parse_csv("a\tb\n1\t2\n", false);
        assert_eq!(table.delimiter, "\t");
        assert_eq!(table.rows[0].len(), 2);
    }

    #[test]
    fn a_quoted_field_keeps_its_commas_quotes_and_newlines() {
        let table = parse_csv("\"a,b\",\"say \"\"hi\"\"\",\"two\nlines\"\n", false);
        assert_eq!(table.delimiter, ",");
        assert_eq!(
            table.rows[0],
            vec!["a,b".to_string(), "say \"hi\"".into(), "two\nlines".into()]
        );
        // One record, not two: the newline is inside the quotes.
        assert_eq!(table.rows.len(), 1);
    }

    #[test]
    fn a_carriage_return_is_a_row_break_on_its_own() {
        let table = parse_csv("a,b\r1,2\r\n", false);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[1], vec!["1".to_string(), "2".into()]);
    }

    #[test]
    fn the_last_row_does_not_need_a_newline() {
        let table = parse_csv("a,b\n1,2", false);
        assert_eq!(table.rows.len(), 2);
        assert_eq!(table.rows[1], vec!["1".to_string(), "2".into()]);
        // A file ending *with* a newline does not grow an empty last row.
        assert_eq!(parse_csv("a,b\n1,2\n", false).rows.len(), 2);
    }

    #[test]
    fn a_short_row_does_not_invent_fields_but_the_width_is_remembered() {
        let table = parse_csv("a,b,c\n1\n", false);
        assert_eq!(table.rows[1], vec!["1".to_string()]);
        assert_eq!(table.columns, 3);
    }

    #[test]
    fn a_file_written_in_gb18030_reads_as_text() {
        // "姓名,价格" in GB18030, which is what Excel writes on a Chinese Windows.
        let bytes: Vec<u8> = vec![0xD0, 0xD5, 0xC3, 0xFB, b',', 0xBC, 0xDB, 0xB8, 0xF1, b'\n'];
        let (text, truncated) = decode(&bytes);
        assert!(!truncated);
        assert!(text.starts_with("姓名,价格"), "{text}");
        let table = parse_csv(&text, false);
        assert_eq!(table.rows[0], vec!["姓名".to_string(), "价格".into()]);
    }

    #[test]
    fn a_utf8_bom_does_not_become_part_of_the_first_field() {
        let bytes = "\u{feff}a,b\n".as_bytes();
        let (text, _) = decode(bytes);
        assert_eq!(parse_csv(&text, false).rows[0][0], "a");
    }

    #[test]
    fn an_empty_file_is_an_empty_table() {
        let table = parse_csv("", false);
        assert!(table.rows.is_empty());
        assert_eq!(table.columns, 0);
    }

    /// One field's content, as the writer would find it, for the tests below.
    fn range_of(text: &str, row: usize, column: usize) -> (usize, usize) {
        let field = field_ranges(text, detect_delimiter(text))[row][column].clone();
        (field.start, field.end)
    }

    #[test]
    fn the_ranges_point_at_the_fields_own_text() {
        // The quotes are the file's, not the value's: what is replaced is between them.
        let text = "a,\"b,c\",d\n1,2,3\n";
        let (start, end) = range_of(text, 0, 1);
        assert_eq!(&text[start..end], "b,c");
        let (start, end) = range_of(text, 1, 2);
        assert_eq!(&text[start..end], "3");
        // An empty field is a range at the place it would be, not an error.
        let (start, end) = range_of("a,,b\n", 0, 1);
        assert_eq!(start, end);
    }

    #[test]
    fn a_value_is_quoted_only_when_it_has_to_be() {
        assert_eq!(escape_field("plain", ','), "plain");
        assert_eq!(escape_field("a,b", ','), "\"a,b\"");
        assert_eq!(escape_field("say \"hi\"", ','), "\"say \"\"hi\"\"\"");
        assert_eq!(escape_field("two\nlines", ','), "\"two\nlines\"");
        // The delimiter the file actually uses is what matters: a semicolon file keeps a comma.
        assert_eq!(escape_field("0,5", ';'), "0,5");
    }

    #[test]
    fn writing_a_cell_leaves_every_other_byte_where_it_was() {
        let dir = std::env::temp_dir().join(format!("verta-csv-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("cells.csv");
        // A quoted field, an empty one, CRLF, and no newline at the end: all of it has to come back.
        let original = "a,\"b,c\",\r\n1,,3";
        std::fs::write(&file, original).unwrap();
        let guard = super::guard_of(&std::fs::metadata(&file).unwrap());
        // The empty field of the second row: filled in, with the quoted field beside it untouched.
        write_csv_cell_sync(&file, 1, 1, "B", &guard).expect("the cell should be written");
        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, "a,\"b,c\",\r\n1,B,3");

        // A value with a comma of its own is quoted, and the quotes already around the field stay.
        let guard = super::guard_of(&std::fs::metadata(&file).unwrap());
        write_csv_cell_sync(&file, 0, 1, "say \"hi\", ok", &guard).expect("the cell should be written");
        let after = std::fs::read_to_string(&file).unwrap();
        assert_eq!(after, "a,\"say \"\"hi\"\", ok\",\r\n1,B,3");
        assert_eq!(parse_csv(&after, false).rows[0][1], "say \"hi\", ok");
        assert_eq!(parse_csv(&after, false).rows[1][1], "B");

        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn a_field_that_is_out_of_range_is_refused() {
        let dir = std::env::temp_dir().join(format!("verta-csv-range-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("short.csv");
        std::fs::write(&file, "a,b\n").unwrap();
        let guard = super::guard_of(&std::fs::metadata(&file).unwrap());
        let error = write_csv_cell_sync(&file, 9, 0, "x", &guard).unwrap_err();
        assert!(error.contains("9"), "{error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a,b\n");
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn a_file_that_changed_underneath_is_not_written() {
        let dir = std::env::temp_dir().join(format!("verta-csv-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("moved.csv");
        std::fs::write(&file, "a,b\n").unwrap();
        let guard = super::guard_of(&std::fs::metadata(&file).unwrap());
        // Somebody else writes the file: the identity the pane read is no longer this one, and the
        // cell would land in a table that has moved.
        std::fs::write(&file, "a,b\nc,d\n").unwrap();
        let error = write_csv_cell_sync(&file, 0, 1, "B", &guard).unwrap_err();
        assert!(error.contains("磁盘"), "{error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "a,b\nc,d\n");
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn a_file_longer_than_the_cap_says_so() {
        let mut text = String::new();
        for index in 0..MAX_ROWS + 10 {
            text.push_str(&format!("row{index},x\n"));
        }
        let table = parse_csv(&text, false);
        assert!(table.truncated);
        assert_eq!(table.rows.len(), MAX_ROWS);
    }
}
