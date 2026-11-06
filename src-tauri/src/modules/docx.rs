//! Word documents, read as structure rather than as a picture.
//!
//! A `.docx` is a ZIP whose `word/document.xml` holds the text. Nothing renders that natively - the
//! webview has no Word - so without a reader the editor could only report "binary file", which is
//! why this exists. The paragraphs, their headings, emphasis, lists and tables are read out of that
//! part and handed over as blocks, which the frontend draws with ordinary elements: no HTML
//! passthrough, no parser in the frontend bundle, and nothing added to the size budget.
//!
//! What this deliberately does not do: images, text boxes, footnotes, and the old `.doc` format
//! (a completely different container, OLE2 rather than ZIP). Revision marks are read as their
//! accepted text - insertions kept, deletions dropped - which is what the document says it is.

use std::io::Read;
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::name::QName;
use quick_xml::Reader;
use serde::Serialize;
use tauri::Manager;

use super::fs::blocking;
use super::workspace::{
    authorize_parent, authorize_read, resolve_path, WorkspaceEnv, WorkspaceRegistry,
};

/// The document part, inflated. A real one is a few hundred kilobytes of XML; this ceiling is what
/// a mislabeled file, or an archive built to expand, runs into.
const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
/// The numbering part is a lookup table, never a document.
const MAX_NUMBERING_BYTES: u64 = 4 * 1024 * 1024;
/// Documents are read to be looked at, and the frontend renders every block as an element; a bound
/// keeps a 10 MB file from becoming a million nodes.
const MAX_BLOCKS: usize = 20_000;

#[derive(Serialize, Debug, Default, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    /// Numbered (`decimal`, `lowerLetter`, …) rather than bulleted.
    pub ordered: bool,
    /// Nesting depth, 0 for a top-level item.
    pub level: u8,
    /// The numbering definition the paragraph asks for. Two adjacent lists with different ids are
    /// two lists, and the pane can only reset its counter between them if it knows which is which.
    pub num_id: u32,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Block {
    /// A paragraph. `heading` is the outline level it declares (1-6), `list` the numbering it
    /// carries, `runs` the styled pieces of its text.
    Paragraph {
        /// Its ordinal among the part's `<w:p>` elements; see `Paragraph::index`.
        index: u32,
        heading: Option<u8>,
        list: Option<ListItem>,
        runs: Vec<Run>,
    },
    /// Rows of cells; each cell's paragraphs are joined by a space, since a cell is one line here.
    Table { rows: Vec<Vec<String>> },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxDocument {
    pub blocks: Vec<Block>,
    /// Reading a Word file is lossy here; when something was dropped the frontend can say so rather
    /// than pretend the document ended.
    pub truncated: bool,
    /// Whether the pane may edit this document in place.
    pub editable: bool,
    /// The file's identity at the moment it was read, which the writer checks before replacing it.
    pub guard: DocxGuard,
}

/// Whether a document can be written back.
///
/// Only a complete read can: a truncated one stopped at the block ceiling, and saving from it would
/// drop everything after that point. Saying so is what keeps the pane read-only instead of offering
/// an edit whose save would quietly shorten the file.
fn document_editable(truncated: bool) -> bool {
    !truncated
}

#[tauri::command]
pub async fn fs_read_docx(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<DocxDocument, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_read(&app.state::<WorkspaceRegistry>(), &target)?;
        read_docx_sync(&target)
    })
    .await
}

fn read_docx_sync(path: &Path) -> Result<DocxDocument, String> {
    // Stat first: the guard has to describe the file that was read, and a write that finds it changed
    // is refused rather than overwriting whatever changed it.
    let meta = std::fs::metadata(path).map_err(|error| format!("读取文件信息失败：{error}"))?;
    let bytes = std::fs::read(path).map_err(|error| {
        log::debug!("fs_read_docx read({}) failed: {error}", path.display());
        error.to_string()
    })?;
    let (document, numbering) = parts(&bytes)?;
    let (blocks, truncated) = parse_blocks(&document, numbering.as_deref())?;
    Ok(DocxDocument {
        blocks,
        truncated,
        editable: document_editable(truncated),
        guard: guard_of(&meta),
    })
}

/// The parts this reader needs out of the archive.
///
/// Entry names are matched on their last component, case-insensitively: a ZIP written by
/// PowerShell's `Compress-Archive` separates with backslashes, and writers vary the case. Both parts
/// are read with a ceiling of their own, because the size a ZIP *declares* is not the size it will
/// expand to.
fn parts(bytes: &[u8]) -> Result<(String, Option<String>), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("这不是一个可读的 .docx（ZIP 目录解析失败）：{error}"))?;
    let mut document = None;
    let mut numbering = None;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 .docx 内条目失败：{error}"))?;
        let name = entry.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
        let wanted = if name.eq_ignore_ascii_case("document.xml") {
            Some(MAX_DOCUMENT_BYTES)
        } else if name.eq_ignore_ascii_case("numbering.xml") {
            Some(MAX_NUMBERING_BYTES)
        } else {
            None
        };
        let Some(limit) = wanted else { continue };
        if entry.size() > limit {
            return Err(format!(
                "{name} 解压后约 {} MB，超出预览上限",
                entry.size() / 1024 / 1024
            ));
        }
        let text = read_part(&mut entry, limit)?;
        if name.eq_ignore_ascii_case("document.xml") {
            document = Some(text);
        } else {
            numbering = Some(text);
        }
    }
    let document = document
        .ok_or_else(|| "这个 .docx 里没有 word/document.xml，无法读取内容".to_string())?;
    Ok((document, numbering))
}

/// Reads one entry up to `limit` bytes. A ZIP can claim a small uncompressed size and deliver more,
/// so the read itself is bounded rather than only its declared size.
fn read_part(entry: &mut impl Read, limit: u64) -> Result<String, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = entry
            .read(&mut chunk)
            .map_err(|error| format!("解压 .docx 内条目失败：{error}"))?;
        if read == 0 {
            break;
        }
        if buffer.len() as u64 + read as u64 > limit {
            return Err(format!(
                "内容解压后超过 {} MB，超出预览上限",
                limit / 1024 / 1024
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8(buffer).map_err(|error| format!("内容不是 UTF-8：{error}"))
}

/// A Word element, prefixed `w:` in every part Word writes. A part that declares the namespaces as
/// default (no prefix) spells the same elements, so both are accepted - and only those two, so an
/// `a:p` inside a drawing is not mistaken for a paragraph.
fn is_w(name: QName<'_>, local: &[u8]) -> bool {
    let full = name.as_ref();
    full == local || (full.starts_with(b"w:") && &full[2..] == local)
}

fn attribute(element: &BytesStart<'_>, local: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| is_w(attribute.key, local))
        .and_then(|attribute| attribute.unescape_value().ok())
        .map(|value| value.into_owned())
}

/// One paragraph's new text, addressed by its ordinal among the part's `<w:p>` elements.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocxEdit {
    pub index: u32,
    pub text: String,
}

/// What the file looked like when it was read.
///
/// A write is refused when this no longer matches: Word (or anything else) may have saved the file
/// between the read and the edit, and overwriting that would throw away work the user did elsewhere.
#[derive(serde::Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxGuard {
    pub size: u64,
    pub modified_ms: i64,
}

/// The file's identity right now, for a guard.
fn guard_of(meta: &std::fs::Metadata) -> DocxGuard {
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0);
    DocxGuard {
        size: meta.len(),
        modified_ms,
    }
}

/// Escapes text for an XML text node.
fn escape_text(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// A paragraph to add, and the paragraph it goes after.
///
/// `after: None` means "in front of everything": a body whose first element is a table, or one with
/// no `<w:p>` at all, has no ordinal to name for the top of the document.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocxInsert {
    pub after: Option<u32>,
    pub text: String,
}

/// A new paragraph, styled like the one it follows.
///
/// Word keeps the paragraph's style when Enter is pressed: a new line under a heading is another
/// heading, one under a list item continues the list. The properties are copied verbatim, and the rest
/// of the paragraph is a single run holding its text - an empty line is a paragraph with no run at all.
fn new_paragraph(source: &str, text: &str) -> String {
    let properties = match source.find("<w:pPr>") {
        Some(start) => source[start..]
            .find("</w:pPr>")
            .map(|end| &source[start..start + end + "</w:pPr>".len()])
            .unwrap_or(""),
        None => "",
    };
    if text.is_empty() {
        return format!("<w:p>{properties}</w:p>");
    }
    let needs_space = text.trim() != text;
    let attribute = if needs_space {
        " xml:space=\"preserve\""
    } else {
        ""
    };
    format!(
        "<w:p>{properties}<w:r><w:t{attribute}>{}</w:t></w:r></w:p>",
        escape_text(text)
    )
}

/// One paragraph's bytes with its text replaced.
///
/// The paragraph keeps everything it had - properties, run properties, bookmarks - and only the text
/// node payloads change: the new text goes into the first one and the rest are emptied, so the element
/// count and the XML around them stay what Word wrote.
///
/// A paragraph with no text node at all - a blank line the pane just created, a line holding only an
/// image or a field - gets a run of its own, after its properties. Refusing that made a save fail as a
/// whole whenever the caret was on a line with nothing on it, which is exactly where typing starts
/// after Enter.
fn rewrite_paragraph(paragraph: &str, text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(paragraph.len() + text.len());
    let mut rest = paragraph;
    let mut written = false;
    while let Some(open) = rest.find("<w:t") {
        let after_open = &rest[open..];
        let Some(close) = after_open.find('>') else {
            return Err("文档里的文字节点没有闭合".into());
        };
        // A self-closing node is empty: same treatment, no payload and no closing tag.
        let self_closing = after_open[..close].ends_with('/');
        out.push_str(&rest[..open]);
        if written {
            out.push_str("<w:t></w:t>");
        } else {
            // Word drops leading and trailing spaces unless the node says to keep them.
            let needs_space = text.trim() != text;
            out.push_str(if needs_space {
                "<w:t xml:space=\"preserve\">"
            } else {
                "<w:t>"
            });
            out.push_str(&escape_text(text));
            out.push_str("</w:t>");
            written = true;
        }
        rest = &after_open[close + 1..];
        if !self_closing {
            let Some(end) = rest.find("</w:t>") else {
                return Err("文档里的文字节点没有闭合".into());
            };
            rest = &rest[end + "</w:t>".len()..];
        }
    }
    if !written {
        // A paragraph with no text node at all - a blank line Enter just created, a line holding
        // only an image or a field. The text needs somewhere to live, so a run is created after the
        // paragraph's own properties, in front of whatever else it holds.
        if text.is_empty() {
            return Ok(paragraph.to_string());
        }
        let needs_space = text.trim() != text;
        let open = if needs_space {
            "<w:t xml:space=\"preserve\">"
        } else {
            "<w:t>"
        };
        let run = format!("<w:r>{open}{}</w:t></w:r>", escape_text(text));
        let at = rest
            .find("</w:pPr>")
            .map(|end| end + "</w:pPr>".len())
            .or_else(|| rest.find('>').map(|end| end + 1))
            .unwrap_or(0);
        out.push_str(&rest[..at]);
        out.push_str(&run);
        out.push_str(&rest[at..]);
        return Ok(out);
    }
    out.push_str(rest);
    Ok(out)
}

/// The document part with the edited paragraphs replaced and the deleted ones dropped.
///
/// Byte slices, not a re-serialization: every element outside the touched paragraphs is copied out of
/// the original exactly as Word wrote it, which is what keeps styles, namespace prefixes, attributes
/// and anything this reader does not understand intact.
fn rewrite_document_xml(
    xml: &str,
    edits: &[DocxEdit],
    deleted: &[u32],
    inserts: &[DocxInsert],
) -> Result<String, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut ranges: Vec<(u32, usize, usize)> = Vec::new();
    let mut open: Option<(u32, usize)> = None;
    let mut next_paragraph: u32 = 0;
    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(element)) if is_w(element.name(), b"p") => {
                open = Some((next_paragraph, before));
                next_paragraph += 1;
            }
            Ok(Event::Empty(element)) if is_w(element.name(), b"p") => {
                ranges.push((next_paragraph, before, reader.buffer_position() as usize));
                next_paragraph += 1;
            }
            Ok(Event::End(element)) if is_w(element.name(), b"p") => {
                if let Some((index, start)) = open.take() {
                    ranges.push((index, start, reader.buffer_position() as usize));
                }
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("文档 XML 解析失败：{error}")),
            _ => {}
        }
    }

    // Every edit and every deletion has to name a paragraph that exists: a stale index means the pane
    // and this part disagree, and writing half of that is worse than refusing.
    let count = ranges.len() as u32;
    for edit in edits {
        if edit.index >= count {
            return Err(format!("这一段不在文档里（序号 {}）", edit.index));
        }
    }
    for index in deleted {
        if *index >= count {
            return Err(format!("要删的段不在文档里（序号 {index}）"));
        }
    }
    for insert in inserts {
        let Some(after) = insert.after else { continue };
        if after >= count {
            return Err(format!("要插入的位置不在文档里（序号 {after}）"));
        }
        if deleted.contains(&after) {
            return Err("不能在删掉的段落后插入".into());
        }
    }

    // Everything that asked for the top of the document, in the order the pane sent it. The style
    // comes from the first paragraph that is there, or from nothing at all in an empty body.
    let first_paragraph = ranges
        .first()
        .map(|(_, start, end)| &xml[*start..*end])
        .unwrap_or("");
    let leading: Vec<String> = inserts
        .iter()
        .filter(|insert| insert.after.is_none())
        .map(|insert| new_paragraph(first_paragraph, &insert.text))
        .collect();

    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0usize;
    let mut leading_written = false;
    for (index, start, end) in &ranges {
        if *start < cursor {
            continue;
        }
        out.push_str(&xml[cursor..*start]);
        if !leading_written {
            for paragraph in &leading {
                out.push_str(paragraph);
            }
            leading_written = true;
        }
        cursor = *end;
        if deleted.contains(index) {
            continue;
        }
        let paragraph = &xml[*start..*end];
        match edits.iter().find(|edit| edit.index == *index) {
            Some(edit) => out.push_str(&rewrite_paragraph(paragraph, &edit.text)?),
            None => out.push_str(paragraph),
        }
        for insert in inserts.iter().filter(|insert| insert.after == Some(*index)) {
            out.push_str(&new_paragraph(paragraph, &insert.text));
        }
    }
    let tail = &xml[cursor..];
    if !leading_written && !leading.is_empty() {
        // No paragraph was walked at all, so the top of the body is its last child position: the new
        // paragraphs go in just before the body closes, and stay inside it.
        if let Some(end) = tail.find("</w:body>") {
            out.push_str(&tail[..end]);
            for paragraph in &leading {
                out.push_str(paragraph);
            }
            out.push_str(&tail[end..]);
            return Ok(out);
        }
        for paragraph in &leading {
            out.push_str(paragraph);
        }
    }
    out.push_str(tail);
    Ok(out)
}

/// How many versions of one document the pane can undo.
///
/// A step is one save, and a save happens when typing stops, so twenty is a long working session's
/// worth of edits to the same file. The parts live in memory only: the file itself is what survives.
const UNDO_DEPTH: usize = 20;

/// The document parts written back so far, newest last, per file.
///
/// Undo restores the part that was there before the last write. That is the only way to bring back a
/// deleted paragraph: its XML is gone from the model, so re-sending the model cannot recreate it - but
/// the bytes that held it are still here.
static DOCX_HISTORY: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Vec<String>>>,
> = std::sync::OnceLock::new();

fn docx_history() -> &'static std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Vec<String>>>
{
    DOCX_HISTORY.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Remembers what a file's document part looked like before it is replaced.
fn remember_part(path: &Path, part: &str) {
    let Ok(mut history) = docx_history().lock() else {
        return;
    };
    let entries = history.entry(path.to_path_buf()).or_default();
    entries.push(part.to_string());
    if entries.len() > UNDO_DEPTH {
        entries.remove(0);
    }
}

/// Takes back the last remembered part, if there is one.
fn take_previous_part(path: &Path) -> Option<String> {
    let mut history = docx_history().lock().ok()?;
    history.get_mut(path)?.pop()
}

/// Writes `part` into the archive at `path`, copying every other entry verbatim.
///
/// The archive is rebuilt rather than patched in place: each entry keeps its own compression, and only
/// the document part is new. It lands in a temporary file first and is renamed over the original, so a
/// crash mid-write leaves the document intact.
fn write_document_part(path: &Path, original: &[u8], part: &str) -> Result<DocxGuard, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(original))
        .map_err(|error| format!("这不是一个可读的 .docx（ZIP 目录解析失败）：{error}"))?;
    let stem = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "document".into());
    let temporary = path.with_file_name(format!("{stem}.tmp-{}.docx", std::process::id()));
    let written = (|| -> Result<(), String> {
        let file = std::fs::File::create(&temporary)
            .map_err(|error| format!("创建临时文件失败：{error}"))?;
        let mut writer = zip::ZipWriter::new(file);
        for index in 0..archive.len() {
            let entry = archive
                .by_index(index)
                .map_err(|error| format!("读取 .docx 内条目失败：{error}"))?;
            let name = entry
                .name()
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or("")
                .to_string();
            if name.eq_ignore_ascii_case("document.xml") {
                let options = zip::write::SimpleFileOptions::default()
                    .compression_method(entry.compression());
                writer
                    .start_file(entry.name().to_string(), options)
                    .map_err(|error| format!("写入 .docx 失败：{error}"))?;
                std::io::Write::write_all(&mut writer, part.as_bytes())
                    .map_err(|error| format!("写入 .docx 失败：{error}"))?;
            } else {
                writer
                    .raw_copy_file(entry)
                    .map_err(|error| format!("复制 .docx 内条目失败：{error}"))?;
            }
        }
        writer
            .finish()
            .map_err(|error| format!("写入 .docx 失败：{error}"))?;
        Ok(())
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("替换原文件失败：{error}")
    })?;
    let meta = std::fs::metadata(path).map_err(|error| format!("读取文件信息失败：{error}"))?;
    Ok(guard_of(&meta))
}

/// Takes back the last change to a `.docx`, by writing the part that was there before it.
fn undo_docx_sync(path: &Path, guard: &DocxGuard) -> Result<DocxGuard, String> {
    let meta = std::fs::metadata(path).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if guard_of(&meta) != *guard {
        return Err("文件在磁盘上变了，没有撤销；请重新打开这个文档".into());
    }
    let previous = take_previous_part(path).ok_or("没有可撤销的改动了")?;
    let bytes = std::fs::read(path).map_err(|error| format!("读取文件失败：{error}"))?;
    write_document_part(path, &bytes, &previous)
}

/// Takes back the last change to a `.docx`.
#[tauri::command]
pub async fn fs_undo_docx(
    app: tauri::AppHandle,
    path: String,
    guard: DocxGuard,
    workspace: Option<WorkspaceEnv>,
) -> Result<DocxGuard, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_parent(&app.state::<WorkspaceRegistry>(), &target)?;
        undo_docx_sync(&target, &guard)
    })
    .await
}
/// Writes edits back into a `.docx`, leaving every other part of the archive as it was.
///
/// The archive is rebuilt rather than patched in place: every entry is copied verbatim (its own
/// compression included) and only the document part is written new. It lands in a temporary file first
/// and is renamed over the original, so a crash mid-write leaves the document intact.
fn write_docx_sync(
    path: &Path,
    edits: &[DocxEdit],
    deleted: &[u32],
    inserts: &[DocxInsert],
    guard: &DocxGuard,
) -> Result<DocxGuard, String> {
    let meta = std::fs::metadata(path).map_err(|error| format!("读取文件信息失败：{error}"))?;
    if guard_of(&meta) != *guard {
        return Err("文件在磁盘上变了，没有写；请重新打开这个文档".into());
    }
    let bytes = std::fs::read(path).map_err(|error| format!("读取文件失败：{error}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes))
        .map_err(|error| format!("这不是一个可读的 .docx（ZIP 目录解析失败）：{error}"))?;

    let mut document = None;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 .docx 内条目失败：{error}"))?;
        let name = entry
            .name()
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_string();
        if !name.eq_ignore_ascii_case("document.xml") {
            continue;
        }
        if entry.size() > MAX_DOCUMENT_BYTES {
            return Err(format!(
                "{name} 解压后约 {} MB，超出上限",
                entry.size() / 1024 / 1024
            ));
        }
        document = Some(read_part(&mut entry, MAX_DOCUMENT_BYTES)?);
        break;
    }
    let document = document.ok_or("这个 .docx 里没有 word/document.xml")?;
    let rewritten = rewrite_document_xml(&document, edits, deleted, inserts)?;
    // The part that is about to be replaced is what undo restores.
    remember_part(path, &document);
    write_document_part(path, &bytes, &rewritten)
}

/// Writes edits back into a `.docx`. `guard` is what the pane saw when it read the file.
#[tauri::command]
pub async fn fs_write_docx(
    app: tauri::AppHandle,
    path: String,
    edits: Vec<DocxEdit>,
    deleted: Vec<u32>,
    inserts: Vec<DocxInsert>,
    guard: DocxGuard,
    workspace: Option<WorkspaceEnv>,
) -> Result<DocxGuard, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_parent(&app.state::<WorkspaceRegistry>(), &target)?;
        write_docx_sync(&target, &edits, &deleted, &inserts, &guard)
    })
    .await
}

/// The `w:val` of an element, which is what every Word property carries.
fn val(element: &BytesStart<'_>) -> Option<String> {
    attribute(element, b"val")
}

/// The paragraph being read. Word puts a run's properties before its text, so the styles are
/// gathered as they appear and attached when the run closes.
#[derive(Default)]
struct Paragraph {
    /// Which `<w:p>` of the part this is, counted from zero.
    ///
    /// This is the link between what the pane drew and the element the writer has to touch, so it is
    /// assigned to *every* paragraph in the part - including the ones inside a table, and the ones
    /// inside a table nested in a cell, which are not drawn - because skipping one here would shift
    /// every paragraph after it.
    index: u32,
    style: Option<String>,
    outline: Option<u8>,
    numbering: Option<(u8, String)>,
    runs: Vec<Run>,
    text: String,
    bold: bool,
    italic: bool,
    underline: bool,
    in_run: bool,
    in_text: bool,
}

impl Paragraph {
    fn close_run(&mut self) {
        let text = std::mem::take(&mut self.text);
        if !text.is_empty() {
            self.runs.push(Run {
                text,
                bold: self.bold,
                italic: self.italic,
                underline: self.underline,
            });
        }
        self.bold = false;
        self.italic = false;
        self.underline = false;
    }

    fn text(&self) -> String {
        self.runs.iter().map(|run| run.text.as_str()).collect()
    }

    /// The heading level this paragraph declares. Word writes `Heading2` in the paragraph style and
    /// `outlineLvl 1` as the level itself (0-based); either is enough, and a style name that is not
    /// a heading is not a heading.
    fn heading(&self) -> Option<u8> {
        let from_style = self.style.as_deref().and_then(|style| {
            let rest = style
                .strip_prefix("Heading")
                .or_else(|| style.strip_prefix("heading"))?;
            rest.parse::<u8>().ok().filter(|level| (1..=6).contains(level))
        });
        from_style.or(self.outline.map(|level| level.saturating_add(1)))
    }
}

/// Numbered rather than bulleted, per numbering id. Built from `word/numbering.xml`, which pairs
/// each `numId` with an abstract numbering definition, and that with a format: `bullet` is a bullet,
/// anything else Word writes (`decimal`, `lowerLetter`, `roman`, …) is numbered.
fn ordered_number_ids(numbering_xml: &str) -> std::collections::HashSet<String> {
    let mut formats: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut abstract_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut current_abstract: Option<String> = None;
    let mut pending_num: Option<String> = None;
    let mut ordered = std::collections::HashSet::new();
    let mut reader = Reader::from_str(numbering_xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = element.name();
                if is_w(name, b"abstractNum") {
                    current_abstract = attribute(&element, b"abstractNumId");
                } else if is_w(name, b"lvl") {
                    // levels are listed in order, so the first format seen is level 0's
                } else if is_w(name, b"numFmt") {
                    if let (Some(abstract_id), Some(format)) = (current_abstract.clone(), val(&element))
                    {
                        formats.entry(abstract_id).or_insert(format);
                    }
                } else if is_w(name, b"num") {
                    pending_num = attribute(&element, b"numId");
                } else if is_w(name, b"abstractNumId") {
                    if let (Some(id), Some(abstract_id)) = (pending_num.clone(), val(&element)) {
                        abstract_of.insert(id, abstract_id);
                    }
                }
            }
            Ok(Event::End(element)) => {
                let name = element.name();
                if is_w(name, b"abstractNum") {
                    current_abstract = None;
                } else if is_w(name, b"num") {
                    pending_num = None;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    for (id, abstract_id) in abstract_of {
        if let Some(format) = formats.get(&abstract_id) {
            if !format.eq_ignore_ascii_case("bullet") {
                ordered.insert(id);
            }
        }
    }
    ordered
}

/// Turns a property's `w:val` into a switch: absent means on, and Word also writes `0`, `false`,
/// `off` and `none` for off.
fn toggled(element: &BytesStart<'_>) -> bool {
    match val(element) {
        None => true,
        Some(value) => !matches!(
            value.to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "none"
        ),
    }
}

/**
 * A Word element's own contribution to the paragraph being read.
 *
 * Both `Event::Start` and `Event::Empty` come through here, because Word writes most of these
 * self-closing: `<w:pStyle w:val="Heading2"/>`, `<w:ilvl w:val="1"/>`, `<w:numId w:val="5"/>`,
 * `<w:b/>`. Reading them only from a start tag left every heading a plain paragraph and every list
 * flat and unnumbered.
 */
fn read_property(current: &mut Paragraph, name: QName<'_>, element: &BytesStart<'_>) {
    if is_w(name, b"pStyle") {
        current.style = val(element);
    } else if is_w(name, b"outlineLvl") {
        current.outline = val(element).and_then(|value| value.parse().ok());
    } else if is_w(name, b"numPr") {
        current.numbering = Some((0, String::new()));
    } else if is_w(name, b"ilvl") {
        if let Some((level, _)) = current.numbering.as_mut() {
            *level = val(element)
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
        }
    } else if is_w(name, b"numId") {
        if let Some((_, id)) = current.numbering.as_mut() {
            *id = val(element).unwrap_or_default();
        }
    } else if current.in_run && is_w(name, b"b") {
        current.bold = toggled(element);
    } else if current.in_run && is_w(name, b"i") {
        current.italic = toggled(element);
    } else if current.in_run && is_w(name, b"u") {
        // `w:u` carries the line style (`single`, `double`, …); `none` is the one that is off.
        current.underline = toggled(element);
    } else if is_w(name, b"tab") {
        current.text.push('\t');
    } else if is_w(name, b"br") || is_w(name, b"cr") {
        // A line break inside a paragraph is a break in its text, not a paragraph.
        current.text.push('\n');
    }
}

/// The document's blocks.
///
/// `numbering_xml` is optional: without it a list still reads as a list, with every item bulleted,
/// which is closer than showing the items as ordinary paragraphs.
fn parse_blocks(
    document_xml: &str,
    numbering_xml: Option<&str>,
) -> Result<(Vec<Block>, bool), String> {
    let ordered_numbers = numbering_xml.map(ordered_number_ids).unwrap_or_default();
    let mut blocks: Vec<Block> = Vec::new();
    let mut truncated = false;

    let mut paragraph: Option<Paragraph> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut row: Option<Vec<String>> = None;
    let mut cell: Option<String> = None;
    // A table nested in a cell is not shown: its rows would be read as rows of the outer table.
    let mut nested_table_depth = 0usize;
    // quick-xml verifies the tags that are closed; nothing tells it a document ended in the middle
    // of a tree, and a part cut off in the middle would otherwise draw as half a document.
    let mut open_elements = 0usize;
    // Every `<w:p>` in the part, drawn or not; see `Paragraph::index`.
    let mut next_paragraph: u32 = 0;

    let mut reader = Reader::from_str(document_xml);
    // Word marks significant leading and trailing spaces with `xml:space="preserve"`, and a run's
    // text is its own element, so nothing is trimmed here: trimming would join "Hello " and "world".
    reader.config_mut().trim_text(false);
    // End names are checked (quick-xml's default), so a mismatched tag is an error rather than a
    // guess; the unclosed case at the end of input is counted below.
    reader.config_mut().check_end_names = true;

    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = element.name();
                open_elements += 1;
                // Counted before the table and nesting checks below, because a paragraph inside a
                // cell is still a paragraph element of the part.
                let paragraph_index = is_w(name, b"p").then(|| {
                    let index = next_paragraph;
                    next_paragraph += 1;
                    index
                });
                if is_w(name, b"tbl") {
                    if table.is_some() {
                        nested_table_depth += 1;
                    } else {
                        table = Some(Vec::new());
                    }
                    continue;
                }
                if nested_table_depth > 0 {
                    continue;
                }
                if is_w(name, b"tr") {
                    row = Some(Vec::new());
                } else if is_w(name, b"tc") {
                    cell = Some(String::new());
                } else if let Some(index) = paragraph_index {
                    paragraph = Some(Paragraph {
                        index,
                        ..Default::default()
                    });
                } else if let Some(current) = paragraph.as_mut() {
                    if is_w(name, b"r") {
                        current.in_run = true;
                    } else if is_w(name, b"t") {
                        current.in_text = true;
                    } else {
                        read_property(current, name, &element);
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let name = element.name();
                // A self-closing `<w:p/>` is a paragraph element too, and takes its ordinal - and,
                // outside a table, it is a block of its own: this is what a blank line looks like
                // in a part Word wrote, and the pane needs it to draw the line the caret goes to.
                if is_w(name, b"p") {
                    let index = next_paragraph;
                    next_paragraph += 1;
                    if nested_table_depth == 0 && table.is_none() && cell.is_none() {
                        if blocks.len() >= MAX_BLOCKS {
                            truncated = true;
                        } else {
                            blocks.push(Block::Paragraph {
                                index,
                                heading: None,
                                list: None,
                                runs: Vec::new(),
                            });
                        }
                    }
                }
                if nested_table_depth > 0 {
                    continue;
                }
                if let Some(current) = paragraph.as_mut() {
                    read_property(current, name, &element);
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(current) = paragraph.as_mut() {
                    if current.in_text {
                        let decoded = text
                            .decode()
                            .map_err(|error| format!("文档文本解码失败：{error}"))?;
                        // The reader may hand back `&amp;` literally or split it out as a reference
                        // event; unescaping covers the first case and is a no-op in the second.
                        let unescaped = quick_xml::escape::unescape(&decoded)
                            .map_err(|error| format!("文档文本转义解析失败：{error}"))?;
                        current.text.push_str(&unescaped);
                    }
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if let Some(current) = paragraph.as_mut() {
                    if current.in_text {
                        if let Ok(Some(character)) = reference.resolve_char_ref() {
                            current.text.push(character);
                        } else if let Ok(name) = reference.decode() {
                            match &*name {
                                "amp" => current.text.push('&'),
                                "lt" => current.text.push('<'),
                                "gt" => current.text.push('>'),
                                "quot" => current.text.push('"'),
                                "apos" => current.text.push('\''),
                                _ => {}
                            }
                        }
                    }
                }
            }
            Ok(Event::End(element)) => {
                let name = element.name();
                open_elements = open_elements.saturating_sub(1);
                if is_w(name, b"tbl") {
                    if nested_table_depth > 0 {
                        nested_table_depth -= 1;
                    } else if let Some(rows) = table.take() {
                        blocks.push(Block::Table { rows });
                    }
                    continue;
                }
                if nested_table_depth > 0 {
                    continue;
                }
                if is_w(name, b"tr") {
                    if let (Some(rows), Some(cells)) = (table.as_mut(), row.take()) {
                        rows.push(cells);
                    }
                } else if is_w(name, b"tc") {
                    if let (Some(cells), Some(text)) = (row.as_mut(), cell.take()) {
                        cells.push(text.trim().to_string());
                    }
                } else if is_w(name, b"t") {
                    if let Some(current) = paragraph.as_mut() {
                        current.in_text = false;
                    }
                } else if is_w(name, b"r") {
                    if let Some(current) = paragraph.as_mut() {
                        current.close_run();
                        current.in_run = false;
                    }
                } else if is_w(name, b"p") {
                    let Some(finished) = paragraph.take() else {
                        continue;
                    };
                    let text = finished.text();
                    if cell.is_some() {
                        // A cell's paragraph: its text belongs to the cell.
                        if let Some(target) = cell.as_mut() {
                            if !target.is_empty() {
                                target.push(' ');
                            }
                            target.push_str(text.trim());
                        }
                    } else if blocks.len() >= MAX_BLOCKS {
                        truncated = true;
                    } else {
                        // Every paragraph of the body is a block, blank ones included: a blank line
                        // is where the caret goes when Enter is pressed at the end of a document,
                        // and a read that dropped it left that caret nowhere to land.
                        let list = finished.numbering.as_ref().map(|(level, id)| ListItem {
                            ordered: ordered_numbers.contains(id),
                            level: *level,
                            num_id: id.parse().unwrap_or_default(),
                        });
                        blocks.push(Block::Paragraph {
                            index: finished.index,
                            heading: finished.heading(),
                            list,
                            runs: finished.runs,
                        });
                    }
                }
            }
            Ok(Event::Eof) => {
                if open_elements > 0 {
                    return Err(format!(
                        "文档 XML 不完整：有 {open_elements} 个标签没有闭合"
                    ));
                }
                break;
            }
            Err(error) => return Err(format!("文档 XML 解析失败：{error}")),
            _ => {}
        }
    }

    Ok((blocks, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
        )
    }

    fn paragraphs(blocks: &[Block]) -> Vec<&Block> {
        blocks.iter().filter(|b| matches!(b, Block::Paragraph { .. })).collect()
    }

    #[test]
    fn reads_text_and_the_styles_around_it() {
        let xml = document(
            r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> then </w:t></w:r><w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr><w:t>both</w:t></w:r></w:p>"#,
        );
        let (blocks, truncated) = parse_blocks(&xml, None).unwrap();
        assert!(!truncated);
        assert_eq!(
            blocks,
            vec![Block::Paragraph {
                index: 0,
                heading: None,
                list: None,
                runs: vec![
                    Run { text: "bold".into(), bold: true, italic: false, underline: false },
                    Run { text: " then ".into(), bold: false, italic: false, underline: false },
                    Run { text: "both".into(), bold: false, italic: true, underline: true },
                ],
            }]
        );
    }

    #[test]
    fn reads_a_heading_from_its_style_or_its_outline_level() {
        let styled = document(
            r#"<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>"#,
        );
        let from_style = parse_blocks(&styled, None).unwrap().0;
        assert!(matches!(
            paragraphs(&from_style)[0],
            Block::Paragraph { heading: Some(2), .. }
        ));

        let outlined = document(
            r#"<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>"#,
        );
        let from_outline = parse_blocks(&outlined, None).unwrap().0;
        assert!(matches!(
            paragraphs(&from_outline)[0],
            Block::Paragraph { heading: Some(1), .. }
        ));

        // A style that merely starts with the same letters is not a heading.
        let other = document(
            r#"<w:p><w:pPr><w:pStyle w:val="Headingish"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>"#,
        );
        assert!(matches!(
            paragraphs(&parse_blocks(&other, None).unwrap().0)[0],
            Block::Paragraph { heading: None, .. }
        ));
    }

    #[test]
    fn reads_lists_and_asks_the_numbering_part_whether_they_are_numbered() {
        let xml = document(
            r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>"#,
        );
        let numbering = r#"<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
            <w:abstractNum w:abstractNumId="8"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
            <w:num w:numId="5"><w:abstractNumId w:val="7"/></w:num>
            <w:num w:numId="6"><w:abstractNumId w:val="8"/></w:num>
        </w:numbering>"#;
        let ordered = parse_blocks(&xml, Some(numbering)).unwrap().0;
        assert_eq!(
            ordered,
            vec![Block::Paragraph {
                index: 0,
                heading: None,
                list: Some(ListItem { ordered: true, level: 1, num_id: 5 }),
                runs: vec![Run { text: "item".into(), ..Default::default() }],
            }]
        );

        // Without the numbering part there is no format to read, so the item is a bullet - and it is
        // still a list, which is the part that matters for how it is drawn.
        let unordered = parse_blocks(&xml, None).unwrap().0;
        assert!(matches!(
            paragraphs(&unordered)[0],
            Block::Paragraph { list: Some(ListItem { ordered: false, .. }), .. }
        ));

        let bulleted = xml.replace("w:numId w:val=\"5\"", "w:numId w:val=\"6\"");
        assert!(matches!(
            paragraphs(&parse_blocks(&bulleted, Some(numbering)).unwrap().0)[0],
            Block::Paragraph { list: Some(ListItem { ordered: false, .. }), .. }
        ));
    }

    #[test]
    fn a_list_item_carries_the_numbering_definition_it_asks_for() {
        // Two lists next to each other with different ids are two lists: the pane resets its counter
        // when the id changes, and `ordered` alone cannot tell them apart.
        let xml = document(
            r#"<w:p><w:pPr><w:numPr><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:numId w:val="6"/></w:numPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>"#,
        );
        let blocks = parse_blocks(&xml, None).unwrap().0;
        let ids: Vec<u32> = paragraphs(&blocks)
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { list: Some(item), .. } => Some(item.num_id),
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec![5, 6]);
    }

    #[test]
    fn reads_a_table_cell_by_cell() {
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>"#,
        );
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        assert_eq!(
            blocks,
            vec![Block::Table {
                rows: vec![
                    vec!["a".to_string(), "b".to_string()],
                    vec!["c second".to_string(), String::new()],
                ],
            }]
        );
    }

    #[test]
    fn a_nested_table_does_not_become_rows_of_its_parent() {
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:tc></w:tr></w:tbl>"#,
        );
        assert_eq!(
            parse_blocks(&xml, None).unwrap().0,
            vec![Block::Table { rows: vec![vec!["outer".to_string()]] }]
        );
    }

    #[test]
    fn keeps_the_entity_and_drops_the_revision_it_should_not_show() {
        let xml = document(
            r#"<w:p><w:r><w:t>Tom &amp; Jerry &lt;3</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t> kept</w:t></w:r></w:ins></w:p>"#,
        );
        let blocks = parse_blocks(&xml, None).unwrap().0;
        let Block::Paragraph { runs, .. } = &blocks[0] else {
            panic!("expected a paragraph");
        };
        let text: String = runs.iter().map(|run| run.text.as_str()).collect();
        assert_eq!(text, "Tom & Jerry <3 kept");
    }

    #[test]
    fn a_paragraph_of_only_whitespace_is_still_a_block() {
        // It draws as a blank line, and the editor has to see it: its text may be a space the user
        // typed, and the line has to keep its place in the document either way.
        let xml = document(r#"<w:p><w:r><w:t>   </w:t></w:r></w:p><w:p><w:r><w:t>real</w:t></w:r></w:p>"#);
        let blocks = parse_blocks(&xml, None).unwrap().0;
        assert_eq!(paragraphs(&blocks).len(), 2);
        assert!(matches!(&blocks[0], Block::Paragraph { index: 0, .. }));
        assert!(matches!(&blocks[1], Block::Paragraph { index: 1, .. }));
    }

    #[test]
    fn text_written_into_a_paragraph_that_had_none() {
        // Enter at the end of a document writes an empty paragraph, then the next keystroke writes
        // text into it. There is no <w:t> to put it in, so one has to be created - failing here
        // failed the whole save, taking the other paragraphs' edits down with it.
        let xml = document("<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr></w:p>");
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: 0,
                text: "typed".into(),
            }],
            &[],
            &[],
        )
        .expect("writing into an empty paragraph should land");
        assert!(
            written.contains("<w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t>typed</w:t></w:r>"),
            "{written}"
        );
    }

    #[test]
    fn a_mixed_paragraph_keeps_its_first_run_and_drops_the_rest() {
        // The pane has no formatting commands, and the writer has one text per paragraph: the edit
        // lands in the first run, which keeps its properties, and the other runs are emptied. Pinned
        // here so nobody reads the loss of emphasis as a bug later - and so the text never goes
        // missing.
        let xml = document(
            r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t> plain</w:t></w:r></w:p>"#,
        );
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: 0,
                text: "changed".into(),
            }],
            &[],
            &[],
        )
        .expect("a mixed paragraph is still editable");
        assert!(
            written.contains("<w:rPr><w:b/></w:rPr><w:t>changed</w:t>"),
            "{written}"
        );
        assert!(!written.contains("plain"), "{written}");
    }

    #[test]
    fn an_empty_paragraph_round_trips_untouched() {
        let xml = document("<w:p/><w:p><w:r><w:t>x</w:t></w:r></w:p>");
        let written = rewrite_document_xml(&xml, &[], &[], &[]).expect("nothing to change");
        assert_eq!(written, xml);
    }

    #[test]
    fn an_insert_before_the_first_paragraph() {
        // A table first, or a body with no <w:p> at all: the only place a new line can go is in
        // front of everything, and `after` has no ordinal to name for it.
        let xml = document("<w:p><w:r><w:t>second</w:t></w:r></w:p>");
        let written = rewrite_document_xml(
            &xml,
            &[],
            &[],
            &[DocxInsert {
                after: None,
                text: "first".into(),
            }],
        )
        .expect("an insert before the first paragraph should land");
        let first = written.find("first").expect("the new paragraph is in the part");
        let second = written.find("second").expect("the old paragraph is in the part");
        assert!(first < second, "{written}");
    }

    #[test]
    fn an_insert_into_a_body_that_has_no_paragraphs() {
        let xml = document("");
        let written = rewrite_document_xml(
            &xml,
            &[],
            &[],
            &[DocxInsert {
                after: None,
                text: "only".into(),
            }],
        )
        .expect("an insert into an empty body should land");
        assert!(written.contains("<w:t>only</w:t>"), "{written}");
        assert!(written.contains("<w:body>"), "{written}");
    }

    /// One paragraph of `xml` replaced by `text`, with the rest of the part untouched.
    fn edited(xml: &str, index: u32, text: &str) -> String {
        rewrite_document_xml(
            xml,
            &[DocxEdit {
                index,
                text: text.to_string(),
            }],
            &[],
            &[],
        )
        .expect("the edit should apply")
    }

    #[test]
    fn an_edited_paragraph_changes_nothing_else_in_the_part() {
        // The whole point of slicing bytes instead of re-serializing: put the old text back and what
        // comes out is the original document, byte for byte.
        let xml = "<w:document><w:body>\
            <w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t>old</w:t></w:r></w:p>\
            <w:p><w:r><w:t>keep</w:t></w:r></w:p>\
            </w:body></w:document>";
        let out = edited(xml, 0, "new");
        assert!(out.contains("<w:jc w:val=\"center\"/>"));
        assert_eq!(out.replace(">new<", ">old<"), xml);
    }

    #[test]
    fn a_second_run_in_the_same_paragraph_is_emptied_not_dropped() {
        // "plain " and a bold word are two runs. The new text goes in the first and the second keeps
        // its element with no text, so the paragraph still has the runs Word wrote.
        let xml = "<w:document><w:body>\
            <w:p><w:r><w:t>plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r></w:p>\
            </w:body></w:document>";
        let out = edited(xml, 0, "merged");
        assert!(out.contains("<w:t>merged</w:t>"));
        assert!(out.contains("<w:t></w:t>"));
        assert!(!out.contains("bold"));
        assert!(out.contains("<w:rPr><w:b/></w:rPr>"));
    }

    #[test]
    fn a_deleted_paragraph_is_gone_and_the_rest_is_untouched() {
        let xml = "<w:document><w:body>\
            <w:p><w:r><w:t>gone</w:t></w:r></w:p>\
            <w:p><w:r><w:t>stays</w:t></w:r></w:p>\
            </w:body></w:document>";
        let out =
            rewrite_document_xml(xml, &[], &[0], &[]).expect("the deletion should apply");
        assert!(!out.contains("gone"));
        assert!(out.contains("stays"));
        assert_eq!(out, xml.replace("<w:p><w:r><w:t>gone</w:t></w:r></w:p>", ""));
    }

    #[test]
    fn edited_text_is_escaped_and_keeps_its_spaces() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>old</w:t></w:r></w:p></w:body></w:document>";
        let out = edited(xml, 0, " a & b <c> ");
        assert!(out.contains("&amp;") && out.contains("&lt;c&gt;"), "{out}");
        assert!(out.contains("xml:space=\"preserve\""), "{out}");
        // Text with no edge spaces needs no marker: the shorter form is what Word writes.
        assert!(!edited(xml, 0, "plain").contains("xml:space"));
    }

    #[test]
    fn a_paragraph_holding_an_image_takes_text_beside_it() {
        // It used to be refused ("this paragraph has no text"), which failed the whole save when the
        // caret was on such a line. The drawing has to survive: the text is a run added beside it,
        // not a replacement for it.
        let xml = "<w:document><w:body><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>";
        let written = rewrite_document_xml(
            xml,
            &[DocxEdit {
                index: 0,
                text: "x".into(),
            }],
            &[],
            &[],
        )
        .expect("a line holding an image can still be typed on");
        assert!(written.contains("<w:drawing/>"), "{written}");
        assert!(written.contains("<w:t>x</w:t>"), "{written}");
    }

    #[test]
    fn an_index_the_document_does_not_have_is_refused() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>only</w:t></w:r></w:p></w:body></w:document>";
        assert!(rewrite_document_xml(
            xml,
            &[DocxEdit {
                index: 9,
                text: "x".into(),
            }],
            &[],
            &[]
        )
        .is_err());
        assert!(rewrite_document_xml(xml, &[], &[9], &[]).is_err());
    }

    #[test]
    fn a_paragraph_inside_a_table_is_addressed_by_the_same_ordinal() {
        // The reader counts table paragraphs, so the writer must too, or an edit lands on the wrong
        // element.
        let xml = "<w:document><w:body>\
            <w:p><w:r><w:t>first</w:t></w:r></w:p>\
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>\
            </w:body></w:document>";
        let out = edited(xml, 1, "changed");
        assert!(out.contains(">changed<"), "{out}");
        assert!(out.contains("first"));
    }

    /// A real archive in a temp directory: the writer is only worth anything if a ZIP comes out.
    fn archive_with(document: &str) -> (std::path::PathBuf, DocxGuard) {
        // A counter as well as the thread: the undo tests make more than one archive in a row, and two
        // files with the same path would share one undo history.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "verta-docx-write-{}-{:?}-{serial}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.docx");
        {
            let file = std::fs::File::create(&path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("word/document.xml", options).unwrap();
            std::io::Write::write_all(&mut writer, document.as_bytes()).unwrap();
            writer.start_file("word/styles.xml", options).unwrap();
            std::io::Write::write_all(&mut writer, b"<w:styles>keep me</w:styles>").unwrap();
            writer.finish().unwrap();
        }
        let meta = std::fs::metadata(&path).unwrap();
        (path, guard_of(&meta))
    }

    #[test]
    fn a_new_paragraph_goes_right_after_the_one_it_names() {
        let xml = "<w:document><w:body>\
            <w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t>first</w:t></w:r></w:p>\
            <w:p><w:r><w:t>second</w:t></w:r></w:p>\
            </w:body></w:document>";
        let out = rewrite_document_xml(
            xml,
            &[],
            &[],
            &[DocxInsert {
                after: Some(0),
                text: "added".into(),
            }],
        )
        .expect("the insert should apply");
        // The properties of the paragraph it follows are copied, which is what keeps a new line under
        // a heading a heading and one under a list item in the list.
        let addition = "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:t>added</w:t></w:r></w:p>";
        let expected = xml.replace("<w:p><w:r><w:t>second</w:t></w:r></w:p>", &format!("{addition}<w:p><w:r><w:t>second</w:t></w:r></w:p>"));
        assert_eq!(out, expected);
    }

    #[test]
    fn an_empty_new_paragraph_is_a_line_with_no_run() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>only</w:t></w:r></w:p></w:body></w:document>";
        let out = rewrite_document_xml(
            xml,
            &[],
            &[],
            &[DocxInsert {
                after: Some(0),
                text: "".into(),
            }],
        )
        .expect("the insert should apply");
        assert_eq!(
            out,
            "<w:document><w:body><w:p><w:r><w:t>only</w:t></w:r></w:p><w:p></w:p></w:body></w:document>"
        );
    }

    #[test]
    fn inserted_text_is_escaped_and_keeps_its_spaces() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>only</w:t></w:r></w:p></w:body></w:document>";
        let out = rewrite_document_xml(
            xml,
            &[],
            &[],
            &[DocxInsert {
                after: Some(0),
                text: " b & c".into(),
            }],
        )
        .expect("the insert should apply");
        assert!(out.contains("xml:space=\"preserve\""), "{out}");
        assert!(out.contains("b &amp; c"), "{out}");
    }

    #[test]
    fn an_insert_where_there_is_no_paragraph_is_refused() {
        let xml = "<w:document><w:body><w:p><w:r><w:t>only</w:t></w:r></w:p></w:body></w:document>";
        assert!(rewrite_document_xml(
            xml,
            &[],
            &[],
            &[DocxInsert {
                after: Some(4),
                text: "x".into(),
            }]
        )
        .is_err());
        // And an insertion after a paragraph being deleted at the same time would land nowhere.
        assert!(rewrite_document_xml(
            xml,
            &[],
            &[0],
            &[DocxInsert {
                after: Some(0),
                text: "x".into(),
            }]
        )
        .is_err());
    }

    #[test]
    fn a_split_paragraph_reads_back_as_two() {
        // What Enter does: the paragraph is rewritten to what came before the caret, and a new one is
        // added after it holding what came after.
        let document = "<w:document><w:body><w:p><w:r><w:t>Keep me</w:t></w:r></w:p></w:body></w:document>";
        let (path, guard) = archive_with(document);
        write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "Keep".into(),
            }],
            &[],
            &[DocxInsert {
                after: Some(0),
                text: " me".into(),
            }],
            &guard,
        )
        .expect("the split should land");

        let read_back = read_docx_sync(&path).expect("the reader should read it back");
        let texts: Vec<String> = read_back
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { runs, .. } => {
                    Some(runs.iter().map(|run| run.text.as_str()).collect::<String>())
                }
                Block::Table { .. } => None,
            })
            .collect();
        assert_eq!(texts, vec!["Keep", " me"]);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The document part as it is on disk, for comparing one version with another.
    fn part_of(path: &Path) -> String {
        let bytes = std::fs::read(path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut part = String::new();
        std::io::Read::read_to_string(
            &mut archive.by_name("word/document.xml").unwrap(),
            &mut part,
        )
        .unwrap();
        part
    }

    #[test]
    fn undo_brings_back_the_part_that_was_replaced() {
        let document = "<w:document><w:body>\
            <w:p><w:r><w:t>one</w:t></w:r></w:p>\
            <w:p><w:r><w:t>two</w:t></w:r></w:p>\
            </w:body></w:document>";
        let (path, guard) = archive_with(document);
        let original = part_of(&path);

        let after_first = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "first".into(),
            }],
            &[],
            &[],
            &guard,
        )
        .expect("the first edit should land");
        let first = part_of(&path);
        assert_ne!(first, original);

        let after_second = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 1,
                text: "second".into(),
            }],
            &[],
            &[],
            &after_first,
        )
        .expect("the second edit should land");
        assert_ne!(part_of(&path), first);

        // One step back is the first edit, two is the file as it arrived.
        let undone = undo_docx_sync(&path, &after_second).expect("the first undo should land");
        assert_eq!(part_of(&path), first);
        undo_docx_sync(&path, &undone).expect("the second undo should land");
        assert_eq!(part_of(&path), original);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn undo_brings_a_deleted_paragraph_back_whole() {
        // The reason undo restores bytes rather than re-sending the model: a deleted paragraph's XML
        // is not in the model any more, so nothing the pane could send would recreate it.
        let document = "<w:document><w:body>\
            <w:p><w:r><w:t>keep</w:t></w:r></w:p>\
            <w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>drop</w:t></w:r></w:p>\
            </w:body></w:document>";
        let (path, guard) = archive_with(document);
        let original = part_of(&path);

        let after_delete = write_docx_sync(&path, &[], &[1], &[], &guard).expect("delete should land");
        assert!(!part_of(&path).contains("drop"));

        undo_docx_sync(&path, &after_delete).expect("undo should land");
        assert_eq!(part_of(&path), original);
        assert!(part_of(&path).contains("<w:rPr><w:b/></w:rPr>"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn undo_with_nothing_to_take_back_says_so() {
        let document = "<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>";
        let (path, guard) = archive_with(document);
        let error = undo_docx_sync(&path, &guard).unwrap_err();
        assert!(error.contains("没有可撤销"), "{error}");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn undo_refuses_a_stale_guard_and_leaves_the_file_alone() {
        let document = "<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>";
        let (path, guard) = archive_with(document);
        let after = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "y".into(),
            }],
            &[],
            &[],
            &guard,
        )
        .expect("the edit should land");
        let before_undo = std::fs::read(&path).unwrap();
        let stale = DocxGuard {
            size: after.size + 1,
            modified_ms: after.modified_ms,
        };
        assert!(undo_docx_sync(&path, &stale).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before_undo);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_stale_guard_is_refused_and_the_file_is_left_alone() {
        let document = "<w:document><w:body><w:p><w:r><w:t>old</w:t></w:r></w:p></w:body></w:document>";
        let (path, guard) = archive_with(document);
        let before = std::fs::read(&path).unwrap();
        let stale = DocxGuard {
            size: guard.size + 1,
            modified_ms: guard.modified_ms,
        };
        let error = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "new".into(),
            }],
            &[],
            &[],
            &stale,
        )
        .unwrap_err();
        assert!(error.contains("磁盘"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn what_was_written_is_what_the_reader_reads_back() {
        let document = "<w:document><w:body>\
            <w:p><w:r><w:t>old</w:t></w:r></w:p>\
            <w:p><w:r><w:t>drop me</w:t></w:r></w:p>\
            </w:body></w:document>";
        let (path, guard) = archive_with(document);
        let next = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "new & shiny".into(),
            }],
            &[1],
            &[],
            &guard,
        )
        .expect("the write should land");
        // A new identity comes back, so the next edit in the same session is not refused as stale.
        assert_ne!(next, guard);

        let read_back = read_docx_sync(&path).expect("the reader should read what was written");
        let Block::Paragraph { runs, .. } = &read_back.blocks[0] else {
            panic!("no paragraph: {read_back:?}");
        };
        assert_eq!(runs[0].text, "new & shiny");
        assert_eq!(read_back.blocks.len(), 1, "the deleted paragraph is gone");

        // And the part nothing asked about is byte-for-byte what it was.
        let bytes = std::fs::read(&path).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut styles = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("word/styles.xml").unwrap(), &mut styles)
            .unwrap();
        assert_eq!(styles, "<w:styles>keep me</w:styles>");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn every_paragraph_carries_the_ordinal_of_its_element() {
        // The ordinal is the link between what the frontend drew and the `<w:p>` the writer must
        // touch, so a paragraph inside a table consumes one too - otherwise every paragraph after a
        // table is off by the number of cells above it.
        let xml = "<w:document><w:body>            <w:p><w:r><w:t>one</w:t></w:r></w:p>            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>            <w:p><w:r><w:t>two</w:t></w:r></w:p>            </w:body></w:document>";
        let blocks = parse_blocks(xml, None).unwrap().0;
        let indexes: Vec<u32> = blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { index, .. } => Some(*index),
                Block::Table { .. } => None,
            })
            .collect();
        assert_eq!(indexes, vec![0, 2]);
    }

    #[test]
    fn a_paragraph_that_draws_nothing_still_takes_its_ordinal() {
        // `<w:p/>` and a paragraph of spaces are blank lines, and they are elements of the part: the
        // block after them is the third paragraph, not the first.
        let xml = "<w:document><w:body>            <w:p/>            <w:p><w:r><w:t> </w:t></w:r></w:p>            <w:p><w:r><w:t>third</w:t></w:r></w:p>            </w:body></w:document>";
        let blocks = parse_blocks(xml, None).unwrap().0;
        let indexes: Vec<u32> = blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { index, .. } => Some(*index),
                Block::Table { .. } => None,
            })
            .collect();
        assert_eq!(indexes, vec![0, 1, 2], "{blocks:?}");
        assert!(matches!(&blocks[2], Block::Paragraph { index: 2, .. }));
    }

    #[test]
    fn an_empty_paragraph_keeps_its_place() {
        // A blank line is a paragraph with no runs. Dropping it on read makes the ordinal after it
        // shift, so pressing Enter at the end of a document writes a paragraph the next read throws
        // away - and the caret lands nowhere.
        let xml = document(
            "<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>three</w:t></w:r></w:p>",
        );
        let blocks = parse_blocks(&xml, None).unwrap().0;
        assert_eq!(blocks.len(), 3, "{blocks:?}");
        assert!(matches!(&blocks[1], Block::Paragraph { index: 1, runs, .. } if runs.is_empty()));
        assert!(matches!(&blocks[2], Block::Paragraph { index: 2, .. }));
    }

    #[test]
    fn a_truncated_document_is_not_editable() {
        assert!(!document_editable(true));
        assert!(document_editable(false));
    }

    #[test]
    fn a_broken_document_part_is_an_error_rather_than_a_guess() {
        // Truncated: nothing closed the document, and half a document is not a document.
        let truncated = parse_blocks("<w:document><w:body><w:p><w:r><w:t>x", None).unwrap_err();
        assert!(truncated.contains("不完整"), "{truncated}");
        // Mismatched, which the reader rejects for us.
        let mismatched = parse_blocks("<w:document></w:body>", None);
        assert!(mismatched.is_err());
    }

    #[test]
    fn a_file_that_is_not_a_zip_is_rejected_with_a_readable_reason() {
        let error = parts(b"not a zip at all").unwrap_err();
        assert!(error.contains(".docx"), "{error}");
    }

    /// A minimal archive, built here rather than committed as a binary: the container path is the
    /// one part of this reader that cannot be exercised from a string.
    fn archive(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, contents) in entries {
            writer.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut writer, contents.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_the_parts_out_of_the_archive_and_parses_them() {
        let bytes = archive(&[
            ("[Content_Types].xml", "<Types/>"),
            (
                "word/document.xml",
                &document(r#"<w:p><w:r><w:t>from the archive</w:t></w:r></w:p>"#),
            ),
        ]);
        let (document_xml, numbering) = parts(&bytes).unwrap();
        assert!(numbering.is_none());
        let (blocks, _) = parse_blocks(&document_xml, None).unwrap();
        let Block::Paragraph { runs, .. } = &blocks[0] else {
            panic!("expected a paragraph");
        };
        assert_eq!(runs[0].text, "from the archive");
    }

    #[test]
    fn entry_names_are_matched_whatever_their_case_or_separator() {
        // `Compress-Archive` writes backslashes, and a writer may spell the part in any case.
        let bytes = archive(&[("WORD\\DOCUMENT.XML", "<w:document/>")]);
        let (document_xml, _) = parts(&bytes).unwrap();
        assert_eq!(document_xml, "<w:document/>");
    }

    #[test]
    fn an_archive_without_the_document_part_says_so() {
        let bytes = archive(&[("word/styles.xml", "<w:styles/>")]);
        let error = parts(&bytes).unwrap_err();
        assert!(error.contains("document.xml"), "{error}");
    }
}
