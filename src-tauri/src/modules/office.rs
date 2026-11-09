//! What the three Office readers share.
//!
//! A `.docx`, an `.xlsx` and a `.pptx` are all a ZIP of XML parts, and each reader has to find a
//! part by a path a relationship names, read it under a ceiling, and take colours and numbers out
//! of elements. That much is the same for all three; what each file *means* is not, and stays in
//! its own module.

use std::collections::HashMap;
use std::io::Cursor;

use quick_xml::events::{BytesRef, BytesStart, BytesText};
use quick_xml::name::QName;

use super::docx::read_part;

/// EMU (English Metric Units) to CSS pixels at 96 dpi: 914400 EMU to the inch.
pub(crate) const EMU_PER_PX: f64 = 9525.0;

/// A length in EMU as pixels.
pub(crate) fn emu_to_px(emu: f64) -> f32 {
    (emu / EMU_PER_PX) as f32
}

/// The path a ZIP entry is looked up by: forward slashes, lowercase, no leading slash.
pub(crate) fn normalize(name: &str) -> String {
    name.replace('\\', "/").trim_start_matches('/').to_lowercase()
}

/// The archive, open on the bytes that were read.
#[derive(Debug)]
pub(crate) struct Archive {
    bytes: Vec<u8>,
    /// Normalized entry path to its index: a ZIP written by another tool can separate with
    /// backslashes and vary the case, and a lookup by name matches neither.
    entries: HashMap<String, usize>,
}

impl Archive {
    pub(crate) fn open(bytes: Vec<u8>, what: &str) -> Result<Self, String> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes.as_slice()))
            .map_err(|error| format!("这不是一个可读的 {what}（ZIP 目录解析失败）：{error}"))?;
        let mut entries = HashMap::new();
        for index in 0..archive.len() {
            // The borrow the entry holds ends with the iteration, so only the name is kept.
            if let Ok(entry) = archive.by_index(index) {
                entries.insert(normalize(entry.name()), index);
            }
        }
        Ok(Archive { bytes, entries })
    }

    /// One part as text, or `None` when the archive does not have it. A part past `limit` inflated
    /// is refused rather than read, because the size a ZIP declares is not the size it delivers.
    pub(crate) fn text(&self, path: &str, limit: u64, what: &str) -> Result<Option<String>, String> {
        let Some(index) = self.entries.get(&normalize(path)).copied() else {
            return Ok(None);
        };
        let mut archive = zip::ZipArchive::new(Cursor::new(self.bytes.as_slice()))
            .map_err(|error| format!("读取 {what} 失败：{error}"))?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 {what} 内条目失败：{error}"))?;
        if entry.size() > limit {
            return Err(format!(
                "{path} 解压后约 {} MB，超出预览上限",
                entry.size() / 1024 / 1024
            ));
        }
        Ok(Some(read_part(&mut entry, limit, what)?))
    }

    /// One part's bytes, for the media that is not text. A part past `limit` is skipped rather than
    /// refused: a document whose pictures are too big still has its text.
    pub(crate) fn bytes(&self, path: &str, limit: u64, what: &str) -> Result<Option<Vec<u8>>, String> {
        let Some(index) = self.entries.get(&normalize(path)).copied() else {
            return Ok(None);
        };
        let mut archive = zip::ZipArchive::new(Cursor::new(self.bytes.as_slice()))
            .map_err(|error| format!("读取 {what} 失败：{error}"))?;
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 {what} 内条目失败：{error}"))?;
        if entry.size() > limit {
            return Ok(None);
        }
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        use std::io::Read;
        loop {
            let read = entry
                .read(&mut chunk)
                .map_err(|error| format!("解压 {what} 内条目失败：{error}"))?;
            if read == 0 {
                break;
            }
            if buffer.len() as u64 + read as u64 > limit {
                return Ok(None);
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
        Ok(Some(buffer))
    }

    /// One named part, or an error naming it when the file does not have it.
    pub(crate) fn required(&self, path: &str, limit: u64, what: &str) -> Result<String, String> {
        self.text(path, limit, what)?
            .ok_or_else(|| format!("这个 {what} 里没有 {path}，无法读取内容"))
    }
}

/// A relationship target resolved against the folder of the part that names it. Targets are written
/// either relative to that folder (`../media/x.png`) or from the package root (`/ppt/media/x.png`).
pub(crate) fn resolve_relative(folder: &str, target: &str) -> String {
    let target = target.replace('\\', "/");
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_string();
    }
    let mut parts: Vec<&str> = folder.split('/').filter(|part| !part.is_empty()).collect();
    for segment in target.split('/') {
        match segment {
            "." | "" => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// The path a relationship id names, as a path inside the package.
///
/// `from` is the folder the naming part lives in, and `attribute` is the name of the id attribute -
/// `Id` in a rels part, `id`/`embed` on the element that uses one.
pub(crate) fn relationship_target(
    rels_xml: &str,
    wanted: &str,
    from: &str,
) -> Option<String> {
    let mut reader = quick_xml::Reader::from_str(rels_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(element))
            | Ok(quick_xml::events::Event::Empty(element)) => {
                if local(element.name()) == b"Relationship"
                    && attr(&element, b"Id").as_deref() == Some(wanted)
                {
                    return attr(&element, b"Target").map(|target| resolve_relative(from, &target));
                }
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    None
}

/// Every relationship in a part, by id.
pub(crate) fn relationships(rels_xml: &str, from: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut reader = quick_xml::Reader::from_str(rels_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(element))
            | Ok(quick_xml::events::Event::Empty(element)) => {
                if local(element.name()) == b"Relationship" {
                    if let (Some(id), Some(target)) =
                        (attr(&element, b"Id"), attr(&element, b"Target"))
                    {
                        out.insert(id, resolve_relative(from, &target));
                    }
                }
            }
            Ok(quick_xml::events::Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// An element's local name: a part that spells its elements without a prefix and one that declares
/// a prefix name the same element.
pub(crate) fn local(name: QName<'_>) -> &[u8] {
    name.local_name().into_inner()
}

/// An attribute by local name, so `r:id` and `id` are both found.
pub(crate) fn attr(element: &BytesStart<'_>, local: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == local)
        .and_then(|attribute| attribute.unescape_value().ok())
        .map(|value| value.into_owned())
}

/// An attribute by its full name, prefix included. Two attributes of one element can share a local
/// name and mean different things: a slide carries both `id` and `r:id`.
pub(crate) fn attr_full(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.as_ref() == name)
        .and_then(|attribute| attribute.unescape_value().ok())
        .map(|value| value.into_owned())
}

/// An attribute as a number.
pub(crate) fn attr_number<T: std::str::FromStr>(element: &BytesStart<'_>, name: &[u8]) -> Option<T> {
    attr(element, name).and_then(|value| value.trim().parse().ok())
}

/// A boolean attribute, present as `1`/`true`.
pub(crate) fn flag(element: &BytesStart<'_>, name: &[u8]) -> Option<bool> {
    attr(element, name).map(|value| matches!(value.as_str(), "1" | "true"))
}

/// Whether an on/off property element is on. Word, Excel and PowerPoint all write `<b/>` for yes
/// and `<b val="0"/>` for no.
pub(crate) fn toggled(element: &BytesStart<'_>) -> bool {
    !matches!(attr(element, b"val").as_deref(), Some("0") | Some("false"))
}

/// The text of a text event, decoded and unescaped. The reader may hand back `&amp;` literally or
/// split it out as a reference event, so both cases are covered.
pub(crate) fn text_of(text: &BytesText<'_>) -> String {
    let Ok(decoded) = text.decode() else {
        return String::new();
    };
    quick_xml::escape::unescape(&decoded)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| decoded.into_owned())
}

/// The character a reference event stands for, when it names one.
pub(crate) fn reference_of(reference: &BytesRef<'_>) -> String {
    if let Ok(Some(character)) = reference.resolve_char_ref() {
        return character.to_string();
    }
    // A named reference: `&amp;` and the other four XML declares. Anything else is not a character
    // this text can hold, and dropping it is better than writing the name out as text.
    let Ok(name) = reference.decode() else {
        return String::new();
    };
    quick_xml::escape::resolve_predefined_entity(&name)
        .map(str::to_string)
        .unwrap_or_default()
}

/// A colour of `a:srgbClr val="RRGGBB"` as `#rrggbb`. The alpha channel some writers put in front
/// is dropped, and a fully transparent colour is not a colour at all.
pub(crate) fn srgb_color(value: &str) -> Option<String> {
    let hex = value.trim();
    let digits = match hex.len() {
        6 => hex,
        8 => {
            if hex[..2].eq_ignore_ascii_case("00") {
                return None;
            }
            &hex[2..]
        }
        _ => return None,
    };
    if !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", digits.to_lowercase()))
}

/// The mime type of a picture, from its extension. Anything else is not drawn.
pub(crate) fn image_mime(name: &str) -> Option<&'static str> {
    let extension = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Picture bytes as a `data:` URL, which is what an `<img src>` can use with nothing on disk to
/// fetch it from. `None` when the type is not one this reader can put on a page.
///
/// A Windows metafile is recognized by its own bytes rather than by its name: Word keeps a pasted
/// chart, an equation or a screenshot as one whatever it calls the file, and none of them is a
/// picture a webview decodes. They are replayed into an SVG instead (see `metafile`), which is what
/// keeps a document full of them from drawing as a page with holes in it.
pub(crate) fn data_url(name: &str, bytes: &[u8]) -> Option<String> {
    if super::metafile::is_metafile(bytes) {
        return super::metafile::data_url(bytes);
    }
    let mime = image_mime(name)?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relationship_target_resolves_against_the_part_that_named_it() {
        assert_eq!(
            resolve_relative("ppt/slides", "../media/image1.png"),
            "ppt/media/image1.png"
        );
        assert_eq!(
            resolve_relative("ppt", "/ppt/media/image2.png"),
            "ppt/media/image2.png"
        );
        assert_eq!(
            resolve_relative("ppt", "media/image3.png"),
            "ppt/media/image3.png"
        );
        assert_eq!(resolve_relative("xl", "worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
    }

    #[test]
    fn an_entry_path_is_matched_however_it_was_written() {
        assert_eq!(normalize("XL\\Workbook.XML"), "xl/workbook.xml");
        assert_eq!(normalize("/ppt/slides/slide1.xml"), "ppt/slides/slide1.xml");
    }

    #[test]
    fn a_relationship_table_is_read_by_id() {
        let rels = r#"<Relationships><Relationship Id="rId1" Target="slide1.xml"/><Relationship Id="rId2" Target="../media/a.png"/></Relationships>"#;
        let table = relationships(rels, "ppt/slides");
        assert_eq!(
            table.get("rId1").map(String::as_str),
            Some("ppt/slides/slide1.xml")
        );
        assert_eq!(table.get("rId2").map(String::as_str), Some("ppt/media/a.png"));
        assert_eq!(
            relationship_target(rels, "rId2", "ppt/slides").as_deref(),
            Some("ppt/media/a.png")
        );
    }

    #[test]
    fn a_colour_that_is_not_one_is_none() {
        assert_eq!(srgb_color("FF0000").as_deref(), Some("#ff0000"));
        assert_eq!(srgb_color("00FF0000"), None);
        assert_eq!(srgb_color("nope"), None);
    }

    #[test]
    fn an_emu_length_is_pixels_at_ninety_six_dpi() {
        // 9 525 EMU is one pixel; a 10 inch slide is 960.
        assert!((emu_to_px(9_525.0) - 1.0).abs() < 0.001);
        assert!((emu_to_px(9_144_000.0) - 960.0).abs() < 0.001);
    }
}
