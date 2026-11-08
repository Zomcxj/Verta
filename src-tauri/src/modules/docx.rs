//! Word documents, read as structure rather than as a picture.
//!
//! A `.docx` is a ZIP whose `word/document.xml` holds the text. Nothing renders that natively - the
//! webview has no Word - so without a reader the editor could only report "binary file", which is
//! why this exists. The paragraphs, their headings, emphasis, lists and tables are read out of that
//! part and handed over as blocks, which the frontend draws with ordinary elements: no HTML
//! passthrough, no parser in the frontend bundle, and nothing added to the size budget.
//!
//! A text box is not drawn as a box: the model has no floating shapes, so the paragraphs inside one
//! are drawn where the box is anchored. Word writes every box twice, once for readers that know
//! DrawingML and once for readers that do not, and only the first copy is read.
//!
//! What this deliberately does not do: footnotes, comments and the old `.doc` format
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
/// Styles and theme are lookups, not documents; a generated one can still be large.
const MAX_STYLES_BYTES: u64 = 8 * 1024 * 1024;
const MAX_THEME_BYTES: u64 = 2 * 1024 * 1024;
/// One picture, and all of them together: a photo-heavy document is megabytes, and every byte
/// of it crosses IPC inside one JSON string.
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMAGES_BYTES: u64 = 16 * 1024 * 1024;
/// EMU (English Metric Units) to CSS pixels at 96 dpi: 914400 EMU to the inch.
const EMU_PER_PX: f64 = 9525.0;
/// Documents are read to be looked at, and the frontend renders every block as an element; a bound
/// keeps a 10 MB file from becoming a million nodes.
const MAX_BLOCKS: usize = 20_000;

#[derive(Serialize, Debug, Default, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// Point size, when the file names one (`w:sz` is in half-points).
    pub size: Option<f32>,
    /// `#rrggbb`; Word's `auto` is not a colour and reads as none.
    pub color: Option<String>,
    /// The font the run names, Latin or East Asian, whichever it names.
    pub font: Option<String>,
    /// A picture in this run, as a `data:` URL. Word keeps the bytes in `word/media/`, and the pane
    /// has nothing else to read them from.
    pub image: Option<String>,
    /// The size the document draws it at, in px; absent means "as it is".
    pub image_width: Option<f32>,
    pub image_height: Option<f32>,
    /// Which of the paragraph's drawings this is, counted from zero in the order the file writes
    /// them. It is the address a deletion names, and it counts drawings rather than pictures that
    /// survived the size cap, so a skipped picture does not shift the ones after it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_index: Option<u32>,
}

/// A paragraph's box: indents, in twips (1/20 pt), negative for a hanging indent.
#[derive(Serialize, Debug, Default, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Indent {
    pub left: Option<i32>,
    pub first_line: Option<i32>,
}

/// Space around and inside a paragraph, in twips; `line` is in twips for an exact rule and in
/// 240ths of a line for `auto`.
#[derive(Serialize, Debug, Default, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Spacing {
    pub before: Option<i32>,
    pub after: Option<i32>,
    pub line: Option<i32>,
    pub line_rule: Option<String>,
}

/// The paper: page size and margins, in twips. The pane draws a sheet of this shape.
#[derive(Serialize, Debug, Default, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub margin_top: Option<i32>,
    pub margin_right: Option<i32>,
    pub margin_bottom: Option<i32>,
    pub margin_left: Option<i32>,
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

#[derive(Serialize, Debug, PartialEq, Clone)]
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
        /// `left`, `center`, `right`, `both`; absent means the default, which is left.
        align: Option<String>,
        /// The size the paragraph's text inherits, in points - what an empty line is as tall as.
        size: Option<f32>,
        indent: Option<Indent>,
        spacing: Option<Spacing>,
    },
    /// Rows of cells; each cell's paragraphs are joined by a space, since a cell is one line here,
    /// but the styling of every piece is kept so a bold header is drawn bold.
    Table { rows: Vec<Vec<Vec<Run>>> },
    /// The text of a footnote the paragraph above cites.
    ///
    /// It is a block of its own and not part of that paragraph: the pane states one text per
    /// paragraph and writes it back over the paragraph, so a note folded into the paragraph's text
    /// would be written into the body of the document the first time the paragraph was edited. It
    /// has no ordinal, like a table, and is not editable.
    Note { text: String },
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocxDocument {
    pub blocks: Vec<Block>,
    /// The section's paper, when the file says. Absent means A4 as far as the pane is concerned.
    pub page: Option<Page>,
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
    let package = parts(&bytes)?;
    let mut styles = parse_styles(&package.styles);
    // The theme is where the default face lives; a document that names one in its styles keeps it.
    let (theme_latin, theme_east_asian) = package
        .theme
        .as_deref()
        .map(theme_fonts)
        .unwrap_or((None, None));
    if styles.default_run.font.is_none() {
        styles.default_run.font = theme_latin.or(theme_east_asian);
    }
    let notes = package
        .footnotes
        .as_deref()
        .map(read_notes)
        .unwrap_or_default();
    let (blocks, truncated, page) = parse_document(
        &package.document,
        package.numbering.as_deref(),
        &styles,
        &package.images,
        &notes,
    )?;
    Ok(DocxDocument {
        blocks,
        page,
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
#[derive(Debug)]
struct Package {
    document: String,
    numbering: Option<String>,
    /// `word/footnotes.xml`: the notes the body only cites.
    footnotes: Option<String>,
    styles: String,
    theme: Option<String>,
    /// Relationship id to the picture it names, already as a `data:` URL.
    images: std::collections::HashMap<String, String>,
}

fn parts(bytes: &[u8]) -> Result<Package, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("这不是一个可读的 .docx（ZIP 目录解析失败）：{error}"))?;
    let mut document = None;
    let mut numbering = None;
    let mut styles = None;
    let mut theme = None;
    let mut rels = None;
    let mut footnotes = None;
    // The picture bytes, by their file name inside the archive.
    let mut media: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    let mut media_bytes: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 .docx 内条目失败：{error}"))?;
        let name = entry.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
        let path = entry.name().replace('\\', "/");
        let in_media = path.contains("/media/");
        let wanted = if name.eq_ignore_ascii_case("document.xml") {
            Some(MAX_DOCUMENT_BYTES)
        } else if name.eq_ignore_ascii_case("numbering.xml") {
            Some(MAX_NUMBERING_BYTES)
        } else if name.eq_ignore_ascii_case("styles.xml") {
            Some(MAX_STYLES_BYTES)
        } else if name.eq_ignore_ascii_case("theme1.xml") {
            Some(MAX_THEME_BYTES)
        } else if name.eq_ignore_ascii_case("document.xml.rels")
            || name.eq_ignore_ascii_case("footnotes.xml")
        {
            Some(MAX_NUMBERING_BYTES)
        } else if in_media {
            // A picture past the cap, or past what is left of the total, is skipped rather than
            // failing the read: the text of the document is still what the pane is for.
            (media_bytes < MAX_IMAGES_BYTES).then_some(MAX_IMAGE_BYTES)
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
        if in_media {
            let bytes = read_bytes(&mut entry, limit, ".docx")?;
            media_bytes += bytes.len() as u64;
            // One table of picture types serves all three Office readers.
            let (Some(mime), Some(data)) =
                (super::office::image_mime(&name), encode_data_url(&bytes))
            else {
                continue;
            };
            media.insert(name, (mime.to_string(), data));
            continue;
        }
        let text = read_part(&mut entry, limit, ".docx")?;
        if name.eq_ignore_ascii_case("document.xml") {
            document = Some(text);
        } else if name.eq_ignore_ascii_case("styles.xml") {
            styles = Some(text);
        } else if name.eq_ignore_ascii_case("theme1.xml") {
            theme = Some(text);
        } else if name.eq_ignore_ascii_case("document.xml.rels") {
            rels = Some(text);
        } else if name.eq_ignore_ascii_case("footnotes.xml") {
            footnotes = Some(text);
        } else {
            numbering = Some(text);
        }
    }
    let document = document
        .ok_or_else(|| "这个 .docx 里没有 word/document.xml，无法读取内容".to_string())?;
    // The relationship table names which picture each `r:embed` points at.
    let images = match (rels.as_deref(), media.is_empty()) {
        (Some(rels), false) => image_relationships(rels, &media),
        _ => std::collections::HashMap::new(),
    };
    Ok(Package {
        document,
        numbering,
        footnotes,
        styles: styles.unwrap_or_default(),
        theme,
        images,
    })
}

/// Reads one entry up to `limit` bytes. A ZIP can claim a small uncompressed size and deliver more,
/// so the read itself is bounded rather than only its declared size.
///
/// `what` is the container being read (`.docx`, `.xlsx`, `.pptx`), so the message names the file the
/// user actually opened; the three readers share this because the archive is the same shape.
pub(crate) fn read_part(entry: &mut impl Read, limit: u64, what: &str) -> Result<String, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = entry
            .read(&mut chunk)
            .map_err(|error| format!("解压 {what} 内条目失败：{error}"))?;
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

/// One entry's bytes, up to `limit`: a picture is not text and cannot go through the reader above.
pub(crate) fn read_bytes(entry: &mut impl Read, limit: u64, what: &str) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = entry
            .read(&mut chunk)
            .map_err(|error| format!("解压 {what} 内条目失败：{error}"))?;
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
    Ok(buffer)
}

/// A Word element, prefixed `w:` in every part Word writes. A part that declares the namespaces as
/// default (no prefix) spells the same elements, so both are accepted - and only those two, so an
/// `a:p` inside a drawing is not mistaken for a paragraph.
fn is_w(name: QName<'_>, local: &[u8]) -> bool {
    let full = name.as_ref();
    full == local || (full.starts_with(b"w:") && &full[2..] == local)
}

/// A markup compatibility element, prefixed `mc:` in every part Word writes.
fn is_mc(name: QName<'_>, local: &[u8]) -> bool {
    let full = name.as_ref();
    full == local || (full.starts_with(b"mc:") && &full[3..] == local)
}

/// What to read of a part that states the same thing twice for the sake of old readers.
///
/// Word writes a text box as DrawingML inside `mc:Choice` and again as VML inside `mc:Fallback`, and
/// both copies hold paragraphs. Reading both put every text box in the document twice: one notes
/// file of 20 boxes held 10 distinct texts, each drawn twice. A fallback exists only for readers that
/// cannot use the choice, so this one skips it - unless the choice held nothing this reader draws (a
/// paragraph or a table), in which case the fallback is all there is and is read as usual.
#[derive(Default)]
struct Alternates {
    /// One entry per open `mc:AlternateContent`: whether its choice held anything to draw.
    open: Vec<bool>,
    /// How deep inside a fallback that is being skipped.
    skipping: usize,
}

impl Alternates {
    /// Told about every start element: says whether what it opens is to be left alone.
    fn start(&mut self, name: QName<'_>) -> bool {
        if self.skipping > 0 {
            // Anything nested inside a skipped fallback is skipped too, including a fallback.
            if is_mc(name, b"Fallback") {
                self.skipping += 1;
            }
            return true;
        }
        if is_mc(name, b"AlternateContent") {
            self.open.push(false);
            return false;
        }
        if is_mc(name, b"Fallback") {
            if self.open.last().copied().unwrap_or(false) {
                self.skipping = 1;
                return true;
            }
            return false;
        }
        // What this reader draws: the choice is worth taking if it holds one of these.
        if is_w(name, b"p") || is_w(name, b"tbl") {
            if let Some(taken) = self.open.last_mut() {
                *taken = true;
            }
        }
        false
    }

    /// Told about every end element: says whether it closed something inside a skipped fallback.
    fn end(&mut self, name: QName<'_>) -> bool {
        if self.skipping > 0 {
            if is_mc(name, b"Fallback") {
                self.skipping -= 1;
            }
            return true;
        }
        if is_mc(name, b"AlternateContent") {
            self.open.pop();
        }
        false
    }

    /// Whether the reader is inside a fallback it is leaving alone.
    fn skipping(&self) -> bool {
        self.skipping > 0
    }
}

fn attribute(element: &BytesStart<'_>, local: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| is_w(attribute.key, local))
        .and_then(|attribute| attribute.unescape_value().ok())
        .map(|value| value.into_owned())
}

/// Where each `<w:drawing>` of a part starts, in order.
fn drawing_offsets(xml: &str) -> Vec<usize> {
    let mut offsets = Vec::new();
    let mut at = 0usize;
    while let Some(found) = xml[at..].find("<w:drawing") {
        let start = at + found;
        offsets.push(start);
        at = start + "<w:drawing".len();
    }
    offsets
}

/// A cell's runs, trimmed at both ends and with nothing left over from an empty paragraph.
fn trimmed(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for run in runs {
        if run.text.is_empty() && run.image.is_none() {
            continue;
        }
        out.push(run);
    }
    if let Some(first) = out.first_mut() {
        first.text = first.text.trim_start().to_string();
    }
    if let Some(last) = out.last_mut() {
        last.text = last.text.trim_end().to_string();
    }
    out.retain(|run| !run.text.is_empty() || run.image.is_some());
    out
}

/// An attribute matched on its local name, whatever namespace prefix it carries.
fn attribute_any(element: &BytesStart<'_>, local: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == local)
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
#[derive(serde::Deserialize, Serialize, Debug, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DocxGuard {
    pub size: u64,
    pub modified_ms: i64,
}

/// The file's identity right now, for a guard.
pub(crate) fn guard_of(meta: &std::fs::Metadata) -> DocxGuard {
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
    while let Some(open) = find_text_node(rest) {
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

/// The bytes as a `data:` URL - what an `<img src>` can use with nothing on disk to fetch.
fn encode_data_url(bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    // Only the payload is encoded here; the mime type is added by the relationship table's caller.
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Which relationship id names which picture, from `word/_rels/document.xml.rels`.
fn image_relationships(
    rels: &str,
    media: &std::collections::HashMap<String, (String, String)>,
) -> std::collections::HashMap<String, String> {
    let mut images = std::collections::HashMap::new();
    let mut reader = Reader::from_str(rels);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if element.name().local_name().as_ref() != b"Relationship" {
                    continue;
                }
                let (Some(id), Some(target)) = (
                    attribute_any(&element, b"Id"),
                    attribute_any(&element, b"Target"),
                ) else {
                    continue;
                };
                let name = target.rsplit(['/', '\\']).next().unwrap_or("").to_string();
                let Some((mime, payload)) = media.get(&name) else {
                    continue;
                };
                images.insert(id, format!("data:{mime};base64,{payload}"));
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    images
}

/// Draws the notes a paragraph cited, after the block that cited them.
fn flush_notes(blocks: &mut Vec<Block>, pending: &mut Vec<String>, truncated: &mut bool) {
    for text in pending.drain(..) {
        if blocks.len() >= MAX_BLOCKS {
            *truncated = true;
            continue;
        }
        blocks.push(Block::Note { text });
    }
}

/// The text of each footnote of a part, by the id a `w:footnoteReference` names.
///
/// Word keeps the notes in a part of their own and leaves a reference in the run that cites one, so
/// the body of a note is nowhere in `document.xml`. The pane has no page foot to draw them in, so
/// they are drawn after the paragraph that cites them. The parts also hold separators - the rule
/// above the notes - which are marked by `w:type` and are not notes.
fn read_notes(xml: &str) -> std::collections::HashMap<String, String> {
    let mut notes = std::collections::HashMap::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // The note being read: its id, and one string per paragraph of it.
    let mut note: Option<(String, Vec<String>)> = None;
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = element.name();
                if is_w(name, b"footnote") {
                    let reserved = attribute(&element, b"type").is_some_and(|kind| kind != "normal");
                    note = attribute(&element, b"id")
                        .filter(|_| !reserved)
                        .map(|id| (id, Vec::new()));
                } else if is_w(name, b"t") {
                    in_text = true;
                    if let Some((_, paragraphs)) = note.as_mut() {
                        if paragraphs.is_empty() {
                            paragraphs.push(String::new());
                        }
                    }
                } else if is_w(name, b"p") {
                    if let Some((_, paragraphs)) = note.as_mut() {
                        if !paragraphs.is_empty() {
                            paragraphs.push(String::new());
                        }
                    }
                }
            }
            Ok(Event::End(element)) => {
                let name = element.name();
                if is_w(name, b"t") {
                    in_text = false;
                } else if is_w(name, b"footnote") {
                    if let Some((id, paragraphs)) = note.take() {
                        let text = paragraphs.join(" ").trim().to_string();
                        if !text.is_empty() {
                            notes.insert(id, text);
                        }
                    }
                }
            }
            Ok(Event::Text(text)) => {
                if !in_text {
                    continue;
                }
                let Some((_, paragraphs)) = note.as_mut() else {
                    continue;
                };
                let Some(current) = paragraphs.last_mut() else {
                    continue;
                };
                let decoded = text.decode().unwrap_or_default();
                current.push_str(&quick_xml::escape::unescape(&decoded).unwrap_or_default());
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    notes
}

/// Where the next `<w:t>` text node starts, ignoring the elements that begin with the same
/// characters: `<w:tabs>`, `<w:tab/>`, `<w:tc>`, and anything else in the `w:t` namespace.
///
/// The prefix is not enough. `<w:tabs>` matched it, its `>` was taken for the end of a text node and
/// the search for `</w:t>` failed, which failed the whole save; `<w:tab/>` matched it and was
/// rewritten to an empty text node, emptying the run that followed - the tab and the rest of the line
/// vanished from the document.
fn find_text_node(xml: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = xml[from..].find("<w:t") {
        let start = from + at;
        let after = xml[start + "<w:t".len()..].chars().next();
        if matches!(after, Some('>' | '/' | ' ')) {
            return Some(start);
        }
        from = start + "<w:t".len();
    }
    None
}

/// The document part with the edited paragraphs replaced and the deleted ones dropped.
///
/// Byte slices, not a re-serialization: every element outside the touched paragraphs is copied out of
/// the original exactly as Word wrote it, which is what keeps styles, namespace prefixes, attributes
/// and anything this reader does not understand intact.
/// One picture to move, and the paragraph it is to end up in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocxImageMove {
    /// Which of the part's drawings this is, counted from zero in the order the file writes them.
    pub drawing: u32,
    /// The ordinal of the paragraph it goes to, counted the way an edit counts them.
    pub to: u32,
}

/// A part's bytes with one picture moved to the end of another paragraph.
///
/// The picture travels as a run of its own: a drawing is only valid inside a run, so a picture cut
/// out of a run that also holds text arrives wrapped in a new one. Nothing else moves: the paragraph
/// it left keeps its text, and the paragraph it arrives in keeps everything it had.
fn relocate_drawing(xml: &str, drawing: u32, to: u32) -> Result<String, String> {
    let (start, stop) = drawing_cut(xml, drawing)?;
    let spans = paragraph_spans(xml);
    let Some((target_start, target_end)) = spans.get(to as usize).copied() else {
        return Err(format!("要移到的段不在文档里（序号 {to}）"));
    };
    // Moving a picture within the paragraph it is already in changes nothing.
    if start >= target_start && stop <= target_end {
        return Ok(xml.to_string());
    }
    // The picture goes in at the end of the target paragraph, which is in front of its closing tag.
    let insert_at = target_end.saturating_sub("</w:p>".len());
    let travelling = travel_fragment(xml, start, stop);
    let mut out = String::with_capacity(xml.len() + travelling.len());
    if stop <= insert_at {
        out.push_str(&xml[..start]);
        out.push_str(&xml[stop..insert_at]);
        out.push_str(&travelling);
        out.push_str(&xml[insert_at..]);
    } else {
        out.push_str(&xml[..insert_at]);
        out.push_str(&travelling);
        out.push_str(&xml[insert_at..start]);
        out.push_str(&xml[stop..]);
    }
    Ok(out)
}

/// What a move carries: the run the picture was in, or just the picture in a run of its own.
fn travel_fragment(xml: &str, start: usize, stop: usize) -> String {
    let fragment = &xml[start..stop];
    if fragment.starts_with("<w:r>") || fragment.starts_with("<w:r ") {
        return fragment.to_string();
    }
    format!("<w:r>{fragment}</w:r>")
}

/// The byte range a picture occupies, which is its run when the run holds nothing else.
fn drawing_cut(xml: &str, drawing: u32) -> Result<(usize, usize), String> {
    let mut seen = 0u32;
    let mut at = 0usize;
    while let Some(found) = xml[at..].find("<w:drawing") {
        let open = at + found;
        let end = drawing_end(xml, open)?;
        let this = seen;
        seen += 1;
        if this != drawing {
            at = end;
            continue;
        }
        if let Some((run_start, run_end)) = run_bounds(xml, open, end) {
            if run_is_otherwise_empty(xml, run_start, run_end, open, end) {
                return Ok((run_start, run_end));
            }
        }
        return Ok((open, end));
    }
    Err(format!("文档里没有第 {} 张图", drawing + 1))
}

/// Every `<w:p>` of a part as the byte range it occupies, by ordinal.
///
/// The ordinal is what the pane calls a paragraph, so this walk skips what the reader skips: a
/// fallback copy of a text box is not one of the document's paragraphs.
fn paragraph_spans(xml: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut alternates = Alternates::default();
    let mut open: Option<usize> = None;
    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                if alternates.start(element.name()) {
                    continue;
                }
                if is_w(element.name(), b"p") {
                    open = Some(before);
                }
            }
            Ok(Event::Empty(element)) => {
                if alternates.skipping() {
                    continue;
                }
                if is_w(element.name(), b"p") {
                    spans.push((before, reader.buffer_position() as usize));
                }
            }
            Ok(Event::End(element)) => {
                if alternates.end(element.name()) {
                    continue;
                }
                if is_w(element.name(), b"p") {
                    if let Some(start) = open.take() {
                        spans.push((start, reader.buffer_position() as usize));
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    spans
}

/// A part's bytes with one of its drawings taken out.
///
/// The drawing is what is cut, not the run: a run may hold text beside the picture, and taking the
/// run would take that text with it. When the picture was the only thing in its run, the run goes
/// too, because a run with nothing in it is a hollow element Word never writes.
fn remove_drawing(paragraph: &str, index: u32) -> Result<String, String> {
    let mut seen = 0u32;
    let mut at = 0usize;
    while let Some(found) = paragraph[at..].find("<w:drawing") {
        let open = at + found;
        let end = drawing_end(paragraph, open)?;
        let this = seen;
        seen += 1;
        if this != index {
            at = end;
            continue;
        }
        // The run around it, when there is one to cut.
        let mut start = open;
        let mut stop = end;
        if let Some((run_start, run_end)) = run_bounds(paragraph, open, end) {
            if run_is_otherwise_empty(paragraph, run_start, run_end, open, end) {
                start = run_start;
                stop = run_end;
            }
        }
        let mut out = String::with_capacity(paragraph.len());
        out.push_str(&paragraph[..start]);
        out.push_str(&paragraph[stop..]);
        return Ok(out);
    }
    // The pane asked for a drawing this part does not have, which means the two disagree. Refusing
    // is what keeps a stale picture number from rewriting a paragraph that is not the one meant.
    Err(format!("文档里没有第 {} 张图", index + 1))
}

/// Where a `<w:drawing>` that opens at `open` ends, after its closing tag.
fn drawing_end(paragraph: &str, open: usize) -> Result<usize, String> {
    let after = &paragraph[open + "<w:drawing".len()..];
    let Some(close) = after.find('>') else {
        return Err("文档里的图形元素没有闭合".into());
    };
    if after[..close].ends_with('/') {
        return Ok(open + "<w:drawing".len() + close + 1);
    }
    let body = &after[close + 1..];
    let Some(closed) = body.find("</w:drawing>") else {
        return Err("文档里的图形元素没有闭合".into());
    };
    Ok(open + "<w:drawing".len() + close + 1 + closed + "</w:drawing>".len())
}

/// The `<w:r>` element around a drawing, as the byte range it occupies.
fn run_bounds(paragraph: &str, open: usize, end: usize) -> Option<(usize, usize)> {
    let before = &paragraph[..open];
    let run_start = before.rfind("<w:r>").max(before.rfind("<w:r "))?;
    let after = &paragraph[end..];
    let closed = after.find("</w:r>")?;
    Some((run_start, end + closed + "</w:r>".len()))
}

/// Whether a run holds nothing but its properties once a range is taken out of it.
fn run_is_otherwise_empty(
    paragraph: &str,
    run_start: usize,
    run_end: usize,
    open: usize,
    end: usize,
) -> bool {
    // The run's own opening tag is not content; what sits between it and its closing tag is.
    let content_start = paragraph[run_start..]
        .find('>')
        .map(|at| run_start + at + 1)
        .unwrap_or(run_start);
    let mut rest = String::with_capacity(run_end - content_start);
    rest.push_str(&paragraph[content_start..open]);
    rest.push_str(&paragraph[end..run_end]);
    // The closing tag is not content either.
    if let Some(closed) = rest.rfind("</w:r>") {
        rest.truncate(closed);
    }
    // `<w:rPr>` is the run's own styling, which draws nothing; a run left with only that is hollow.
    while let Some(at) = rest.find("<w:rPr") {
        let Some(close) = rest[at..].find('>') else {
            break;
        };
        if rest[at..at + close].ends_with('/') {
            rest.replace_range(at..at + close + 1, "");
            continue;
        }
        let Some(closed) = rest[at..].find("</w:rPr>") else {
            break;
        };
        rest.replace_range(at..at + closed + "</w:rPr>".len(), "");
    }
    rest.trim().is_empty()
}


/// The byte range of each paragraph's fallback copy, by the ordinal of the copy that is read.
///
/// Word writes a text box twice: DrawingML inside `mc:Choice` for readers that understand it, and
/// VML inside `mc:Fallback` for readers that do not. Only the first copy is read, so an edit lands in
/// it - and the second copy has to be written with the same text, or the file ends up holding two
/// different texts for one box and the reader that sees the fallback sees the old one.
///
/// The copies pair up by position: the i-th paragraph of a fallback is the copy of the i-th paragraph
/// of its choice, which is how Word writes them.
fn fallback_mirrors(xml: &str) -> Vec<(u32, usize, usize)> {
    /// One open `mc:AlternateContent`: the ordinals of the paragraphs of its choice, and where the
    /// paragraphs of its fallback lie.
    #[derive(Default)]
    struct Pair {
        choice: Vec<u32>,
        fallback: Vec<(usize, usize)>,
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut alternates = Alternates::default();
    let mut pairs: Vec<Pair> = Vec::new();
    // (ordinal, start, is it a copy inside a fallback), one per open paragraph.
    let mut open: Vec<(Option<u32>, usize, bool)> = Vec::new();
    let mut next_paragraph: u32 = 0;
    let mut mirrors: Vec<(u32, usize, usize)> = Vec::new();
    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = element.name();
                if alternates.start(name) {
                    // The fallback's own contents are skipped by every other reader of this part;
                    // this walk only wants to know where its paragraphs are.
                    if is_w(name, b"p") {
                        open.push((None, before, true));
                    }
                    continue;
                }
                if is_mc(name, b"AlternateContent") {
                    pairs.push(Pair::default());
                } else if is_w(name, b"p") {
                    let ordinal = next_paragraph;
                    next_paragraph += 1;
                    if let Some(pair) = pairs.last_mut() {
                        pair.choice.push(ordinal);
                    }
                    open.push((Some(ordinal), before, false));
                }
            }
            Ok(Event::Empty(element)) => {
                if alternates.skipping() {
                    continue;
                }
                if is_w(element.name(), b"p") {
                    next_paragraph += 1;
                }
            }
            Ok(Event::End(element)) => {
                let name = element.name();
                if alternates.end(name) {
                    if is_w(name, b"p") {
                        if let Some((_, start, true)) = open.pop() {
                            if let Some(pair) = pairs.last_mut() {
                                pair.fallback.push((start, before));
                            }
                        }
                    }
                    continue;
                }
                if is_mc(name, b"AlternateContent") {
                    if let Some(pair) = pairs.pop() {
                        for (at, ordinal) in pair.choice.iter().enumerate() {
                            if let Some(range) = pair.fallback.get(at) {
                                mirrors.push((*ordinal, range.0, range.1));
                            }
                        }
                    }
                } else if is_w(name, b"p") {
                    open.pop();
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    mirrors
}

fn rewrite_document_xml(
    xml: &str,
    edits: &[DocxEdit],
    deleted: &[u32],
    inserts: &[DocxInsert],
    removals: &[DocxImageRemoval],
    moves: &[DocxImageMove],
) -> Result<String, String> {
    // The pictures come out first, and the paragraphs are then walked over what is left: a drawing
    // can sit in a table cell, and a cell has no place among the paragraph ordinals to be addressed
    // by. Cutting first also keeps every ordinal below unchanged, since a removal never adds or
    // removes a `<w:p>`.
    let mut cut = xml.to_string();
    for removal in removals {
        cut = remove_drawing(&cut, removal.drawing)?;
    }
    for relocation in moves {
        cut = relocate_drawing(&cut, relocation.drawing, relocation.to)?;
    }
    let xml = cut.as_str();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // (ordinal, start, end, is it a paragraph of the body rather than of a table cell)
    let mut ranges: Vec<(u32, usize, usize, bool)> = Vec::new();
    let mut open: Vec<(u32, usize)> = Vec::new();
    let mut next_paragraph: u32 = 0;
    // A table's paragraphs are paragraphs too, and they come first in the byte order. Depth is what
    // tells them apart: an insert "in front of everything" has to go in front of the body's first
    // paragraph, not inside the first cell.
    let mut tables: u32 = 0;
    let mut alternates = Alternates::default();
    loop {
        let before = reader.buffer_position() as usize;
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                if alternates.start(element.name()) {
                    continue;
                }
                if is_w(element.name(), b"tbl") {
                    tables += 1;
                } else if is_w(element.name(), b"p") {
                    open.push((next_paragraph, before));
                    next_paragraph += 1;
                }
            }
            Ok(Event::Empty(element)) => {
                if alternates.skipping() {
                    continue;
                }
                if is_w(element.name(), b"p") {
                    ranges.push((
                        next_paragraph,
                        before,
                        reader.buffer_position() as usize,
                        tables == 0,
                    ));
                    next_paragraph += 1;
                }
            }
            Ok(Event::End(element)) => {
                if alternates.end(element.name()) {
                    continue;
                }
                if is_w(element.name(), b"tbl") {
                    tables = tables.saturating_sub(1);
                } else if is_w(element.name(), b"p") {
                    if let Some((index, start)) = open.pop() {
                        // The end event is read after the element's own content, so the depth still
                        // counts the table this paragraph is in.
                        ranges.push((index, start, reader.buffer_position() as usize, tables == 0));
                    }
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
        .iter()
        .find(|(_, _, _, top_level)| *top_level)
        .or_else(|| ranges.first())
        .map(|(_, start, end, _)| &xml[*start..*end])
        .unwrap_or("");
    let leading: Vec<String> = inserts
        .iter()
        .filter(|insert| insert.after.is_none())
        .map(|insert| new_paragraph(first_paragraph, &insert.text))
        .collect();

    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0usize;
    let mut leading_written = false;
    // Where each stretch of the original landed in the rewrite, so an offset can be carried across.
    let mut copied: Vec<(usize, usize, usize)> = Vec::new();
    for (index, start, end, top_level) in &ranges {
        if *start < cursor {
            continue;
        }
        copied.push((cursor, *start, out.len()));
        out.push_str(&xml[cursor..*start]);
        if !leading_written && *top_level {
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
    copied.push((cursor, cursor + (xml.len() - cursor), out.len()));
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
            return carried_edits(out, &copied, &ranges, xml, edits);
        }
        for paragraph in &leading {
            out.push_str(paragraph);
        }
    }
    out.push_str(tail);
    carried_edits(out, &copied, &ranges, xml, edits)
}

/// Where a stretch of the original ended up, given the stretches that were copied verbatim.
///
/// Nothing here is arithmetic on lengths: a rewritten paragraph has a different length from the one
/// it replaced, so an offset is carried by finding the copied stretch it belonged to.
fn carried(from: usize, to: usize, copied: &[(usize, usize, usize)]) -> Option<(usize, usize)> {
    let (old_from, _, new_from) = copied
        .iter()
        .find(|(old_from, old_to, _)| *old_from <= from && to <= *old_to)?;
    let shift = new_from + (from - old_from);
    Some((shift, shift + (to - from)))
}

/// Writes an edit into the text that was copied rather than rewritten.
///
/// Two kinds of paragraph carry text that the walk above cannot rewrite where it stands. A paragraph
/// with another one nested in it - a text box inside a run - is emitted as the bytes it shares with
/// its child, and the child is what the walk rewrites, so the paragraph's own words would be left as
/// they were and an edit to them silently dropped. And a text box is read from its `mc:Choice` copy,
/// so an edit lands there; the `mc:Fallback` copy is only there for older readers, and leaving it
/// alone puts two different texts in the file for one box.
///
/// Both are found by where they landed in the rewrite - carried there by the copy log - and both are
/// only written when the bytes landed verbatim, because a paragraph that was deleted, or that was
/// rewritten along with its parent, is not something to write into any more.
fn carried_edits(
    mut out: String,
    copied: &[(usize, usize, usize)],
    ranges: &[(u32, usize, usize, bool)],
    xml: &str,
    edits: &[DocxEdit],
) -> Result<String, String> {
    // (from, to, replacement), applied from the end so the ranges below keep their places.
    let mut writes: Vec<(usize, usize, String)> = Vec::new();
    let mirrors = fallback_mirrors(xml);
    for edit in edits {
        for (index, start, end, _) in ranges {
            if *index != edit.index {
                continue;
            }
            // The paragraph's own bytes: everything outside the paragraphs nested in it. A box's
            // skipped copy is nested in the paragraph too, and it is not the paragraph's own text,
            // so it is neither rewritten nor blanked here.
            let mut nested: Vec<(usize, usize)> = ranges
                .iter()
                .filter(|(_, from, to, _)| *from > *start && *to <= *end)
                .map(|(_, from, to, _)| (*from, *to))
                .chain(
                    mirrors
                        .iter()
                        .filter(|(_, from, to)| *from > *start && *to <= *end)
                        .map(|(_, from, to)| (*from, *to)),
                )
                .collect();
            nested.sort_unstable();
            let first = nested.first().map(|(from, _)| *from).unwrap_or(*end);
            let last = nested.last().map(|(_, to)| *to).unwrap_or(*start);
            let own = [
                (*start, first, Some(edit.text.as_str())),
                (last, *end, Some("")),
            ];
            for (from, to, text) in own {
                if from >= to {
                    continue;
                }
                let Some(text) = text else { continue };
                if text.is_empty() && find_text_node(&xml[from..to]).is_none() {
                    continue;
                }
                let Some((at, stop)) = carried(from, to, copied) else {
                    continue;
                };
                if out.get(at..stop) != Some(&xml[from..to]) {
                    continue;
                }
                writes.push((at, stop, rewrite_paragraph(&xml[from..to], text)?));
            }
        }
        for (index, from, to) in &mirrors {
            if *index != edit.index {
                continue;
            }
            let Some((at, stop)) = carried(*from, *to, copied) else {
                continue;
            };
            if out.get(at..stop) != Some(&xml[*from..*to]) {
                continue;
            }
            writes.push((
                at,
                stop,
                rewrite_paragraph(&xml[*from..*to], &edit.text)?,
            ));
        }
    }
    writes.sort_by_key(|write| std::cmp::Reverse(write.0));
    for (at, stop, text) in writes {
        out.replace_range(at..stop, &text);
    }
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
    // The part about to be replaced is what undo restores, so remembering the same one twice makes a
    // Ctrl+Z take back nothing: a save that wrote what the previous save already wrote is not a step.
    if entries.last().is_some_and(|last| last == part) {
        return;
    }
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
    removals: &[DocxImageRemoval],
    moves: &[DocxImageMove],
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
        document = Some(read_part(&mut entry, MAX_DOCUMENT_BYTES, ".docx")?);
        break;
    }
    let document = document.ok_or("这个 .docx 里没有 word/document.xml")?;
    let rewritten = rewrite_document_xml(&document, edits, deleted, inserts, removals, moves)?;
    if rewritten == document {
        // The pane re-sent what the file already says. Writing it again would cost a rewrite of the
        // whole archive and push a history entry that takes back nothing, so one Ctrl+Z after it
        // would look broken. Nothing changes, so nothing happens.
        return Ok(guard_of(&meta));
    }
    // The part that is about to be replaced is what undo restores.
    remember_part(path, &document);
    write_document_part(path, &bytes, &rewritten)
}

/// One picture to take out of the document, named the way the reader numbered it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocxImageRemoval {
    /// Which of the part's drawings this is, counted from zero in the order the file writes them.
    ///
    /// Document wide rather than per paragraph, because a picture can sit in a table cell, whose
    /// paragraphs have no place in the block model to hang a number on.
    pub drawing: u32,
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
        write_docx_sync(&target, &edits, &deleted, &inserts, &[], &[], &guard)
    })
    .await
}

/// Takes one picture out of a `.docx`.
///
/// `paragraph` and `index` are the address the reader handed the pane: the paragraph's ordinal and
/// which of its drawings this is. Only the picture goes; the paragraph, its text and its properties
/// stay, and Ctrl+Z brings it back the same way it brings back a deleted paragraph, by restoring the
/// part that held it.
#[tauri::command]
pub async fn fs_delete_docx_image(
    app: tauri::AppHandle,
    path: String,
    drawing: u32,
    guard: DocxGuard,
    workspace: Option<WorkspaceEnv>,
) -> Result<DocxGuard, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_parent(&app.state::<WorkspaceRegistry>(), &target)?;
        let removals = [DocxImageRemoval { drawing }];
        write_docx_sync(&target, &[], &[], &[], &removals, &[], &guard)
    })
    .await
}

/// Moves one picture to the end of another paragraph.
///
/// `drawing` is the number the reader handed the pane and `to` is a paragraph ordinal, the same one
/// an edit names. The picture travels with nothing else: the paragraph it left keeps its text, and
/// the one it arrives in keeps everything it had.
#[tauri::command]
pub async fn fs_move_docx_image(
    app: tauri::AppHandle,
    path: String,
    drawing: u32,
    to: u32,
    guard: DocxGuard,
    workspace: Option<WorkspaceEnv>,
) -> Result<DocxGuard, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_parent(&app.state::<WorkspaceRegistry>(), &target)?;
        let moves = [DocxImageMove { drawing, to }];
        write_docx_sync(&target, &[], &[], &[], &[], &moves, &guard)
    })
    .await
}

/// The `w:val` of an element, which is what every Word property carries.
fn val(element: &BytesStart<'_>) -> Option<String> {
    attribute(element, b"val")
}

/// One run's text and the properties it states itself; the ones it inherits are applied when the
/// paragraph closes, because only then is its style known.
struct PendingRun {
    text: String,
    props: RunProps,
    /// The relationship id of a picture in this run, and the size to draw it at.
    image: Option<(String, Option<f32>, Option<f32>)>,
    /// Where in the part the picture was named; the drawing list turns it into the number the pane
    /// is given.
    image_at: Option<usize>,
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
    runs: Vec<PendingRun>,
    text: String,
    /// What the current run states about itself.
    run_props: RunProps,
    in_run: bool,
    in_text: bool,
    /// The relationship id of a picture seen in the current run, and its size.
    image_rid: Option<String>,
    /// Where in the part the picture of the current run was named.
    ///
    /// A byte offset rather than a counter: paragraphs inside a nested table are not read at all, so
    /// a counter here would skip their pictures and shift every number after them.
    image_at: Option<usize>,
    image_width: Option<f32>,
    image_height: Option<f32>,
    /// What the paragraph itself states about its box; the rest comes from its style.
    align: Option<String>,
    ind_left: Option<i32>,
    ind_first: Option<i32>,
    sp_before: Option<i32>,
    sp_after: Option<i32>,
    sp_line: Option<i32>,
    line_rule: Option<String>,
}

impl Paragraph {
    fn close_run(&mut self) {
        let text = std::mem::take(&mut self.text);
        let image = self.image_rid.take().map(|rid| {
            (
                rid,
                self.image_width.take(),
                self.image_height.take(),
            )
        });
        let image_at = self.image_at.take();
        if !text.is_empty() || image.is_some() {
            self.runs.push(PendingRun {
                text,
                props: std::mem::take(&mut self.run_props),
                image,
                image_at,
            });
        }
        self.run_props = RunProps::default();
        self.image_width = None;
        self.image_height = None;
    }

    /// This paragraph's own box, if it states one. Everything else comes from its style.
    fn own_box(&self) -> ParaProps {
        ParaProps {
            align: self.align.clone(),
            left: self.ind_left,
            first_line: self.ind_first,
            before: self.sp_before,
            after: self.sp_after,
            line: self.sp_line,
            line_rule: self.line_rule.clone(),
        }
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

/// What a run inherits when it says nothing itself: the document's defaults, then its paragraph
/// style's, then its own `w:rPr`. Every field is "the file said" or "nobody said".
#[derive(Default, Clone, PartialEq)]
struct RunProps {
    size: Option<f32>,
    color: Option<String>,
    font: Option<String>,
    bold: Option<bool>,
    italic: Option<bool>,
    underline: Option<bool>,
}

impl RunProps {
    /// `self` as the base and `over` as the winner: a run's own properties beat the ones it
    /// inherits, and an absent property inherits rather than meaning "off".
    fn over(self, over: &RunProps) -> RunProps {
        RunProps {
            size: over.size.or(self.size),
            color: over.color.clone().or(self.color),
            font: over.font.clone().or(self.font),
            bold: over.bold.or(self.bold),
            italic: over.italic.or(self.italic),
            underline: over.underline.or(self.underline),
        }
    }
}

/// A paragraph's own box, same rule: absent means inherited.
#[derive(Default, Clone)]
struct ParaProps {
    align: Option<String>,
    left: Option<i32>,
    first_line: Option<i32>,
    before: Option<i32>,
    after: Option<i32>,
    line: Option<i32>,
    line_rule: Option<String>,
}

impl ParaProps {
    fn over(self, over: &ParaProps) -> ParaProps {
        ParaProps {
            align: over.align.clone().or(self.align),
            left: over.left.or(self.left),
            first_line: over.first_line.or(self.first_line),
            before: over.before.or(self.before),
            after: over.after.or(self.after),
            line: over.line.or(self.line),
            line_rule: over.line_rule.clone().or(self.line_rule),
        }
    }
}

#[derive(Default, Clone)]
struct StyleDef {
    based_on: Option<String>,
    run: RunProps,
    para: ParaProps,
}

/// What `word/styles.xml` says a paragraph looks like.
///
/// Almost nothing Word writes is on the paragraph itself: 11pt Calibri lives in `docDefaults`,
/// a heading's 16pt bold lives in the `Heading1` style, and a document's own tweak lives in a style
/// that `basedOn`s the built-in one. Reading only the paragraph therefore draws a whole document at
/// whatever fallback the pane has - which is what "not like Word" looked like.
#[derive(Default)]
struct Styles {
    default_run: RunProps,
    default_para: ParaProps,
    paragraphs: std::collections::HashMap<String, StyleDef>,
}

impl Styles {
    /// The defaults a paragraph inherits, its style chain applied root first so the nearest wins.
    fn resolve(&self, style: Option<&str>) -> (RunProps, ParaProps) {
        let mut run = self.default_run.clone();
        let mut para = self.default_para.clone();
        let mut chain: Vec<&StyleDef> = Vec::new();
        let mut id = style.map(str::to_string);
        // `basedOn` chains are shallow; the bound is here because a file may name a cycle.
        for _ in 0..8 {
            let Some(name) = id.clone() else { break };
            let Some(definition) = self.paragraphs.get(&name) else {
                break;
            };
            chain.push(definition);
            id = definition.based_on.clone();
        }
        for definition in chain.into_iter().rev() {
            run = run.over(&definition.run);
            para = para.over(&definition.para);
        }
        (run, para)
    }
}

/// Where a property read from `styles.xml` belongs.
#[derive(Clone, Copy, PartialEq)]
enum StyleScope {
    None,
    DefaultsRun,
    DefaultsPara,
    StyleRun,
    StylePara,
}

/// `word/styles.xml`, read for the two things the pane has to know: what a run looks like, and what a
/// paragraph's box is.
fn parse_styles(xml: &str) -> Styles {
    let mut styles = Styles::default();
    let mut scope = StyleScope::None;
    let mut in_defaults = false;
    // (is it a paragraph style, its id, what it says)
    let mut current: Option<(bool, String, StyleDef)> = None;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = element.name();
                if is_w(name, b"docDefaults") {
                    in_defaults = true;
                } else if is_w(name, b"style") {
                    let style_type = attribute(&element, b"type").unwrap_or_default();
                    let id = attribute(&element, b"styleId").unwrap_or_default();
                    if style_type == "paragraph" || style_type == "character" {
                        current = Some((style_type == "paragraph", id, StyleDef::default()));
                    }
                } else if is_w(name, b"basedOn") {
                    if let (Some((_, _, definition)), Some(value)) = (current.as_mut(), val(&element))
                    {
                        definition.based_on = Some(value);
                    }
                } else if is_w(name, b"rPr") {
                    scope = if in_defaults {
                        StyleScope::DefaultsRun
                    } else if current.is_some() {
                        StyleScope::StyleRun
                    } else {
                        StyleScope::None
                    };
                } else if is_w(name, b"pPr") {
                    scope = if in_defaults {
                        StyleScope::DefaultsPara
                    } else if current.is_some() {
                        StyleScope::StylePara
                    } else {
                        StyleScope::None
                    };
                } else if matches!(scope, StyleScope::DefaultsRun | StyleScope::StyleRun) {
                    let props = match scope {
                        StyleScope::DefaultsRun => &mut styles.default_run,
                        _ => match current.as_mut() {
                            Some((_, _, definition)) => &mut definition.run,
                            None => continue,
                        },
                    };
                    if is_w(name, b"sz") {
                        props.size = val(&element)
                            .and_then(|value| value.parse::<f32>().ok())
                            .map(|half_points| half_points / 2.0);
                    } else if is_w(name, b"color") {
                        props.color = color_of(&element);
                    } else if is_w(name, b"rFonts") {
                        props.font = font_of(&element);
                    } else if is_w(name, b"b") {
                        props.bold = Some(toggled(&element));
                    } else if is_w(name, b"i") {
                        props.italic = Some(toggled(&element));
                    } else if is_w(name, b"u") {
                        props.underline = Some(toggled(&element));
                    }
                } else if matches!(scope, StyleScope::DefaultsPara | StyleScope::StylePara) {
                    let props = match scope {
                        StyleScope::DefaultsPara => &mut styles.default_para,
                        _ => match current.as_mut() {
                            Some((_, _, definition)) => &mut definition.para,
                            None => continue,
                        },
                    };
                    read_box(props, name, &element);
                }
            }
            Ok(Event::End(element)) => {
                let name = element.name();
                if is_w(name, b"docDefaults") {
                    in_defaults = false;
                } else if is_w(name, b"rPr") || is_w(name, b"pPr") {
                    scope = StyleScope::None;
                } else if is_w(name, b"style") {
                    if let Some((is_paragraph, id, definition)) = current.take() {
                        if is_paragraph {
                            styles.paragraphs.insert(id, definition);
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    styles
}

/// A paragraph's box from a `w:jc` / `w:ind` / `w:spacing` element.
fn read_box(props: &mut ParaProps, name: QName<'_>, element: &BytesStart<'_>) {
    if is_w(name, b"jc") {
        props.align = val(element);
    } else if is_w(name, b"ind") {
        props.left = attribute(element, b"left").and_then(|value| value.parse().ok());
        props.first_line = match attribute(element, b"hanging")
            .and_then(|value| value.parse::<i32>().ok())
        {
            // A hanging indent is a first line that starts outdented.
            Some(hanging) => Some(-hanging),
            None => attribute(element, b"firstLine").and_then(|value| value.parse().ok()),
        };
    } else if is_w(name, b"spacing") {
        props.before = attribute(element, b"before").and_then(|value| value.parse().ok());
        props.after = attribute(element, b"after").and_then(|value| value.parse().ok());
        props.line = attribute(element, b"line").and_then(|value| value.parse().ok());
        props.line_rule = attribute(element, b"lineRule");
    }
}

/// `w:color`, ignoring Word's `auto`.
fn color_of(element: &BytesStart<'_>) -> Option<String> {
    val(element)
        .filter(|value| !value.eq_ignore_ascii_case("auto"))
        .map(|value| format!("#{}", value.to_ascii_lowercase()))
}

/// `w:rFonts`: the Latin face, or the East Asian one, whichever the element names.
fn font_of(element: &BytesStart<'_>) -> Option<String> {
    attribute(element, b"ascii")
        .or_else(|| attribute(element, b"hAnsi"))
        .or_else(|| attribute(element, b"eastAsia"))
        .filter(|value| !value.is_empty())
}

/// The fonts the theme names, Latin then East Asian.
///
/// Word's default run has no font of its own: it says `w:asciiTheme="minorHAnsi"` and the face is in
/// `word/theme/theme1.xml`. Without it, a document that never picks a font is drawn in the pane's own
/// fallback rather than in Calibri.
fn theme_fonts(xml: &str) -> (Option<String>, Option<String>) {
    let mut latin = None;
    let mut east_asian = None;
    let mut in_minor = false;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = element.name();
                let local = name.local_name();
                if local.as_ref() == b"minorFont" {
                    in_minor = true;
                } else if in_minor && local.as_ref() == b"latin" {
                    latin = attribute(&element, b"typeface");
                } else if in_minor && local.as_ref() == b"ea" {
                    east_asian = attribute(&element, b"typeface");
                }
            }
            Ok(Event::End(element)) => {
                if element.name().local_name().as_ref() == b"minorFont" {
                    in_minor = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    (latin, east_asian)
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
fn read_property(
    current: &mut Paragraph,
    name: QName<'_>,
    element: &BytesStart<'_>,
    at: usize,
) {
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
        current.run_props.bold = Some(toggled(element));
    } else if current.in_run && is_w(name, b"i") {
        current.run_props.italic = Some(toggled(element));
    } else if current.in_run && is_w(name, b"u") {
        // `w:u` carries the line style (`single`, `double`, …); `none` is the one that is off.
        current.run_props.underline = Some(toggled(element));
    } else if current.in_run && is_w(name, b"sz") {
        current.run_props.size = val(element)
            .and_then(|value| value.parse::<f32>().ok())
            .map(|half_points| half_points / 2.0);
    } else if current.in_run && is_w(name, b"color") {
        current.run_props.color = color_of(element);
    } else if current.in_run && is_w(name, b"rFonts") {
        current.run_props.font = font_of(element);
    } else if !current.in_run && is_w(name, b"jc") {
        current.align = val(element);
    } else if !current.in_run && is_w(name, b"ind") {
        let mut box_props = ParaProps {
            align: None,
            left: current.ind_left,
            first_line: current.ind_first,
            before: None,
            after: None,
            line: None,
            line_rule: None,
        };
        read_box(&mut box_props, name, element);
        current.ind_left = box_props.left;
        current.ind_first = box_props.first_line;
    } else if !current.in_run && is_w(name, b"spacing") {
        let mut box_props = ParaProps {
            align: None,
            left: None,
            first_line: None,
            before: current.sp_before,
            after: current.sp_after,
            line: current.sp_line,
            line_rule: current.line_rule.clone(),
        };
        read_box(&mut box_props, name, element);
        current.sp_before = box_props.before;
        current.sp_after = box_props.after;
        current.sp_line = box_props.line;
        current.line_rule = box_props.line_rule;
    } else if name.local_name().as_ref() == b"blip" {
        // `a:blip` lives in the drawing namespace, so its name is not `w:`; `r:embed` names the
        // relationship the media file hangs off.
        current.image_rid = attribute_any(element, b"embed").or_else(|| current.image_rid.clone());
        if current.image_rid.is_some() {
            current.image_at = Some(at);
        }
    } else if name.local_name().as_ref() == b"extent" {
        // `wp:extent` carries the size the document draws the picture at, in EMU.
        current.image_width = attribute(element, b"cx")
            .and_then(|value| value.parse::<f64>().ok())
            .map(|emu| (emu / EMU_PER_PX) as f32);
        current.image_height = attribute(element, b"cy")
            .and_then(|value| value.parse::<f64>().ok())
            .map(|emu| (emu / EMU_PER_PX) as f32);
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
/// The document without its styles or paper - what the tests below read a fixture with.
#[cfg(test)]
fn parse_blocks(
    document_xml: &str,
    numbering_xml: Option<&str>,
) -> Result<(Vec<Block>, bool), String> {
    let (blocks, truncated, _) = parse_document(
        document_xml,
        numbering_xml,
        &Styles::default(),
        &std::collections::HashMap::new(),
        &std::collections::HashMap::new(),
    )?;
    Ok((blocks, truncated))
}

/// The document, read with the styles and the paper it declares.
fn parse_document(
    document_xml: &str,
    numbering_xml: Option<&str>,
    styles: &Styles,
    images: &std::collections::HashMap<String, String>,
    notes: &std::collections::HashMap<String, String>,
) -> Result<(Vec<Block>, bool, Option<Page>), String> {
    let ordered_numbers = numbering_xml.map(ordered_number_ids).unwrap_or_default();
    // Where each drawing starts, in the order the file writes them. The writer cuts by this same
    // count, so the two cannot disagree about which picture a number names.
    let drawings = drawing_offsets(document_xml);
    let mut blocks: Vec<Block> = Vec::new();
    let mut truncated = false;

    let mut paragraph: Option<Paragraph> = None;
    let mut table: Option<Vec<Vec<Vec<Run>>>> = None;
    let mut row: Option<Vec<Vec<Run>>> = None;
    let mut cell: Option<Vec<Run>> = None;
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

    let mut alternates = Alternates::default();
    // A paragraph can open inside another: a text box holds paragraphs of its own, inside a run of
    // the document's. The outer one is kept here and put back when the inner one closes, and what
    // the inner ones wrote is drawn after it. The model has no floating boxes, so the text is drawn
    // where the box is anchored - which keeps it in the document instead of dropping it, and keeps
    // the anchored paragraph's own words, which replacing it used to lose.
    let mut outer: Vec<Paragraph> = Vec::new();
    let mut inside: Vec<Block> = Vec::new();
    // The notes a paragraph cited, waiting for that paragraph to close: the pane has no page foot,
    // so a note is drawn after the paragraph that cites it.
    let mut pending_notes: Vec<String> = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = element.name();
                let at = reader.buffer_position() as usize;
                open_elements += 1;
                if alternates.start(name) {
                    continue;
                }
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
                // A table inside a cell has no rows of the outer table: its own `tr` and `tc` are
                // skipped, while its paragraphs are read into the cell it sits in. The model has no
                // table for a table to sit inside, and dropping the text lost it - one real file
                // keeps 171 characters in a table inside a cell.
                if nested_table_depth > 0 && (is_w(name, b"tr") || is_w(name, b"tc")) {
                    continue;
                }
                if is_w(name, b"tr") {
                    row = Some(Vec::new());
                } else if is_w(name, b"tc") {
                    cell = Some(Vec::new());
                } else if let Some(index) = paragraph_index {
                    if let Some(open) = paragraph.take() {
                        outer.push(open);
                    }
                    paragraph = Some(Paragraph {
                        index,
                        ..Default::default()
                    });
                } else if is_w(name, b"footnoteReference") {
                    if let Some(note) = attribute(&element, b"id").and_then(|id| notes.get(&id)) {
                        pending_notes.push(note.clone());
                    }
                } else if let Some(current) = paragraph.as_mut() {
                    if is_w(name, b"r") {
                        current.in_run = true;
                    } else if is_w(name, b"t") {
                        current.in_text = true;
                    } else {
                        read_property(current, name, &element, at);
                    }
                }
            }
            Ok(Event::Empty(element)) => {
                let name = element.name();
                let at = reader.buffer_position() as usize;
                if alternates.skipping() {
                    continue;
                }
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
                                align: None,
                                size: None,
                                indent: None,
                                spacing: None,
                            });
                        }
                    }
                }
                if nested_table_depth > 0 {
                    continue;
                }
                // Word writes the reference self-closing, which is the usual shape.
                if is_w(name, b"footnoteReference") {
                    if let Some(note) = attribute(&element, b"id").and_then(|id| notes.get(&id)) {
                        pending_notes.push(note.clone());
                    }
                    continue;
                }
                if let Some(current) = paragraph.as_mut() {
                    read_property(current, name, &element, at);
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
                if alternates.end(name) {
                    continue;
                }
                if is_w(name, b"tbl") {
                    if nested_table_depth > 0 {
                        nested_table_depth -= 1;
                    } else if let Some(rows) = table.take() {
                        blocks.push(Block::Table { rows });
                        flush_notes(&mut blocks, &mut pending_notes, &mut truncated);
                    }
                    continue;
                }
                if nested_table_depth > 0 && (is_w(name, b"tr") || is_w(name, b"tc")) {
                    continue;
                }
                if is_w(name, b"tr") {
                    if let (Some(rows), Some(cells)) = (table.as_mut(), row.take()) {
                        rows.push(cells);
                    }
                } else if is_w(name, b"tc") {
                    if let (Some(cells), Some(runs)) = (row.as_mut(), cell.take()) {
                        cells.push(trimmed(runs));
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
                    let numbering = finished.numbering.clone();
                    let style = finished.style.clone();
                    let own = finished.own_box();
                    let heading = finished.heading();
                    let index = finished.index;
                    let (inherited_run, inherited_box) = styles.resolve(style.as_deref());
                    let placed = inherited_box.over(&own);
                    let runs: Vec<Run> = finished
                        .runs
                        .into_iter()
                        .map(|pending| {
                            let props = inherited_run.clone().over(&pending.props);
                            let picture = pending.image.as_ref();
                            Run {
                                text: pending.text,
                                bold: props.bold.unwrap_or(false),
                                italic: props.italic.unwrap_or(false),
                                underline: props.underline.unwrap_or(false),
                                size: props.size,
                                color: props.color,
                                font: props.font,
                                image: picture.and_then(|(rid, _, _)| images.get(rid)).cloned(),
                                image_width: picture.and_then(|(_, width, _)| *width),
                                image_height: picture.and_then(|(_, _, height)| *height),
                                // The picture is named inside its own drawing, so the count of
                                // drawings that start before it includes itself.
                                image_index: pending.image_at.map(|at| {
                                    (drawings.iter().take_while(|start| **start < at).count() as u32)
                                        .saturating_sub(1)
                                }),
                            }
                        })
                        .collect();
                    if let Some(target) = cell.as_mut() {
                        // A cell's paragraph belongs to the cell, one line: its runs are appended,
                        // with a space between paragraphs.
                        if !target.is_empty() && !runs.is_empty() {
                            target.push(Run {
                                text: " ".into(),
                                ..Default::default()
                            });
                        }
                        target.extend(runs);
                    } else if blocks.len() + inside.len() >= MAX_BLOCKS {
                        truncated = true;
                    } else {
                        // Every paragraph of the body is a block, blank ones included: a blank line
                        // is where the caret goes when Enter is pressed at the end of a document,
                        // and a read that dropped it left that caret nowhere to land.
                        let list = numbering.as_ref().map(|(level, id)| ListItem {
                            ordered: ordered_numbers.contains(id),
                            level: *level,
                            num_id: id.parse().unwrap_or_default(),
                        });
                        let block = Block::Paragraph {
                            index,
                            heading,
                            list,
                            runs,
                            align: placed.align,
                            size: inherited_run.size,
                            indent: (placed.left.is_some() || placed.first_line.is_some()).then_some(
                                Indent {
                                    left: placed.left,
                                    first_line: placed.first_line,
                                },
                            ),
                            spacing: (placed.before.is_some()
                                || placed.after.is_some()
                                || placed.line.is_some())
                            .then_some(Spacing {
                                before: placed.before,
                                after: placed.after,
                                line: placed.line,
                                line_rule: placed.line_rule,
                            }),
                        };
                        if outer.is_empty() {
                            blocks.push(block);
                            flush_notes(&mut blocks, &mut pending_notes, &mut truncated);
                        } else {
                            inside.push(block);
                        }
                    }
                    // The paragraph this one opened inside comes back, and what this one wrote is
                    // drawn after it rather than before it.
                    let body_paragraph = outer.is_empty();
                    paragraph = outer.pop();
                    if body_paragraph {
                        blocks.append(&mut inside);
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

    Ok((blocks, truncated, read_page(document_xml)))
}

/// The section's paper: `w:pgSz` and `w:pgMar`, usually in the `w:sectPr` that ends the body.
///
/// Word writes one per section; a document with several sections has several, and the pane draws one
/// sheet, so the last one wins - which is the one a reader scrolls into.
fn read_page(document_xml: &str) -> Option<Page> {
    let mut page = Page::default();
    let mut seen = false;
    let mut reader = Reader::from_str(document_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let name = element.name();
                if is_w(name, b"pgSz") {
                    page.width = attribute(&element, b"w").and_then(|value| value.parse().ok());
                    page.height = attribute(&element, b"h").and_then(|value| value.parse().ok());
                    seen = true;
                } else if is_w(name, b"pgMar") {
                    page.margin_top = attribute(&element, b"top").and_then(|value| value.parse().ok());
                    page.margin_right =
                        attribute(&element, b"right").and_then(|value| value.parse().ok());
                    page.margin_bottom =
                        attribute(&element, b"bottom").and_then(|value| value.parse().ok());
                    page.margin_left =
                        attribute(&element, b"left").and_then(|value| value.parse().ok());
                    seen = true;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    seen.then_some(page)
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

    /// A paragraph that carries a text box, as Word writes one: the box twice over, once as
    /// DrawingML inside `mc:Choice` and once as VML inside `mc:Fallback`.
    fn paragraph_with_a_text_box() -> String {
        document(
            r#"<w:p><w:r><w:t>before</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>after</w:t></w:r></w:p>"#,
        )
    }

    /// Every `<w:t>` of a part, in the order the file states them.
    fn text_nodes(xml: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(false);
        let mut inside = false;
        loop {
            match reader.read_event() {
                Ok(Event::Start(element)) if is_w(element.name(), b"t") => inside = true,
                Ok(Event::End(element)) if is_w(element.name(), b"t") => inside = false,
                Ok(Event::Text(text)) if inside => {
                    out.push(text.decode().unwrap_or_default().into_owned());
                }
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        out
    }

    /// The text of each paragraph block, in the order the pane draws them.
    fn block_texts(blocks: &[Block]) -> Vec<String> {
        blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { runs, .. } => Some(runs.iter().map(|run| run.text.as_str()).collect()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_prefixed_checks_match() {
        use quick_xml::name::QName as Q;
        assert!(is_mc(Q(b"mc:AlternateContent"), b"AlternateContent"));
        assert!(is_mc(Q(b"mc:Fallback"), b"Fallback"));
        assert!(!is_mc(Q(b"w:p"), b"p"));
        assert!(is_w(Q(b"w:p"), b"p"));
    }

    #[test]
    fn a_text_box_written_twice_is_read_once() {
        // Word writes every text box twice: once for readers that understand DrawingML and once for
        // readers that do not. Reading both put every box in the document twice - one notes file of
        // 20 boxes held 10 distinct texts, each drawn twice.
        let xml = paragraph_with_a_text_box();
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        assert_eq!(block_texts(&blocks), vec!["before", "boxed", "after"]);
        // And the ordinals are the document's own: the pane addresses paragraphs by them.
        let indexes: Vec<u32> = blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { index, .. } => Some(*index),
                _ => None,
            })
            .collect();
        assert_eq!(indexes, vec![0, 1, 2]);
    }

    #[test]
    fn an_edit_after_a_text_box_lands_in_the_paragraph_it_names() {
        // The read and the write number paragraphs the same way, over both copies of a box and over
        // the box's own paragraph. If they disagreed, an edit would land in another paragraph - or
        // inside the box - and what came back would not be the document the reader was looking at.
        let xml = document(
            r#"<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p>"#,
        );
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        // The box's anchor is the empty line before it; the box's own text follows it.
        assert_eq!(block_texts(&blocks), vec!["", "boxed", "one", "two"]);
        let last = blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { index, .. } => Some(*index),
                _ => None,
            })
            .next_back()
            .expect("the document has paragraphs");
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: last,
                text: "changed".into(),
            }],
            &[], &[], &[], &[])
        .expect("the last paragraph is editable");
        assert!(written.contains("<w:t>changed</w:t>"), "{written}");
        assert!(!written.contains("<w:t>two</w:t>"), "{written}");
        assert!(written.contains("<w:t>one</w:t>"), "{written}");
        // Both copies of the box are left as they were: an edit is not a rewrite of the box.
        assert_eq!(written.matches("<w:t>boxed</w:t>").count(), 2, "{written}");
    }

    #[test]
    fn an_edit_to_a_box_is_written_into_both_of_its_copies() {
        // The box is read from its `mc:Choice` copy, so that is where the edit lands. The
        // `mc:Fallback` copy is what an older reader shows, and leaving it as it was put two
        // different texts in the file for one box.
        let xml = paragraph_with_a_text_box();
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        let boxed = blocks
            .iter()
            .find_map(|block| match block {
                Block::Paragraph { index, runs, .. }
                    if runs.iter().any(|run| run.text == "boxed") =>
                {
                    Some(*index)
                }
                _ => None,
            })
            .expect("the box is a paragraph of the document");
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: boxed,
                text: "boxed again".into(),
            }],
            &[], &[], &[], &[])
        .expect("a box's text is editable");
        assert_eq!(
            text_nodes(&written),
            vec!["before", "boxed again", "boxed again", "after"],
            "{written}"
        );
    }

    #[test]
    fn an_edit_to_a_paragraph_beside_a_box_leaves_the_box_alone() {
        // The twin of the test above: nothing may be written into a copy that was not edited.
        let xml = paragraph_with_a_text_box();
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        let first = blocks
            .iter()
            .find_map(|block| match block {
                Block::Paragraph { index, .. } => Some(*index),
                _ => None,
            })
            .expect("the document has paragraphs");
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: first,
                text: "before again".into(),
            }],
            &[], &[], &[], &[])
        .expect("the first paragraph is editable");
        assert_eq!(
            text_nodes(&written),
            vec!["before again", "boxed", "boxed", "after"],
            "{written}"
        );
    }

    #[test]
    fn a_text_box_that_only_has_a_fallback_is_still_read() {
        // A part may state the old form alone. Skipping it there would lose the text, so the fallback
        // is only left alone when the choice above it held something this reader draws. The
        // paragraph the box is anchored in is kept as the empty line it is, because paragraph
        // ordinals are what the writer addresses and they are the document's own.
        let xml = document(
            r#"<w:p><w:r><mc:AlternateContent><mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>only</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>"#,
        );
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        assert_eq!(block_texts(&blocks), vec!["", "only"]);
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
                    Run { text: "bold".into(), bold: true, ..Default::default() },
                    Run { text: " then ".into(), ..Default::default() },
                    Run { text: "both".into(), italic: true, underline: true, ..Default::default() },
                ],
                align: None,
                size: None,
                indent: None,
                spacing: None,
            }]
        );
    }

    /// The styles part, in the shape Word writes one: defaults, then a paragraph style that another
    /// one builds on.
    fn styles_part() -> Styles {
        parse_styles(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Tight"><w:basedOn w:val="Base"/><w:pPr><w:spacing w:before="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>"#,
        )
    }

    /// A table's cell texts, which is what the cells used to be - the styling is checked separately.
    fn table_texts(blocks: &[Block]) -> Vec<Vec<String>> {
        blocks
            .iter()
            .filter_map(|block| match block {
                Block::Table { rows } => Some(
                    rows.iter()
                        .map(|row| {
                            row.iter()
                                .map(|cell| {
                                    cell.iter()
                                        .map(|run| run.text.as_str())
                                        .collect::<String>()
                                })
                                .collect()
                        })
                        .collect(),
                ),
                _ => None,
            })
            .next()
            .unwrap_or_default()
    }

    fn paragraph_of(blocks: &[Block]) -> &Block {
        blocks
            .iter()
            .find(|block| matches!(block, Block::Paragraph { .. }))
            .expect("a paragraph")
    }

    #[test]
    fn a_run_carries_the_size_colour_and_face_the_file_gives_it() {
        let xml = document(
            r#"<w:p><w:r><w:rPr><w:sz w:val="28"/><w:color w:val="C00000"/><w:rFonts w:ascii="Georgia"/></w:rPr><w:t>red</w:t></w:r><w:r><w:rPr><w:color w:val="auto"/></w:rPr><w:t>auto</w:t></w:r></w:p>"#,
        );
        let blocks = parse_blocks(&xml, None).unwrap().0;
        let Block::Paragraph { runs, .. } = paragraph_of(&blocks) else {
            unreachable!()
        };
        assert_eq!(runs[0].size, Some(14.0));
        assert_eq!(runs[0].color.as_deref(), Some("#c00000"));
        assert_eq!(runs[0].font.as_deref(), Some("Georgia"));
        // `auto` is not a colour: drawing it as one would paint black where the pane's own text
        // colour belongs.
        assert_eq!(runs[1].color, None);
    }

    #[test]
    fn a_paragraph_box_comes_from_the_paragraph_then_its_style_chain() {
        let xml = document(
            r#"<w:p><w:pPr><w:pStyle w:val="Tight"/><w:jc w:val="center"/></w:pPr><w:r><w:t>centred</w:t></w:r></w:p>"#,
        );
        let (blocks, _, _) = parse_document(&xml, None, &styles_part(), &Default::default(), &Default::default()).unwrap();
        let Block::Paragraph { align, indent, spacing, runs, .. } = paragraph_of(&blocks) else {
            unreachable!()
        };
        // Its own `w:jc` wins; the indent and the spacing come from the style, and the style's
        // `basedOn` is where the indent lives.
        assert_eq!(align.as_deref(), Some("center"));
        assert_eq!(indent.as_ref().and_then(|value| value.left), Some(720));
        assert_eq!(spacing.as_ref().and_then(|value| value.before), Some(240));
        // The document default is 11pt; the style says 16 and bold, and the run says neither.
        assert_eq!(runs[0].size, Some(16.0));
        assert!(runs[0].bold);
        assert_eq!(runs[0].font.as_deref(), Some("Calibri"));
    }

    #[test]
    fn a_run_that_states_its_own_size_keeps_it_over_the_style() {
        let xml = document(
            r#"<w:p><w:pPr><w:pStyle w:val="Tight"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:b w:val="0"/></w:rPr><w:t>small</w:t></w:r></w:p>"#,
        );
        let (blocks, _, _) = parse_document(&xml, None, &styles_part(), &Default::default(), &Default::default()).unwrap();
        let Block::Paragraph { runs, .. } = paragraph_of(&blocks) else {
            unreachable!()
        };
        assert_eq!(runs[0].size, Some(9.0));
        // Inherited bold is on, and the run turns it off rather than saying nothing.
        assert!(!runs[0].bold);
    }

    #[test]
    fn the_paper_comes_from_the_section() {
        let xml = document(
            r#"<w:p><w:r><w:t>a</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1701" w:bottom="1134" w:left="1701"/></w:sectPr>"#,
        );
        let (_, _, page) = parse_document(&xml, None, &Styles::default(), &Default::default(), &Default::default()).unwrap();
        let page = page.expect("A4 in twips");
        assert_eq!(page.width, Some(11906));
        assert_eq!(page.height, Some(16838));
        assert_eq!(page.margin_left, Some(1701));
        // A document that names no section is drawn on the pane's own paper, not a wrong one.
        let (_, _, none) = parse_document(&document("<w:p/>"), None, &Styles::default(), &Default::default(), &Default::default()).unwrap();
        assert!(none.is_none());
    }

    #[test]
    fn a_picture_is_read_out_of_the_archive_at_the_size_it_is_drawn() {
        let picture = r#"<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"#;
        let bytes = archive(&[
            ("[Content_Types].xml", "<Types/>"),
            ("word/document.xml", &document(picture)),
            (
                "word/_rels/document.xml.rels",
                r#"<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>"#,
            ),
            ("word/media/image1.png", "not really a png, but the bytes"),
        ]);
        let package = parts(&bytes).unwrap();
        let image = package
            .images
            .get("rId5")
            .expect("the relationship names the picture");
        assert!(image.starts_with("data:image/png;base64,"), "{image}");
        let notes = package
            .footnotes
            .as_deref()
            .map(read_notes)
            .unwrap_or_default();
        let (blocks, _, _) = parse_document(
            &package.document,
            None,
            &Styles::default(),
            &package.images,
            &notes,
        )
        .unwrap();
        let Block::Paragraph { runs, .. } = paragraph_of(&blocks) else {
            unreachable!()
        };
        // 952500 EMU is 100px, 476250 is 50px: the size the document draws it at.
        assert_eq!(runs[0].image.as_deref(), Some(image.as_str()));
        assert_eq!(runs[0].image_width, Some(100.0));
        assert_eq!(runs[0].image_height, Some(50.0));
    }

    #[test]
    fn the_theme_names_the_default_face() {
        let theme = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fontScheme><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface="宋体"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="等线"/></a:minorFont></a:fontScheme></a:theme>"#;
        let (latin, east_asian) = theme_fonts(theme);
        assert_eq!(latin.as_deref(), Some("Calibri"));
        assert_eq!(east_asian.as_deref(), Some("等线"));
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
                align: None,
                size: None,
                indent: None,
                spacing: None,
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
            table_texts(&blocks),
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["c second".to_string(), String::new()],
            ]
        );
    }

    #[test]
    fn a_cell_keeps_the_styling_of_its_runs() {
        // A header row is bold because its runs are: reading a cell as one string lost that, and the
        // table was drawn in one weight whatever Word said.
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/><w:sz w:val="26"/></w:rPr><w:t>head</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#,
        );
        let (blocks, _) = parse_blocks(&xml, None).unwrap();
        let Block::Table { rows } = &blocks[0] else {
            panic!("expected a table");
        };
        assert_eq!(rows[0][0][0].text, "head");
        assert!(rows[0][0][0].bold);
        assert_eq!(rows[0][0][0].size, Some(13.0));
    }

    /// A footnotes part, as Word writes one: a separator, a continuation separator, and a note.
    fn footnotes_part() -> String {
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>a note</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>line one</w:t></w:r></w:p><w:p><w:r><w:t>line two</w:t></w:r></w:p></w:footnote></w:footnotes>"#.to_string()
    }

    #[test]
    fn a_footnote_s_text_is_read_apart_from_the_separators() {
        // The part holds the rule above the notes as footnotes of their own, marked by `w:type`. They
        // are not notes, and a note of two paragraphs is one note, not two.
        let notes = read_notes(&footnotes_part());
        assert_eq!(notes.get("1").map(String::as_str), Some("a note"));
        assert_eq!(notes.get("2").map(String::as_str), Some("line one line two"));
        assert!(!notes.contains_key("-1"), "the separator is not a note");
        assert!(!notes.contains_key("0"), "the continuation separator is not a note");
    }

    #[test]
    fn a_note_is_drawn_after_the_paragraph_that_cites_it() {
        // The body only cites the note; its text is in another part. The pane has no page foot, so
        // the note is drawn after the paragraph - as a block of its own, because a paragraph is what
        // the pane hands back for writing, and a note folded into it would be written into the body.
        let xml = document(
            r#"<w:p><w:r><w:t>cited</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p><w:p><w:r><w:t>after</w:t></w:r></w:p>"#,
        );
        let notes = read_notes(&footnotes_part());
        let (blocks, truncated, _) =
            parse_document(&xml, None, &Styles::default(), &Default::default(), &notes).unwrap();
        assert!(!truncated);
        // Three blocks: the paragraph that cites, the note, and the paragraph after it.
        assert_eq!(blocks.len(), 3, "{blocks:?}");
        assert_eq!(block_texts(&blocks), vec!["cited", "after"]);
        assert!(matches!(&blocks[0], Block::Paragraph { index: 0, .. }));
        let Block::Note { text } = &blocks[1] else {
            panic!("expected a note between the two paragraphs: {blocks:?}");
        };
        assert_eq!(text, "a note");
        assert!(matches!(&blocks[2], Block::Paragraph { index: 1, .. }));
    }

    #[test]
    fn a_reference_the_notes_part_does_not_have_draws_nothing() {
        // A part may cite a note it does not hold - a deleted note, or a file written by something
        // else - and that must not become an empty line in the document.
        let xml = document(
            r#"<w:p><w:r><w:t>cited</w:t></w:r><w:r><w:footnoteReference w:id="99"/></w:r></w:p>"#,
        );
        let notes = read_notes(&footnotes_part());
        let (blocks, _, _) =
            parse_document(&xml, None, &Styles::default(), &Default::default(), &notes).unwrap();
        assert_eq!(block_texts(&blocks), vec!["cited"]);
    }

    #[test]
    fn a_nested_table_is_read_into_the_cell_it_sits_in() {
        // A cell holds one line here and the model has no table for a table to sit inside, so a
        // table inside a cell used to be skipped whole and its text lost. Its paragraphs are drawn
        // in the cell now, one space apart, and its own rows stay out of the outer table's rows.
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:tc></w:tr></w:tbl>"#,
        );
        assert_eq!(
            table_texts(&parse_blocks(&xml, None).unwrap().0),
            vec![vec!["outer inner".to_string()]]
        );
    }

    #[test]
    fn a_two_by_two_table_inside_a_cell_is_one_line_in_it() {
        // The shape of the one real file that has this: 171 characters in a 2x2 table inside a cell
        // of a table. Every cell of it is drawn, in reading order, and the outer table still has the
        // one row and the one cell it states.
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>
            <w:tbl>
              <w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
              <w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>d</w:t></w:r></w:p></w:tc></w:tr>
            </w:tbl>
            </w:tc></w:tr></w:tbl>"#,
        );
        let blocks = parse_blocks(&xml, None).unwrap().0;
        assert_eq!(
            table_texts(&blocks),
            vec![vec!["outer a b c d".to_string()]]
        );
        let Block::Table { rows } = &blocks[0] else {
            panic!("expected one table");
        };
        assert_eq!(rows.len(), 1, "the outer table keeps its own rows");
        assert_eq!(rows[0].len(), 1, "and its own cells");
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
            &[], &[], &[])
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
            &[], &[], &[])
        .expect("a mixed paragraph is still editable");
        assert!(
            written.contains("<w:rPr><w:b/></w:rPr><w:t>changed</w:t>"),
            "{written}"
        );
        assert!(!written.contains("plain"), "{written}");
    }

    #[test]
    fn a_paragraph_with_custom_tab_stops_can_still_be_edited() {
        // `<w:tabs>` starts with the same four characters as `<w:t>`: a scan that matched the prefix
        // took the properties for a text node, could not find its end, and failed the whole save.
        let xml = document(
            r#"<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>a</w:t></w:r></w:p>"#,
        );
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: 0,
                text: "b".into(),
            }],
            &[],
            &[], &[], &[])
        .expect("a paragraph with tab stops is still editable");
        assert!(written.contains("<w:tabs>"), "{written}");
        assert!(written.contains("<w:t>b</w:t>"), "{written}");
    }

    #[test]
    fn a_tab_inside_a_paragraph_is_not_taken_for_a_text_node() {
        // A `<w:tab/>` sits between two runs. Treated as an empty `<w:t>`, the run after it was
        // emptied - the tab and the rest of the line silently disappeared.
        let xml = document(
            r#"<w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>c</w:t></w:r></w:p>"#,
        );
        let written = rewrite_document_xml(
            &xml,
            &[DocxEdit {
                index: 0,
                text: "a	c".into(),
            }],
            &[],
            &[], &[], &[])
        .expect("a paragraph with a tab is still editable");
        assert!(written.contains("<w:tab/>"), "{written}");
        assert!(written.contains("<w:t>a	c</w:t>"), "{written}");
    }

    #[test]
    fn an_empty_paragraph_round_trips_untouched() {
        let xml = document("<w:p/><w:p><w:r><w:t>x</w:t></w:r></w:p>");
        let written = rewrite_document_xml(&xml, &[], &[], &[], &[], &[]).expect("nothing to change");
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
            }], &[], &[])
        .expect("an insert before the first paragraph should land");
        let first = written.find("first").expect("the new paragraph is in the part");
        let second = written.find("second").expect("the old paragraph is in the part");
        assert!(first < second, "{written}");
    }

    #[test]
    fn an_insert_at_the_top_does_not_land_inside_a_table() {
        // A paragraph inside a table is a paragraph too, and it comes first. Inserting "in front of
        // everything" at the first paragraph therefore put the new line inside the table's first
        // cell - and gave it the cell's own paragraph properties, so a right-aligned cell produced a
        // right-aligned body line.
        let xml = document(
            r#"<w:tbl><w:tr><w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>after</w:t></w:r></w:p>"#,
        );
        let written = rewrite_document_xml(
            &xml,
            &[],
            &[],
            &[DocxInsert {
                after: None,
                text: "first".into(),
            }], &[], &[])
        .expect("an insert at the top should land");
        let new_line = written.find("<w:t>first</w:t>").expect("the new line is in the part");
        let table_end = written.find("</w:tbl>").expect("the table is in the part");
        let old_line = written.find("<w:t>after</w:t>").expect("the old line is in the part");
        assert!(new_line > table_end, "the new line went inside the table: {written}");
        assert!(new_line < old_line, "the new line is not in front of the body's text: {written}");
        // And it takes the style of a body paragraph, not of a cell.
        let created = &written[..new_line];
        let created = &created[created.rfind("<w:p>").expect("the new paragraph starts")..];
        assert!(!created.contains("<w:jc"), "the new line took the cell's alignment: {written}");
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
            }], &[], &[])
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
            &[], &[], &[])
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
            rewrite_document_xml(xml, &[], &[0], &[], &[], &[]).expect("the deletion should apply");
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
            &[], &[], &[])
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
            &[], &[], &[])
        .is_err());
        assert!(rewrite_document_xml(xml, &[], &[9], &[], &[], &[]).is_err());
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
            }], &[], &[])
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
            }], &[], &[])
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
            }], &[], &[])
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
            }], &[], &[])
        .is_err());
        // And an insertion after a paragraph being deleted at the same time would land nowhere.
        assert!(rewrite_document_xml(
            xml,
            &[],
            &[0],
            &[DocxInsert {
                after: Some(0),
                text: "x".into(),
            }], &[], &[])
        .is_err());
    }

    /// One picture run as Word writes it.
    fn drawing(rid: &str) -> String {
        format!(
            r#"<w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:graphic><a:graphicData><a:blip r:embed="{rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
        )
    }

    #[test]
    fn a_paragraph_numbers_its_drawings_in_the_order_the_file_writes_them() {
        // The number is the address a deletion names, so it has to be the file's order and not the
        // order of the pictures that survived the size cap.
        let body = format!(
            "<w:p><w:r><w:t>before</w:t></w:r>{}<w:r><w:t>between</w:t></w:r>{}<w:r><w:t>after</w:t></w:r></w:p>",
            drawing("rId5"),
            drawing("rId6")
        );
        let (blocks, _, _) =
            parse_document(&document(&body), None, &Styles::default(), &Default::default(), &Default::default()).unwrap();
        let Block::Paragraph { runs, .. } = paragraph_of(&blocks) else {
            unreachable!()
        };
        let numbered: Vec<Option<u32>> = runs
            .iter()
            .filter(|run| run.image_index.is_some())
            .map(|run| run.image_index)
            .collect();
        assert_eq!(numbered, vec![Some(0), Some(1)]);
        // A run with no picture is not numbered at all.
        assert_eq!(runs[0].image_index, None);
    }

    #[test]
    fn a_drawing_is_cut_out_and_the_text_around_it_is_kept() {
        let paragraph = format!(
            "<w:p><w:r><w:t>before</w:t></w:r>{}<w:r><w:t>between</w:t></w:r>{}</w:p>",
            drawing("rId5"),
            drawing("rId6")
        );
        // The second one goes, and the first stays: cutting the wrong one would delete a picture the
        // reader numbered differently.
        let left = remove_drawing(&paragraph, 1).expect("the second drawing is there");
        assert!(left.contains(r#"r:embed="rId5""#));
        assert!(!left.contains(r#"r:embed="rId6""#));
        assert!(left.contains("<w:t>between</w:t>"));
        let left = remove_drawing(&left, 0).expect("the first drawing is still there");
        assert!(!left.contains("<w:drawing"));
        assert!(left.contains("<w:t>before</w:t>"));
        assert!(left.contains("<w:t>between</w:t>"));
        // Asking for a picture the paragraph does not have is refused rather than rewriting the
        // paragraph as if it had one.
        assert!(remove_drawing("<w:p><w:r><w:t>x</w:t></w:r></w:p>", 0).is_err());
    }

    /// A picture table for `parse_document`, so a cell keeps the run that holds one.
    fn picture_map() -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([
            ("rId5".to_string(), "data:image/png;base64,AA==".to_string()),
            ("rId6".to_string(), "data:image/png;base64,AA==".to_string()),
        ])
    }

    #[test]
    fn a_picture_in_a_table_cell_is_numbered_with_the_rest_of_the_part() {
        // A cell's paragraphs have no place among the block ordinals, so the number has to count the
        // part's drawings rather than one paragraph's. 182 of the pictures in the documents measured
        // here sit inside a table, and none of them could be reached before.
        let body = format!(
            "<w:p><w:r><w:t>body</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r>{}</w:p></w:tc></w:tr></w:tbl>",
            drawing("rId5")
        );
        let (blocks, _, _) =
            parse_document(&document(&body), None, &Styles::default(), &picture_map(), &Default::default()).unwrap();
        let Block::Table { rows } = &blocks[1] else {
            panic!("expected a table");
        };
        let numbered: Vec<Option<u32>> = rows[0][0]
            .iter()
            .filter(|run| run.image_index.is_some())
            .map(|run| run.image_index)
            .collect();
        assert_eq!(numbered, vec![Some(0)]);
    }

    #[test]
    fn a_picture_inside_a_table_cell_can_be_taken_out() {
        let body = format!(
            "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r>{}</w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>after</w:t></w:r></w:p>",
            drawing("rId5")
        );
        let (path, guard) = archive_with(&document(&body));
        write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[DocxImageRemoval { drawing: 0 }], &[],
            &guard)
        .expect("removing a picture inside a table should land");

        let part = part_of(&path);
        assert!(!part.contains("<w:drawing"), "{part}");
        // The table, its cell and its text are still there: the picture went, not the row.
        assert!(part.contains("<w:tbl>"), "{part}");
        assert!(part.contains("<w:t>cell</w:t>"), "{part}");
        assert!(part.contains("<w:t>after</w:t>"), "{part}");
        assert!(!part.contains("<w:r></w:r>"), "{part}");
    }

    #[test]
    fn the_numbering_counts_a_picture_a_nested_table_holds_even_though_it_is_not_drawn() {
        // A table inside a cell is not drawn here, and its paragraphs are not read - but the writer
        // still counts the drawings of the whole part. Numbering by what was parsed would name the
        // wrong picture the moment a nested table holds one.
        let body = format!(
            "<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p>{}</w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>outer</w:t></w:r>{}</w:p></w:tc></w:tr></w:tbl>",
            drawing("rId5"),
            drawing("rId6")
        );
        let (blocks, _, _) =
            parse_document(&document(&body), None, &Styles::default(), &picture_map(), &Default::default()).unwrap();
        let Block::Table { rows } = &blocks[0] else {
            panic!("expected a table");
        };
        let numbered: Vec<Option<u32>> = rows[0][0]
            .iter()
            .filter(|run| run.image_index.is_some())
            .map(|run| run.image_index)
            .collect();
        // The drawn one is the second drawing of the part, not the first.
        assert_eq!(numbered, vec![Some(1)]);
    }

    #[test]
    fn the_run_a_picture_had_to_itself_goes_with_it() {
        // Word never writes a run with nothing in it, so leaving one behind would be this writer's
        // own artefact in the middle of the user's paragraph.
        let paragraph = format!("<w:p><w:r><w:t>a</w:t></w:r>{}</w:p>", drawing("rId5"));
        let left = remove_drawing(&paragraph, 0).expect("the drawing is there");
        assert!(!left.contains("<w:drawing"), "{left}");
        assert!(!left.contains("<w:r></w:r>"), "{left}");
        assert_eq!(left, "<w:p><w:r><w:t>a</w:t></w:r></w:p>");
    }

    #[test]
    fn a_run_that_held_text_beside_the_picture_keeps_the_text() {
        // The picture is cut, not the run: the run's own text is the user's, and taking it would lose
        // a word the file never asked to lose.
        let paragraph = r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>caption</w:t><w:drawing><wp:inline/></w:drawing></w:r></w:p>"#;
        let left = remove_drawing(paragraph, 0).expect("the drawing is there");
        assert!(!left.contains("<w:drawing"), "{left}");
        assert!(left.contains("<w:t>caption</w:t>"), "{left}");
        assert!(left.contains("<w:rPr><w:b/></w:rPr>"), "{left}");
    }

    #[test]
    fn deleting_a_picture_leaves_the_paragraph_and_its_text_alone() {
        let body = format!(
            "<w:p><w:r><w:t>keep me</w:t></w:r>{}</w:p><w:p><w:r><w:t>second line</w:t></w:r></w:p>",
            drawing("rId5")
        );
        let (path, guard) = archive_with(&document(&body));
        let written = write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[DocxImageRemoval { drawing: 0 }], &[],
            &guard)
        .expect("removing the picture should land");

        let part = part_of(&path);
        assert!(!part.contains("<w:drawing"), "{part}");
        assert!(part.contains("<w:t>keep me</w:t>"), "{part}");
        assert!(part.contains("<w:t>second line</w:t>"), "{part}");

        let read_back = read_docx_sync(&path).expect("the reader should read it back");
        let texts: Vec<String> = read_back
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { runs, .. } => Some(
                    runs.iter()
                        .map(|run| run.text.as_str())
                        .collect::<String>(),
                ),
                _ => None,
            })
            .collect();
        assert_eq!(texts, vec!["keep me".to_string(), "second line".to_string()]);
        // The picture is gone from what the pane would draw, too.
        let pictures: usize = read_back
            .blocks
            .iter()
            .filter_map(|block| match block {
                Block::Paragraph { runs, .. } => {
                    Some(runs.iter().filter(|run| run.image_index.is_some()).count())
                }
                _ => None,
            })
            .sum();
        assert_eq!(pictures, 0);
        assert_ne!(written, guard);
    }

    #[test]
    fn a_picture_moves_to_the_end_of_another_paragraph_and_nothing_else_moves() {
        let body = format!(
            "<w:p><w:r><w:t>first</w:t></w:r>{}</w:p><w:p><w:r><w:t>second</w:t></w:r></w:p>",
            drawing("rId5")
        );
        let (path, guard) = archive_with(&document(&body));
        write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[],
            &[DocxImageMove { drawing: 0, to: 1 }],
            &guard,
        )
        .expect("moving the picture should land");

        let part = part_of(&path);
        let paragraphs: Vec<&str> = part
            .split("<w:p>")
            .skip(1)
            .map(|rest| &rest[..rest.find("</w:p>").unwrap()])
            .collect();
        assert_eq!(paragraphs.len(), 2);
        // The paragraph it left is the text it was beside, and nothing else.
        assert_eq!(paragraphs[0], "<w:r><w:t>first</w:t></w:r>");
        // The one it arrived in keeps its own text and takes the picture after it.
        assert!(paragraphs[1].contains("<w:t>second</w:t>"), "{}", paragraphs[1]);
        assert!(paragraphs[1].contains(r#"r:embed="rId5""#), "{}", paragraphs[1]);
        // One drawing still, and the run around it went with it.
        assert_eq!(part.matches("<w:drawing").count(), 1);
        assert!(!part.contains("<w:r></w:r>"), "{part}");
    }

    #[test]
    fn a_picture_in_a_run_with_text_leaves_the_text_behind() {
        // The picture travels; the word beside it does not. Moving the run would have taken it.
        let body = r#"<w:p><w:r><w:t>caption</w:t><w:drawing><wp:inline/></w:drawing></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p>"#;
        let (path, guard) = archive_with(&document(body));
        write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[],
            &[DocxImageMove { drawing: 0, to: 1 }],
            &guard,
        )
        .expect("moving the picture should land");

        let part = part_of(&path);
        let paragraphs: Vec<&str> = part
            .split("<w:p>")
            .skip(1)
            .map(|rest| &rest[..rest.find("</w:p>").unwrap()])
            .collect();
        assert!(paragraphs[0].contains("<w:t>caption</w:t>"), "{}", paragraphs[0]);
        assert!(!paragraphs[0].contains("<w:drawing"), "{}", paragraphs[0]);
        assert!(paragraphs[1].contains("<w:drawing"), "{}", paragraphs[1]);
        // A drawing is only valid inside a run, so the one that arrived is wrapped in its own.
        assert!(paragraphs[1].contains("<w:r><w:drawing"), "{}", paragraphs[1]);
    }

    #[test]
    fn moving_a_picture_within_its_own_paragraph_writes_nothing() {
        let body = format!(
            "<w:p><w:r><w:t>only</w:t></w:r>{}</w:p>",
            drawing("rId5")
        );
        let (path, guard) = archive_with(&document(&body));
        let before = part_of(&path);
        let written = write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[],
            &[DocxImageMove { drawing: 0, to: 0 }],
            &guard,
        )
        .expect("a move into its own paragraph is not an error");
        assert_eq!(part_of(&path), before);
        // Nothing changed, so nothing was written and the file's identity is where it was.
        assert_eq!(written, guard);
    }

    #[test]
    fn a_move_to_a_paragraph_the_document_does_not_have_is_refused() {
        let (path, guard) = archive_with(&document(
            "<w:p><w:r><w:t>x</w:t></w:r></w:p>",
        ));
        let error = write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[],
            &[DocxImageMove { drawing: 0, to: 9 }],
            &guard,
        )
        .expect_err("there is no picture and no paragraph nine");
        // The picture is the first thing missing, and it says so.
        assert!(error.contains("没有第 1 张图") || error.contains("序号 9"), "{error}");
        assert!(part_of(&path).contains("<w:t>x</w:t>"));
    }

    #[test]
    fn moving_a_picture_out_of_a_table_cell_lands_in_the_body() {
        let body = format!(
            "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r>{}</w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>body</w:t></w:r></w:p>",
            drawing("rId5")
        );
        let (path, guard) = archive_with(&document(&body));
        write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[],
            &[DocxImageMove { drawing: 0, to: 1 }],
            &guard,
        )
        .expect("moving a picture out of a table should land");

        let part = part_of(&path);
        let (table, body_part) = part.split_once("</w:tbl>").unwrap();
        assert!(!table.contains("<w:drawing"), "{table}");
        assert!(table.contains("<w:t>cell</w:t>"), "{table}");
        assert!(body_part.contains("<w:drawing"), "{body_part}");
        assert!(body_part.contains("<w:t>body</w:t>"), "{body_part}");
    }

    #[test]
    fn a_picture_number_the_document_does_not_have_is_refused() {
        let (path, guard) = archive_with(&document("<w:p><w:r><w:t>x</w:t></w:r></w:p>"));
        let error = write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[DocxImageRemoval { drawing: 0 }], &[],
            &guard)
        .expect_err("there is no picture to remove");
        assert!(error.contains("没有第 1 张图"), "{error}");
        // Refused means nothing was written, so the part is exactly as it arrived.
        assert!(part_of(&path).contains("<w:t>x</w:t>"));
    }

    #[test]
    fn undoing_a_picture_deletion_brings_it_back() {
        let body = format!(
            "<w:p><w:r><w:t>keep me</w:t></w:r>{}</w:p>",
            drawing("rId5")
        );
        let (path, guard) = archive_with(&document(&body));
        let written = write_docx_sync(
            &path,
            &[],
            &[],
            &[],
            &[DocxImageRemoval { drawing: 0 }], &[],
            &guard)
        .expect("removing the picture should land");
        assert!(!part_of(&path).contains("<w:drawing"));

        let restored = undo_docx_sync(&path, &written).expect("undo should land");
        assert!(part_of(&path).contains("<w:drawing"), "the picture should be back");
        assert_ne!(restored, guard);
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
            &[], &[], &guard)
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
                Block::Note { .. } => None,
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
            &[], &[], &guard)
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
            &[], &[], &after_first)
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

        let after_delete = write_docx_sync(&path, &[], &[1], &[], &[], &[], &guard).expect("delete should land");
        assert!(!part_of(&path).contains("drop"));

        undo_docx_sync(&path, &after_delete).expect("undo should land");
        assert_eq!(part_of(&path), original);
        assert!(part_of(&path).contains("<w:rPr><w:b/></w:rPr>"));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn the_same_part_is_not_remembered_twice() {
        let document = "<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>";
        let (path, guard) = archive_with(document);
        let original = part_of(&path);

        // Two saves that write the same text: the second one would otherwise push the same snapshot
        // again, and one undo would then take back nothing at all.
        let first = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "y".into(),
            }],
            &[],
            &[],
            &[], &[], &guard)
        .expect("the first save lands");
        let after_first = part_of(&path);
        let second = write_docx_sync(
            &path,
            &[DocxEdit {
                index: 0,
                text: "y".into(),
            }],
            &[],
            &[],
            &[], &[], &first)
        .expect("the second save lands");
        assert_eq!(part_of(&path), after_first);

        undo_docx_sync(&path, &second).expect("one undo");
        assert_eq!(
            part_of(&path),
            original,
            "one undo should get back to the original, not to y"
        );
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
            &[], &[], &guard)
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
            &[], &[], &stale)
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
            &[], &[], &guard)
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
                Block::Note { .. } => None,
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
                Block::Note { .. } => None,
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
        let package = parts(&bytes).unwrap();
        assert!(package.numbering.is_none());
        let (blocks, _) = parse_blocks(&package.document, None).unwrap();
        let Block::Paragraph { runs, .. } = &blocks[0] else {
            panic!("expected a paragraph");
        };
        assert_eq!(runs[0].text, "from the archive");
    }

    #[test]
    fn entry_names_are_matched_whatever_their_case_or_separator() {
        // `Compress-Archive` writes backslashes, and a writer may spell the part in any case.
        let bytes = archive(&[("WORD\\DOCUMENT.XML", "<w:document/>")]);
        let package = parts(&bytes).unwrap();
        assert_eq!(package.document, "<w:document/>");
    }

    #[test]
    fn an_archive_without_the_document_part_says_so() {
        let bytes = archive(&[("word/styles.xml", "<w:styles/>")]);
        let error = parts(&bytes).unwrap_err();
        assert!(error.contains("document.xml"), "{error}");
    }
}
