//! Presentations, read as the slides they are.
//!
//! A `.pptx` is a ZIP of XML, and the webview has no PowerPoint to hand it to. What this does is
//! take each slide's shapes with the box they sit in, the text they carry with the styling that
//! text declares, and the pictures the slide's own relationship table points at, and hand the
//! frontend a set of positioned boxes to draw.
//!
//! What this deliberately does not do: read the slide master or the layout a slide derives from, so
//! a title that inherits its size and place from the master is drawn where the slide itself does not
//! say - which is nowhere, unless the file wrote it. Charts, SmartArt, animations, transitions,
//! notes and the old `.ppt` format (OLE2 rather than ZIP) are not read either.

use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use tauri::Manager;

use super::fs::blocking;
use super::office::{
    attr, attr_full, attr_number, data_url, emu_to_px, flag, local, reference_of, relationships,
    srgb_color, text_of, Archive,
};
use super::workspace::{authorize_read, resolve_path, WorkspaceEnv, WorkspaceRegistry};

/// Any one part, inflated. One slide of a real deck is a few tens of kilobytes of XML.
const MAX_PART_BYTES: u64 = 16 * 1024 * 1024;
/// One picture, and all of them together. Every byte of them crosses IPC inside one JSON string.
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IMAGES_BYTES: u64 = 32 * 1024 * 1024;
/// Slides and shapes the pane draws. A deck with more slides is a video.
const MAX_SLIDES: usize = 200;
const MAX_SHAPES: usize = 200;
/// A slide whose file states no size is the 10 by 7.5 inch one every version defaults to.
const DEFAULT_WIDTH: f32 = 960.0;
const DEFAULT_HEIGHT: f32 = 720.0;

/// How a shape is drawn.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    /// A text box or a title: its paragraphs are the point of it.
    Text,
    /// A picture, whose image is a `data:` URL.
    Picture,
    /// Something else with a place on the slide but nothing read out of it - a chart, a table, a
    /// SmartArt frame. Drawn as an empty box so the slide's layout is still visible.
    Other,
}

#[derive(Serialize, Debug, Default, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PptxRun {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    /// Point size, from the hundredths of a point the file writes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<f32>,
    /// `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font: Option<String>,
}

#[derive(Serialize, Debug, Default, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PptxParagraph {
    /// `left`, `center`, `right`, `justify`; absent leaves it to the shape's default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    /// The outline level the paragraph sits at, 0 for the top one.
    pub level: u8,
    /// Whether it carries a bullet. A paragraph with no bullet is a line of a text box.
    pub bullets: bool,
    pub runs: Vec<PptxRun>,
}

/// One shape, in the pixels of the slide's own coordinate space.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PptxShape {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    /// Degrees clockwise, from the `rot` a transform carries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f32>,
    pub kind: ShapeKind,
    /// `#rrggbb` behind the shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// A picture as a `data:` URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    pub paragraphs: Vec<PptxParagraph>,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PptxSlide {
    /// Its position in the deck, which is the order the file lists it in.
    pub index: u32,
    pub shapes: Vec<PptxShape>,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PptxDocument {
    /// The slide size in pixels at 96 dpi, which is the box everything on a slide is placed in.
    pub width: f32,
    pub height: f32,
    pub slides: Vec<PptxSlide>,
    /// Whether the deck was longer than the pane draws.
    pub truncated: bool,
}

/// A presentation, read as its slides.
#[tauri::command]
pub async fn fs_read_pptx(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<PptxDocument, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_read(&app.state::<WorkspaceRegistry>(), &target)?;
        read_pptx_sync(&target)
    })
    .await
}

fn read_pptx_sync(path: &Path) -> Result<PptxDocument, String> {
    let bytes = std::fs::read(path).map_err(|error| {
        log::debug!("fs_read_pptx read({}) failed: {error}", path.display());
        error.to_string()
    })?;
    let archive = Archive::open(bytes, ".pptx")?;
    let presentation = archive.required("ppt/presentation.xml", MAX_PART_BYTES, ".pptx")?;
    let (width, height) = slide_size(&presentation);
    let order = slide_order(&presentation);
    let rels = archive
        .text("ppt/_rels/presentation.xml.rels", MAX_PART_BYTES, ".pptx")?
        .map(|xml| relationships(&xml, "ppt"))
        .unwrap_or_default();

    let mut slides = Vec::new();
    let mut images_bytes = 0u64;
    let mut truncated = order.len() > MAX_SLIDES;
    for (index, relationship_id) in order.iter().take(MAX_SLIDES).enumerate() {
        let Some(target) = rels.get(relationship_id) else {
            // A slide the deck lists and has no part for is a slide that cannot be drawn; the ones
            // around it still can.
            slides.push(PptxSlide {
                index: index as u32,
                shapes: Vec::new(),
            });
            continue;
        };
        let xml = archive.required(target, MAX_PART_BYTES, ".pptx")?;
        let slide_rels = slide_relationships(&archive, target)?;
        let (shapes, cut) = parse_slide(
            &xml,
            &archive,
            &slide_rels,
            &mut images_bytes,
        )?;
        truncated |= cut;
        slides.push(PptxSlide {
            index: index as u32,
            shapes,
        });
    }
    Ok(PptxDocument {
        width,
        height,
        slides,
        truncated,
    })
}

/// The slide size, in pixels. A deck that states no size gets the default one.
fn slide_size(presentation_xml: &str) -> (f32, f32) {
    let mut reader = Reader::from_str(presentation_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if local(element.name()) == b"sldSz" {
                    let width = attr_number::<f64>(&element, b"cx").unwrap_or(0.0);
                    let height = attr_number::<f64>(&element, b"cy").unwrap_or(0.0);
                    if width > 0.0 && height > 0.0 {
                        return (emu_to_px(width), emu_to_px(height));
                    }
                    return (DEFAULT_WIDTH, DEFAULT_HEIGHT);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (DEFAULT_WIDTH, DEFAULT_HEIGHT)
}

/// The relationship ids of the slides, in the order the deck lists them.
fn slide_order(presentation_xml: &str) -> Vec<String> {
    let mut order = Vec::new();
    let mut reader = Reader::from_str(presentation_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if local(element.name()) == b"sldId" {
                    // The slide's own `id` is a number and `r:id` names its part; only the second
                    // is the one to follow.
                    if let Some(id) = attr_full(&element, b"r:id") {
                        order.push(id);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    order
}

/// The relationships of one slide, which is where its pictures are named.
fn slide_relationships(
    archive: &Archive,
    slide_path: &str,
) -> Result<HashMap<String, String>, String> {
    // `ppt/slides/slide1.xml` has its relationships in `ppt/slides/_rels/slide1.xml.rels`.
    let (folder, name) = match slide_path.rsplit_once('/') {
        Some((folder, name)) => (folder, name),
        None => ("", slide_path),
    };
    let rels_path = format!("{folder}/_rels/{name}.rels");
    Ok(archive
        .text(&rels_path, MAX_PART_BYTES, ".pptx")?
        .map(|xml| relationships(&xml, folder))
        .unwrap_or_default())
}

/// Where a `<a:solidFill>` that is being read belongs.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum FillTarget {
    None,
    /// The shape's own background.
    Shape,
    /// The colour of the text run being read.
    Run,
}

/// One shape as it is being read.
#[derive(Debug)]
struct PendingShape {
    kind: ShapeKind,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    rotation: Option<f32>,
    fill: Option<String>,
    image: Option<String>,
    paragraphs: Vec<PptxParagraph>,
    paragraph: Option<PptxParagraph>,
    run: Option<PptxRun>,
    /// The relationship id of a picture, which is resolved into a `data:` URL when the shape ends.
    embed: Option<String>,
}

impl Default for PendingShape {
    fn default() -> Self {
        PendingShape {
            kind: ShapeKind::Text,
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            rotation: None,
            fill: None,
            image: None,
            paragraphs: Vec::new(),
            paragraph: None,
            run: None,
            embed: None,
        }
    }
}

/// What the reader is inside, which decides what a tag means.
#[derive(Debug, Default)]
struct Where {
    /// Between `<a:rPr>` and its end: a colour here is the text's.
    in_run_props: bool,
    /// Inside `<a:ln>`, whose colours draw an outline rather than a fill.
    in_line: bool,
    /// Inside `<a:tbl>`, whose paragraphs are table cells and are not drawn by this reader.
    in_table: bool,
    fill_target: Option<FillTarget>,
}

impl Where {
    fn fill_target(&self) -> FillTarget {
        self.fill_target.unwrap_or(FillTarget::None)
    }
}

/// One slide's shapes, and whether anything was left out.
fn parse_slide(
    xml: &str,
    archive: &Archive,
    slide_rels: &HashMap<String, String>,
    images_bytes: &mut u64,
) -> Result<(Vec<PptxShape>, bool), String> {
    let mut shapes: Vec<PptxShape> = Vec::new();
    let mut truncated = false;
    let mut current: Option<PendingShape> = None;
    let mut where_ = Where::default();
    // The depth at which the shape being read opened, so its end is known when it arrives.
    let mut depth = 0usize;
    let mut shape_depth = 0usize;
    let mut in_text = false;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                depth += 1;
                let tag = local(element.name()).to_vec();
                if current.is_none() && matches!(tag.as_slice(), b"sp" | b"pic" | b"graphicFrame") {
                    shape_depth = depth;
                    let mut shape = PendingShape::default();
                    if tag == b"pic" {
                        shape.kind = ShapeKind::Picture;
                    } else if tag == b"graphicFrame" {
                        shape.kind = ShapeKind::Other;
                    }
                    current = Some(shape);
                    continue;
                }
                let Some(shape) = current.as_mut() else {
                    continue;
                };
                match tag.as_slice() {
                    b"txBody" => in_text = true,
                    b"tbl" => where_.in_table = true,
                    b"ln" => where_.in_line = true,
                    b"rPr" | b"defRPr" => {
                        where_.in_run_props = true;
                        read_run_props(&element, shape.run.as_mut());
                    }
                    b"solidFill" => {
                        // A colour inside the text body is never the shape's own background. Both
                        // `<a:endParaRPr>` and `<a:defRPr>` sit in there and carry the text's own
                        // colour, and reading theirs as a fill painted a whole text box in the
                        // colour of its last paragraph mark - a green one across most of a slide.
                        where_.fill_target = Some(if where_.in_run_props || in_text {
                            FillTarget::Run
                        } else if where_.in_line {
                            FillTarget::None
                        } else {
                            FillTarget::Shape
                        });
                    }
                    b"p" if in_text && !where_.in_table => {
                        shape.paragraph = Some(PptxParagraph {
                            runs: Vec::new(),
                            ..Default::default()
                        });
                    }
                    b"r" | b"fld" if shape.paragraph.is_some() => {
                        shape.run = Some(PptxRun::default());
                    }
                    b"pPr" if shape.paragraph.is_some() => {
                        if let Some(paragraph) = shape.paragraph.as_mut() {
                            paragraph.align = align_of(&element);
                            paragraph.level = attr_number::<u8>(&element, b"lvl").unwrap_or(0);
                        }
                    }
                    b"buChar" | b"buAutoNum" => {
                        if let Some(paragraph) = shape.paragraph.as_mut() {
                            paragraph.bullets = true;
                        }
                    }
                    b"buNone" => {
                        if let Some(paragraph) = shape.paragraph.as_mut() {
                            paragraph.bullets = false;
                        }
                    }
                    b"br" => {
                        if shape.paragraph.is_some() {
                            shape.run = Some(PptxRun {
                                text: "\n".to_string(),
                                ..Default::default()
                            });
                        }
                    }
                    b"xfrm" => {
                        shape.rotation = attr_number::<f64>(&element, b"rot")
                            .map(|rot| (rot / 60_000.0) as f32);
                    }
                    b"off" => {
                        shape.x = attr_number::<f64>(&element, b"x")
                            .map(emu_to_px)
                            .unwrap_or(shape.x);
                        shape.y = attr_number::<f64>(&element, b"y")
                            .map(emu_to_px)
                            .unwrap_or(shape.y);
                    }
                    b"ext" => {
                        shape.width = attr_number::<f64>(&element, b"cx")
                            .map(emu_to_px)
                            .unwrap_or(shape.width);
                        shape.height = attr_number::<f64>(&element, b"cy")
                            .map(emu_to_px)
                            .unwrap_or(shape.height);
                    }
                    b"blip" => {
                        // `r:embed` and `r:link` share their local name with nothing else here, and
                        // the embedded one is the picture the file carries.
                        if let Some(embed) = attr(&element, b"embed") {
                            shape.embed = Some(embed);
                        }
                    }
                    b"srgbClr" => {
                        let color = attr(&element, b"val")
                            .as_deref()
                            .and_then(srgb_color);
                        match where_.fill_target() {
                            FillTarget::Shape => shape.fill = color,
                            FillTarget::Run => {
                                if let Some(run) = shape.run.as_mut() {
                                    run.color = color;
                                }
                            }
                            FillTarget::None => {}
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(element)) => {
                let tag = local(element.name()).to_vec();
                let Some(shape) = current.as_mut() else {
                    // A one-element shape: a picture or a frame written with no children.
                    if matches!(tag.as_slice(), b"sp" | b"pic" | b"graphicFrame") {
                        let shape = PendingShape {
                            kind: if tag == b"pic" {
                                ShapeKind::Picture
                            } else {
                                ShapeKind::Text
                            },
                            ..Default::default()
                        };
                        if shapes.len() < MAX_SHAPES {
                            shapes.push(finish_shape(shape, slide_rels, archive, images_bytes)?);
                        } else {
                            truncated = true;
                        }
                    }
                    continue;
                };
                match tag.as_slice() {
                    b"br" => break_line(shape),
                    b"off" => {
                        shape.x = attr_number::<f64>(&element, b"x")
                            .map(emu_to_px)
                            .unwrap_or(shape.x);
                        shape.y = attr_number::<f64>(&element, b"y")
                            .map(emu_to_px)
                            .unwrap_or(shape.y);
                    }
                    b"ext" => {
                        shape.width = attr_number::<f64>(&element, b"cx")
                            .map(emu_to_px)
                            .unwrap_or(shape.width);
                        shape.height = attr_number::<f64>(&element, b"cy")
                            .map(emu_to_px)
                            .unwrap_or(shape.height);
                    }
                    b"xfrm" => {
                        shape.rotation = attr_number::<f64>(&element, b"rot")
                            .map(|rot| (rot / 60_000.0) as f32);
                    }
                    b"blip" => shape.embed = attr(&element, b"embed").or(shape.embed.take()),
                    b"srgbClr" => {
                        let color = attr(&element, b"val")
                            .as_deref()
                            .and_then(srgb_color);
                        match where_.fill_target() {
                            FillTarget::Shape => shape.fill = color,
                            FillTarget::Run => {
                                if let Some(run) = shape.run.as_mut() {
                                    run.color = color;
                                }
                            }
                            FillTarget::None => {}
                        }
                    }
                    b"latin" if shape.run.is_some() => {
                        if let Some(run) = shape.run.as_mut() {
                            run.font = attr(&element, b"typeface");
                        }
                    }
                    b"pPr" if shape.paragraph.is_some() => {
                        if let Some(paragraph) = shape.paragraph.as_mut() {
                            paragraph.align = align_of(&element);
                            paragraph.level = attr_number::<u8>(&element, b"lvl").unwrap_or(0);
                        }
                    }
                    // A paragraph with nothing in it is still a line of the shape's text.
                    b"p" if in_text && !where_.in_table => {
                        shape.paragraphs.push(PptxParagraph {
                            runs: Vec::new(),
                            ..Default::default()
                        });
                    }
                    b"buChar" | b"buAutoNum" => {
                        if let Some(paragraph) = shape.paragraph.as_mut() {
                            paragraph.bullets = true;
                        }
                    }
                    b"buNone" => {
                        if let Some(paragraph) = shape.paragraph.as_mut() {
                            paragraph.bullets = false;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(run) = current.as_mut().and_then(|shape| shape.run.as_mut()) {
                    run.text.push_str(&text_of(&text));
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if let Some(run) = current.as_mut().and_then(|shape| shape.run.as_mut()) {
                    run.text.push_str(&reference_of(&reference));
                }
            }
            Ok(Event::End(element)) => {
                let tag = local(element.name()).to_vec();
                if let Some(shape) = current.as_mut() {
                    match tag.as_slice() {
                        b"txBody" => in_text = false,
                        b"tbl" => where_.in_table = false,
                        b"ln" => where_.in_line = false,
                        b"rPr" | b"defRPr" => where_.in_run_props = false,
                        b"solidFill" => where_.fill_target = None,
                        b"r" | b"fld" => {
                            if let (Some(paragraph), Some(run)) =
                                (shape.paragraph.as_mut(), shape.run.take())
                            {
                                // A run that carries nothing is what an empty `<a:r/>` leaves.
                                if !run.text.is_empty() {
                                    paragraph.runs.push(run);
                                }
                            }
                        }
                        b"p" => {
                            if let (Some(mut paragraph), run) =
                                (shape.paragraph.take(), shape.run.take())
                            {
                                if let Some(run) = run {
                                    if !run.text.is_empty() {
                                        paragraph.runs.push(run);
                                    }
                                }
                                shape.paragraphs.push(paragraph);
                            }
                        }
                        _ => {}
                    }
                }
                if current.is_some() && depth == shape_depth {
                    if let Some(shape) = current.take() {
                        if shapes.len() < MAX_SHAPES {
                            shapes.push(finish_shape(shape, slide_rels, archive, images_bytes)?);
                        } else {
                            truncated = true;
                        }
                    }
                }
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    in_text = false;
                }
            }
            Ok(Event::Eof) => {
                // Nothing tells the reader that a part ended in the middle of a tree; elements
                // still open at the end are what says the slide was cut off rather than finished.
                if depth > 0 {
                    truncated = true;
                }
                break;
            }
            Err(_) => {
                truncated = true;
                break;
            }
            _ => {}
        }
    }
    Ok((shapes, truncated))
}

/// A line break, which belongs to the paragraph rather than to a run: holding it as one would
/// lose it the moment the next `<a:r>` opened a run of its own.
fn break_line(shape: &mut PendingShape) {
    if let Some(paragraph) = shape.paragraph.as_mut() {
        paragraph.runs.push(PptxRun {
            text: "
".to_string(),
            ..Default::default()
        });
    }
}

/// A run's own properties, which sit on the `<a:rPr>` that precedes its text.
fn read_run_props(element: &BytesStart<'_>, run: Option<&mut PptxRun>) {
    let Some(run) = run else { return };
    if flag(element, b"b") == Some(true) {
        run.bold = true;
    }
    if flag(element, b"i") == Some(true) {
        run.italic = true;
    }
    // `u="none"` is the only value that means no underline; every other one draws a line.
    match attr(element, b"u").as_deref() {
        None | Some("none") => {}
        Some(_) => run.underline = true,
    }
    if let Some(size) = attr_number::<f32>(element, b"sz") {
        // `sz` is in hundredths of a point.
        run.size = Some(size / 100.0);
    }
    if let Some(typeface) = attr(element, b"typeface") {
        run.font = Some(typeface);
    }
}

/// A paragraph's alignment, as the pane spells it.
fn align_of(element: &BytesStart<'_>) -> Option<String> {
    match attr(element, b"algn").as_deref() {
        Some("ctr") => Some("center".to_string()),
        Some("r") => Some("right".to_string()),
        Some("just") | Some("dist") => Some("justify".to_string()),
        Some("l") => Some("left".to_string()),
        _ => None,
    }
}

/// A shape as the pane draws it, with its picture resolved into a `data:` URL.
fn finish_shape(
    mut shape: PendingShape,
    slide_rels: &HashMap<String, String>,
    archive: &Archive,
    images_bytes: &mut u64,
) -> Result<PptxShape, String> {
    if let Some(run) = shape.run.take() {
        if let Some(paragraph) = shape.paragraph.as_mut() {
            if !run.text.is_empty() {
                paragraph.runs.push(run);
            }
        }
    }
    if let Some(paragraph) = shape.paragraph.take() {
        shape.paragraphs.push(paragraph);
    }
    if let Some(embed) = shape.embed.take() {
        if let Some(target) = slide_rels.get(&embed) {
            if *images_bytes < MAX_IMAGES_BYTES {
                let budget = MAX_IMAGE_BYTES.min(MAX_IMAGES_BYTES - *images_bytes);
                if let Some(bytes) = archive.bytes(target, budget, ".pptx")? {
                    if let Some(url) = data_url(target, &bytes) {
                        *images_bytes += bytes.len() as u64;
                        shape.image = Some(url);
                        shape.kind = ShapeKind::Picture;
                    }
                }
            }
        }
    }
    Ok(PptxShape {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        rotation: shape.rotation,
        kind: shape.kind,
        fill: shape.fill,
        image: shape.image,
        paragraphs: shape.paragraphs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    // -----------------------------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------------------------

    fn write_zip(parts: &[(&str, &str)]) -> Vec<u8> {
        write_zip_bytes(
            &parts
                .iter()
                .map(|(name, content)| (*name, content.as_bytes().to_vec()))
                .collect::<Vec<_>>(),
        )
    }

    fn write_zip_bytes(parts: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, content) in parts {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    /// 9 525 EMU a pixel, so a box is stated in round pixels here.
    fn px(value: i64) -> i64 {
        value * 9_525
    }

    fn presentation_xml(width: i64, height: i64, slides: &[(&str, &str)]) -> String {
        let ids: String = slides
            .iter()
            .enumerate()
            .map(|(index, (id, relationship))| {
                format!(
                    r#"<p:sldId id="{}" r:id="{relationship}"/>"#,
                    256 + index
                )
                .replace("{}", id)
            })
            .collect();
        format!(
            r#"<?xml version="1.0"?><p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx="{width}" cy="{height}"/></p:presentation>"#
        )
    }

    fn rels_xml(rels: &[(&str, &str)]) -> String {
        let entries: String = rels
            .iter()
            .map(|(id, target)| format!(r#"<Relationship Id="{id}" Target="{target}"/>"#))
            .collect();
        format!(r#"<?xml version="1.0"?><Relationships>{entries}</Relationships>"#)
    }

    fn slide_xml(shapes: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>"#
        )
    }

    /// A text box with the box, rotation and fill given, around the body given.
    fn text_shape(body: &str, rotation: Option<i64>, fill: Option<&str>) -> String {
        let rotation = rotation
            .map(|rot| format!(r#" rot="{rot}""#))
            .unwrap_or_default();
        let fill = fill
            .map(|color| format!(r#"<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>"#))
            .unwrap_or_default();
        format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/></p:nvSpPr><p:spPr><a:xfrm{rotation}><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm>{fill}</p:spPr><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#,
            px(100),
            px(50),
            px(300),
            px(120)
        )
    }

    /// A deck on disk with one slide, read back.
    fn read_deck(
        presentation: &str,
        slide: &str,
        extra: &[(&str, &str)],
        tag: &str,
    ) -> PptxDocument {
        let dir = std::env::temp_dir().join(format!("verta-pptx-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("deck.pptx");
        let mut parts: Vec<(&str, String)> = vec![
            ("ppt/presentation.xml", presentation.to_string()),
            (
                "ppt/_rels/presentation.xml.rels",
                rels_xml(&[("rId2", "slides/slide1.xml")]),
            ),
            ("ppt/slides/slide1.xml", slide.to_string()),
        ];
        parts.extend(extra.iter().map(|(name, content)| (*name, content.to_string())));
        let borrowed: Vec<(&str, &str)> = parts
            .iter()
            .map(|(name, content)| (*name, content.as_str()))
            .collect();
        std::fs::write(&file, write_zip(&borrowed)).unwrap();
        let document = read_pptx_sync(&file).unwrap();
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
        document
    }

    fn size() -> String {
        presentation_xml(px(960), px(540), &[("256", "rId2")])
    }

    // -----------------------------------------------------------------------------------------
    // The deck
    // -----------------------------------------------------------------------------------------

    #[test]
    fn a_deck_states_its_slide_size_and_its_slide_order() {
        let document = read_deck(
            &presentation_xml(px(1280), px(720), &[("256", "rId2")]),
            &slide_xml(""),
            &[],
            "size",
        );
        assert_eq!(document.width, 1280.0);
        assert_eq!(document.height, 720.0);
        assert_eq!(document.slides.len(), 1);
        assert!(!document.truncated);
    }

    #[test]
    fn a_deck_with_no_size_reads_as_the_default_one() {
        let presentation = r#"<?xml version="1.0"?><p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>"#;
        let document = read_deck(presentation, &slide_xml(""), &[], "nosize");
        assert_eq!(document.width, DEFAULT_WIDTH);
        assert_eq!(document.height, DEFAULT_HEIGHT);
    }

    #[test]
    fn the_slide_a_listing_names_is_the_one_it_follows() {
        // Both `id` and `r:id` are on the element, and only the second is the one to follow. A
        // parser reading `id` would look for a relationship called `256` and find none.
        let presentation = presentation_xml(px(960), px(540), &[("256", "rId2")]);
        assert_eq!(slide_order(&presentation), vec!["rId2".to_string()]);
        let document = read_deck(
            &presentation,
            &slide_xml(&text_shape("<a:p><a:r><a:t>hi</a:t></a:r></a:p>", None, None)),
            &[],
            "order",
        );
        assert_eq!(document.slides[0].shapes[0].paragraphs[0].runs[0].text, "hi");
    }

    #[test]
    fn a_slide_the_deck_lists_with_no_part_still_takes_its_place() {
        let presentation = r#"<?xml version="1.0"?><p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>"#;
        let document = read_deck(
            presentation,
            &slide_xml(&text_shape("<a:p><a:r><a:t>second</a:t></a:r></a:p>", None, None)),
            &[],
            "hole",
        );
        assert_eq!(document.slides.len(), 2);
        assert!(document.slides[0].shapes.is_empty());
        assert_eq!(document.slides[1].shapes[0].paragraphs[0].runs[0].text, "second");
    }

    #[test]
    fn a_file_that_is_not_a_zip_says_so() {
        let error = Archive::open(b"nope".to_vec(), ".pptx").unwrap_err();
        assert!(error.contains(".pptx"), "{error}");
    }

    // -----------------------------------------------------------------------------------------
    // Shapes
    // -----------------------------------------------------------------------------------------

    #[test]
    fn a_text_box_carries_its_place_its_text_and_its_styling() {
        let body = r#"<a:p><a:pPr algn="ctr" lvl="1"/><a:r><a:rPr sz="1800" b="1" i="1" u="sng"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>Title</a:t></a:r><a:r><a:t> plain</a:t></a:r></a:p>"#;
        let document = read_deck(
            &size(),
            &slide_xml(&text_shape(body, None, Some("00FF00"))),
            &[],
            "text",
        );
        let shape = &document.slides[0].shapes[0];
        // EMU to pixels at 96 dpi.
        assert_eq!((shape.x, shape.y, shape.width, shape.height), (100.0, 50.0, 300.0, 120.0));
        assert_eq!(shape.kind, ShapeKind::Text);
        assert_eq!(shape.fill.as_deref(), Some("#00ff00"));
        let paragraph = &shape.paragraphs[0];
        assert_eq!(paragraph.align.as_deref(), Some("center"));
        assert_eq!(paragraph.level, 1);
        let first = &paragraph.runs[0];
        assert_eq!(first.text, "Title");
        assert!(first.bold && first.italic && first.underline);
        assert_eq!(first.size, Some(18.0));
        assert_eq!(first.color.as_deref(), Some("#ff0000"));
        assert_eq!(first.font.as_deref(), Some("Calibri"));
        // The second run carries nothing of its own.
        assert_eq!(paragraph.runs[1].text, " plain");
        assert!(!paragraph.runs[1].bold);
        assert_eq!(paragraph.runs[1].size, None);
    }

    #[test]
    fn a_paragraph_with_no_runs_is_still_a_paragraph() {
        let body = r#"<a:p/><a:p><a:r><a:t>after</a:t></a:r></a:p>"#;
        let document = read_deck(&size(), &slide_xml(&text_shape(body, None, None)), &[], "empty");
        let shape = &document.slides[0].shapes[0];
        assert_eq!(shape.paragraphs.len(), 2);
        assert!(shape.paragraphs[0].runs.is_empty());
        assert_eq!(shape.paragraphs[1].runs[0].text, "after");
    }

    #[test]
    fn a_line_break_is_kept_and_an_escaped_character_comes_back() {
        let body = r#"<a:p><a:r><a:t>one</a:t></a:r><a:br/><a:r><a:t>a &amp; b</a:t></a:r></a:p>"#;
        let document = read_deck(&size(), &slide_xml(&text_shape(body, None, None)), &[], "break");
        let runs = &document.slides[0].shapes[0].paragraphs[0].runs;
        let text: String = runs.iter().map(|run| run.text.as_str()).collect();
        assert_eq!(text, "one\na & b");
    }

    #[test]
    fn a_shape_rotation_is_read_in_degrees() {
        // `rot` is in 60 000ths of a degree.
        let body = r#"<a:p><a:r><a:t>turned</a:t></a:r></a:p>"#;
        let document = read_deck(
            &size(),
            &slide_xml(&text_shape(body, Some(5_400_000), None)),
            &[],
            "rot",
        );
        assert_eq!(document.slides[0].shapes[0].rotation, Some(90.0));
    }

    #[test]
    fn an_outline_colour_is_not_the_shape_s_fill() {
        let shape = format!(
            r#"<p:sp><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln></p:spPr></p:sp>"#,
            px(0),
            px(0),
            px(10),
            px(10)
        );
        let document = read_deck(&size(), &slide_xml(&shape), &[], "outline");
        assert_eq!(document.slides[0].shapes[0].fill.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn a_colour_in_the_text_body_is_not_the_shape_s_fill() {
        // A real slide: the box declares no fill at all, and the green is the colour of the text -
        // including the colour an end paragraph mark carries. Read as a fill it painted a green
        // box over 957 by 461 pixels of a slide whose file says the box is transparent.
        let body = r#"<a:p><a:r><a:rPr sz="1800"/><a:t>plain</a:t></a:r><a:r><a:rPr sz="1800"><a:solidFill><a:srgbClr val="00B050"/></a:solidFill></a:rPr><a:t>green text</a:t></a:r><a:endParaRPr sz="1800"><a:solidFill><a:srgbClr val="00B050"/></a:solidFill></a:endParaRPr></a:p>"#;
        let shape = text_shape(body, None, None);
        let document = read_deck(&size(), &slide_xml(&shape), &[], "textbody");
        let shape = &document.slides[0].shapes[0];
        assert_eq!(shape.fill, None, "the box declares no fill of its own");
        assert_eq!(
            shape.paragraphs[0].runs[1].color.as_deref(),
            Some("#00b050"),
            "the green is the run's text colour"
        );
    }

    #[test]
    fn a_tables_text_is_not_read_as_the_slide_s_own_paragraphs() {
        let frame = format!(
            r#"<p:graphicFrame><p:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></p:xfrm><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame>"#,
            px(10),
            px(20),
            px(30),
            px(40)
        );
        let document = read_deck(&size(), &slide_xml(&frame), &[], "table");
        let shape = &document.slides[0].shapes[0];
        assert_eq!(shape.kind, ShapeKind::Other);
        assert_eq!((shape.x, shape.y, shape.width, shape.height), (10.0, 20.0, 30.0, 40.0));
        assert!(shape.paragraphs.is_empty());
    }

    #[test]
    fn shapes_are_read_in_the_order_the_slide_puts_them_in() {
        let shapes = [
            text_shape("<a:p><a:r><a:t>first</a:t></a:r></a:p>", None, None),
            text_shape("<a:p><a:r><a:t>second</a:t></a:r></a:p>", None, None),
        ]
        .concat();
        let document = read_deck(&size(), &slide_xml(&shapes), &[], "order2");
        assert_eq!(document.slides[0].shapes.len(), 2);
        assert_eq!(document.slides[0].shapes[1].paragraphs[0].runs[0].text, "second");
    }

    #[test]
    fn a_slide_wider_than_the_pane_draws_says_so() {
        let mut shapes = String::new();
        for index in 0..MAX_SHAPES + 3 {
            shapes.push_str(&format!(
                r#"<p:sp><p:spPr><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></p:spPr></p:sp>"#,
                px(index as i64),
                px(0),
                px(1),
                px(1)
            ));
        }
        let document = read_deck(&size(), &slide_xml(&shapes), &[], "cap");
        assert!(document.truncated);
        assert_eq!(document.slides[0].shapes.len(), MAX_SHAPES);
    }

    #[test]
    fn a_slide_cut_off_in_the_middle_is_reported_as_truncated() {
        let slide = r#"<?xml version="1.0"?><p:sld><p:cSld><p:spTree><p:sp><p:spPr>"#;
        let document = read_deck(&size(), slide, &[], "cut");
        assert!(document.truncated);
    }

    // -----------------------------------------------------------------------------------------
    // Pictures
    // -----------------------------------------------------------------------------------------

    /// A 1x1 PNG, which is all the reader needs to see: its bytes and its type.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89,
    ];

    fn picture_shape(embed: &str) -> String {
        format!(
            r#"<p:pic><p:nvPicPr><p:cNvPr id="3" name="P"/></p:nvPicPr><p:blipFill><a:blip r:embed="{embed}"/></p:blipFill><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm></p:spPr></p:pic>"#,
            px(10),
            px(20),
            px(200),
            px(100)
        )
    }

    /// The archive with a picture in it, read back.
    fn read_deck_with_png(slide: &str, tag: &str) -> PptxDocument {
        let dir = std::env::temp_dir().join(format!("verta-pptx-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("deck.pptx");
        let parts: Vec<(&str, Vec<u8>)> = vec![
            ("ppt/presentation.xml", size().into_bytes()),
            (
                "ppt/_rels/presentation.xml.rels",
                rels_xml(&[("rId2", "slides/slide1.xml")]).into_bytes(),
            ),
            ("ppt/slides/slide1.xml", slide.as_bytes().to_vec()),
            (
                "ppt/slides/_rels/slide1.xml.rels",
                rels_xml(&[("rId3", "../media/image1.png")]).into_bytes(),
            ),
            ("ppt/media/image1.png", PNG.to_vec()),
        ];
        std::fs::write(&file, write_zip_bytes(&parts)).unwrap();
        let document = read_pptx_sync(&file).unwrap();
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
        document
    }

    #[test]
    fn a_picture_is_resolved_through_the_slide_s_own_relationships() {
        let document = read_deck_with_png(&slide_xml(&picture_shape("rId3")), "pic");
        let shape = &document.slides[0].shapes[0];
        assert_eq!(shape.kind, ShapeKind::Picture);
        let image = shape.image.as_deref().unwrap();
        assert!(image.starts_with("data:image/png;base64,"), "{image}");
        assert_eq!((shape.x, shape.y, shape.width, shape.height), (10.0, 20.0, 200.0, 100.0));
    }

    #[test]
    fn a_picture_the_slide_does_not_name_leaves_the_box_without_an_image() {
        let document = read_deck_with_png(&slide_xml(&picture_shape("rId99")), "picnone");
        let shape = &document.slides[0].shapes[0];
        assert_eq!(shape.image, None);
        // The place is still known, so the slide keeps its layout.
        assert_eq!((shape.x, shape.y, shape.width, shape.height), (10.0, 20.0, 200.0, 100.0));
    }

    #[test]
    fn a_media_type_the_pane_does_not_draw_is_not_read() {
        let document = read_deck_with_png(
            &slide_xml(&picture_shape("rId3")),
            "picpng",
        );
        assert!(document.slides[0].shapes[0].image.is_some());
        // A file whose type is not a picture is skipped rather than sent as a broken data URL.
        assert_eq!(super::super::office::image_mime("clip.mov"), None);
    }
}

