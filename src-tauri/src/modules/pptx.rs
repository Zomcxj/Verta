//! Presentations, read as the slides they are.
//!
//! A `.pptx` is a ZIP of XML, and the webview has no PowerPoint to hand it to. What this does is
//! take each slide's shapes with the box they sit in, the text they carry with the styling that
//! text declares, and the pictures the slide's own relationship table points at, and hand the
//! frontend a set of positioned boxes to draw.
//!
//! Colour, type and place are inherited rather than declared: a shape names a theme role such as
//! `accent1` and the theme says what that is, a title placeholder that states no size takes the
//! master's, and one that states no box is drawn where its layout or its master puts it. The chain
//! is read here - slide, then its layout, then the layout's master, then the master's theme -
//! because a deck whose theme is ignored loses three quarters of its colours.
//!
//! What this deliberately does not do: invent a box for a placeholder that no level of the file
//! places, which 210 of the shapes measured here are. Charts, SmartArt, animations, transitions,
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
use super::pptx_color::{ColorRef, Theme};
use super::pptx_theme::{
    read_background, read_background_picture, read_clr_map, read_master_styles,
    read_placeholder_boxes, read_theme, LevelStyles, MasterStyles, PlaceholderBox, RunStyle,
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
    /// `#rrggbb` the slide is drawn on, which the slide, its layout or its master states. Absent
    /// means white paper, which is what a deck with no background is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    /// A picture the slide is drawn on, as a `data:` URL, from the same three levels. A paper that
    /// is a photograph states no colour, so at most one of these two is ever set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_image: Option<String>,
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

/// What a slide inherits from the parts above it: the theme, the master's text styles, and the
/// layout's own text styles and background.
///
/// One deck usually has one or two masters and a dozen layouts, so these are read once per part and
/// shared by every slide that points at them.
#[derive(Debug, Default, Clone)]
struct Inherited {
    theme: Theme,
    master: MasterStyles,
    /// The boxes the layout gives its placeholders, and the ones its master gives them. A slide's
    /// placeholder that states no transform is drawn in the layout's box, and in the master's when
    /// the layout states none.
    layout_boxes: HashMap<String, PlaceholderBox>,
    master_boxes: HashMap<String, PlaceholderBox>,
    /// The layout's own background, used when the slide states none.
    ///
    /// The layout's text styles are deliberately not read: a layout states them per placeholder
    /// shape, and a slide's own `a:lstStyle` is where a shape says how its text is set. Taking the
    /// layout's list wholesale painted a 60pt title size over ordinary text boxes that the master
    /// sets at 18pt.
    layout_background: Option<String>,
    /// The master's background, used when neither the slide nor the layout states one.
    master_background: Option<String>,
    /// The same three levels again, for a paper that is a picture rather than a colour.
    layout_background_picture: Option<String>,
    master_background_picture: Option<String>,
}

/// The parts a slide inherits from, as the reader found them.
///
/// Both caches are keyed by the part they describe, and the layout cache holds the layout already
/// merged with its master. Caching "layout to master" instead and then answering from the master's
/// entry gave every slide after the first of a layout the *previous* layout's boxes, which is a
/// mistake that only shows once a deck has two layouts on one master.
fn inherited_for(
    archive: &Archive,
    slide_rels: &HashMap<String, String>,
    layouts: &mut HashMap<String, Inherited>,
    masters: &mut HashMap<String, Inherited>,
    images_bytes: &mut u64,
) -> Result<Inherited, String> {
    let Some(layout) = slide_rels
        .values()
        .find(|target| target.contains("slideLayout"))
        .cloned()
    else {
        return Ok(Inherited::default());
    };
    if let Some(inherited) = layouts.get(&layout) {
        return Ok(inherited.clone());
    }
    let layout_xml = archive
        .text(&layout, MAX_PART_BYTES, ".pptx")?
        .unwrap_or_default();
    let layout_rels = slide_relationships(archive, &layout)?;
    let master_path = layout_rels
        .values()
        .find(|target| target.contains("slideMaster"))
        .cloned();
    let mut inherited = match master_path {
        Some(path) => match masters.get(&path) {
            Some(cached) => cached.clone(),
            None => {
                let built = read_master(archive, &path, images_bytes)?;
                masters.insert(path, built.clone());
                built
            }
        },
        None => Inherited::default(),
    };
    // What the layout itself states sits in front of the master's.
    inherited.layout_boxes = read_placeholder_boxes(&layout_xml, "布局")?;
    inherited.layout_background = read_background(&layout_xml, &inherited.theme);
    inherited.layout_background_picture =
        background_picture(archive, &layout_xml, &layout_rels, images_bytes)?;
    layouts.insert(layout, inherited.clone());
    Ok(inherited)
}

/// What a master states: its theme, its levels of text style, and what it puts behind a slide.
fn read_master(
    archive: &Archive,
    path: &str,
    images_bytes: &mut u64,
) -> Result<Inherited, String> {
    let master_xml = archive
        .text(path, MAX_PART_BYTES, ".pptx")?
        .unwrap_or_default();
    let master_rels = slide_relationships(archive, path)?;
    let theme = match master_rels
        .values()
        .find(|target| target.contains("theme"))
        .cloned()
    {
        Some(theme_path) => match archive.text(&theme_path, MAX_PART_BYTES, ".pptx")? {
            Some(theme_xml) => read_theme(&theme_xml).with_roles(read_clr_map(&master_xml)),
            // A master with no readable theme still says which slot each role means.
            None => Theme::default().with_roles(read_clr_map(&master_xml)),
        },
        None => Theme::default().with_roles(read_clr_map(&master_xml)),
    };
    Ok(Inherited {
        master_boxes: read_placeholder_boxes(&master_xml, "母版")?,
        master_background: read_background(&master_xml, &theme),
        master_background_picture: background_picture(
            archive,
            &master_xml,
            &master_rels,
            images_bytes,
        )?,
        master: read_master_styles(&master_xml),
        theme,
        // A master states nothing about layouts: those belong to the layout entries.
        ..Inherited::default()
    })
}

/// The picture a part puts behind its slides, as a `data:` URL.
///
/// A background is a picture the same way a shape's is, so it comes out of the same budget: a deck
/// of a hundred slides inheriting one photograph would otherwise be a hundred copies of it.
fn background_picture(
    archive: &Archive,
    xml: &str,
    rels: &HashMap<String, String>,
    images_bytes: &mut u64,
) -> Result<Option<String>, String> {
    let Some(embed) = read_background_picture(xml) else {
        return Ok(None);
    };
    let Some(target) = rels.get(&embed) else {
        return Ok(None);
    };
    if *images_bytes >= MAX_IMAGES_BYTES {
        return Ok(None);
    }
    let budget = MAX_IMAGE_BYTES.min(MAX_IMAGES_BYTES - *images_bytes);
    let Some(bytes) = archive.bytes(target, budget, ".pptx")? else {
        return Ok(None);
    };
    let Some(url) = data_url(target, &bytes) else {
        return Ok(None);
    };
    *images_bytes += bytes.len() as u64;
    Ok(Some(url))
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
    let mut layouts: HashMap<String, Inherited> = HashMap::new();
    let mut masters: HashMap<String, Inherited> = HashMap::new();
    for (index, relationship_id) in order.iter().take(MAX_SLIDES).enumerate() {
        let Some(target) = rels.get(relationship_id) else {
            // A slide the deck lists and has no part for is a slide that cannot be drawn; the ones
            // around it still can.
            slides.push(PptxSlide {
                index: index as u32,
                shapes: Vec::new(),
                background: None,
                background_image: None,
            });
            continue;
        };
        let xml = archive.required(target, MAX_PART_BYTES, ".pptx")?;
        let slide_rels = slide_relationships(&archive, target)?;
        let inherited = inherited_for(
            &archive,
            &slide_rels,
            &mut layouts,
            &mut masters,
            &mut images_bytes,
        )?;
        // The first level that states a background at all is the one that answers, and it answers
        // for both kinds: a slide drawn on a photograph does not also take its master's colour, which
        // is what falling back with each kind on its own would have done.
        let own_colour = read_background(&xml, &inherited.theme);
        let own_picture = background_picture(&archive, &xml, &slide_rels, &mut images_bytes)?;
        let (background, background_image) = if own_colour.is_some() || own_picture.is_some() {
            (own_colour, own_picture)
        } else if inherited.layout_background.is_some()
            || inherited.layout_background_picture.is_some()
        {
            (
                inherited.layout_background.clone(),
                inherited.layout_background_picture.clone(),
            )
        } else {
            (
                inherited.master_background.clone(),
                inherited.master_background_picture.clone(),
            )
        };
        let (shapes, cut) = parse_slide(
            &xml,
            &archive,
            &slide_rels,
            &inherited,
            &mut images_bytes,
        )?;
        truncated |= cut;
        slides.push(PptxSlide {
            index: index as u32,
            shapes,
            background,
            background_image,
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
    /// The placeholder this shape is, which decides which of the master's lists its text takes.
    placeholder: Option<String>,
    /// The key the layout and the master address this placeholder by: its `idx` when it names one,
    /// and its `type` when it does not.
    placeholder_key: Option<String>,
    /// Whether the shape stated a box of its own. A placeholder that states none is drawn where
    /// its layout or its master puts it, which is what "inherits its place" means.
    boxed: bool,
    /// The shape's own `a:lstStyle`, which sits between the master's styles and the run's.
    list_style: Option<LevelStyles>,
    /// The colour a run states, kept unresolved until the shape ends so a theme role can be looked
    /// up once rather than at every colour.
    run_color: Option<ColorRef>,
    /// The colour the shape's own fill states, likewise unresolved.
    fill_color: Option<ColorRef>,
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
            placeholder: None,
            placeholder_key: None,
            boxed: false,
            list_style: None,
            run_color: None,
            fill_color: None,
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
    /// Inside a shape's `<a:lstStyle>`, whose levels are being collected.
    in_list_style: bool,
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
    inherited: &Inherited,
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
    // The level a shape's own list style is being read at, and what that level states.
    let mut list_level = 0usize;
    let mut level_style: Option<RunStyle> = None;

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
                    // A placeholder says which of the master's three lists its text takes, and
                    // `type` is what a title is; `idx` alone is a body placeholder.
                    b"ph" => read_placeholder(&element, shape),
                    b"lstStyle" => {
                        // The shape's own levels are read here rather than by a second pass over
                        // the slide, so a shape's list style costs nothing extra.
                        where_.in_list_style = true;
                        shape.list_style = Some(LevelStyles::default());
                    }
                    b"rPr" | b"defRPr" => {
                        where_.in_run_props = true;
                        read_run_props(&element, shape.run.as_mut());
                        // Inside a list style, a `defRPr` states the level's own style rather than
                        // a run's.
                        if where_.in_list_style {
                            level_style = Some(level_run_style(&element));
                        }
                    }
                    b"lvl1pPr" | b"lvl2pPr" | b"lvl3pPr" | b"lvl4pPr" | b"lvl5pPr" | b"lvl6pPr"
                    | b"lvl7pPr" | b"lvl8pPr" | b"lvl9pPr"
                        if where_.in_list_style =>
                    {
                        list_level = level_of(&element);
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
                        shape.boxed = true;
                        shape.x = attr_number::<f64>(&element, b"x")
                            .map(emu_to_px)
                            .unwrap_or(shape.x);
                        shape.y = attr_number::<f64>(&element, b"y")
                            .map(emu_to_px)
                            .unwrap_or(shape.y);
                    }
                    b"ext" => {
                        shape.boxed = true;
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
                    // A colour written with children carries modifiers, so it is held unresolved
                    // until its own end arrives, after those children have been read.
                    b"srgbClr" => {
                        let color = attr(&element, b"val")
                            .as_deref()
                            .and_then(srgb_color)
                            .map(ColorRef::Srgb);
                        match where_.fill_target() {
                            FillTarget::Shape => shape.fill_color = color,
                            FillTarget::Run => shape.run_color = color,
                            FillTarget::None => {}
                        }
                    }
                    b"schemeClr" => {
                        let color = attr(&element, b"val").map(|role| ColorRef::Scheme {
                            role,
                            modifiers: Vec::new(),
                        });
                        match where_.fill_target() {
                            FillTarget::Shape => shape.fill_color = color,
                            FillTarget::Run => shape.run_color = color,
                            FillTarget::None => {}
                        }
                    }
                    // A modifier of the colour just named: `lumMod`, `lumOff`, `tint`, `shade`.
                    b"lumMod" | b"lumOff" | b"tint" | b"shade" => {
                        let value = attr_number::<f64>(&element, b"val").unwrap_or(0.0) / 1000.0;
                        let name = String::from_utf8_lossy(&tag).to_string();
                        let target = match where_.fill_target() {
                            FillTarget::Shape => shape.fill_color.as_mut(),
                            FillTarget::Run => shape.run_color.as_mut(),
                            FillTarget::None => None,
                        };
                        if let Some(ColorRef::Scheme { modifiers, .. }) = target {
                            modifiers.push((name, value));
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
                            shapes.push(finish_shape(
                                shape,
                                slide_rels,
                                archive,
                                inherited,
                                images_bytes,
                            )?);
                        } else {
                            truncated = true;
                        }
                    }
                    continue;
                };
                match tag.as_slice() {
                    // A placeholder is written self closed, so it only reaches the Empty arm.
                    b"ph" => read_placeholder(&element, shape),
                    // A level wrapper written with no children still names its level.
                    b"lvl1pPr" | b"lvl2pPr" | b"lvl3pPr" | b"lvl4pPr" | b"lvl5pPr" | b"lvl6pPr"
                    | b"lvl7pPr" | b"lvl8pPr" | b"lvl9pPr"
                        if where_.in_list_style =>
                    {
                        list_level = level_of(&element);
                    }
                    b"br" => break_line(shape),
                    b"off" => {
                        shape.boxed = true;
                        shape.x = attr_number::<f64>(&element, b"x")
                            .map(emu_to_px)
                            .unwrap_or(shape.x);
                        shape.y = attr_number::<f64>(&element, b"y")
                            .map(emu_to_px)
                            .unwrap_or(shape.y);
                    }
                    b"ext" => {
                        shape.boxed = true;
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
                    // A run's own properties are written self-closed in every real deck
                    // (`<a:rPr sz="1800"/>`), so they are read here as well as in the Start arm.
                    b"rPr" | b"defRPr" => {
                        read_run_props(&element, shape.run.as_mut());
                        if where_.in_list_style {
                            level_style = Some(level_run_style(&element));
                        }
                    }
                    b"latin" if where_.in_list_style => {
                        if let Some(style) = level_style.as_mut() {
                            style.font = attr(&element, b"typeface");
                        }
                    }
                    b"latin" if shape.run.is_some() => {
                        if let Some(run) = shape.run.as_mut() {
                            run.font = attr(&element, b"typeface");
                        }
                    }
                    b"srgbClr" if where_.in_list_style => {
                        if let Some(style) = level_style.as_mut() {
                            style.color = attr(&element, b"val").and_then(|value| srgb_color(&value));
                        }
                    }
                    b"schemeClr" if where_.in_list_style => {
                        if let Some(style) = level_style.as_mut() {
                            style.color = attr(&element, b"val");
                        }
                    }
                    // A colour written with no children is resolved here; one with modifiers is
                    // resolved when its own end arrives, after those children have been read.
                    b"srgbClr" | b"schemeClr" => {
                        let color = match tag.as_slice() {
                            b"srgbClr" => attr(&element, b"val")
                                .as_deref()
                                .and_then(srgb_color)
                                .map(ColorRef::Srgb),
                            _ => attr(&element, b"val").map(|role| ColorRef::Scheme {
                                role,
                                modifiers: Vec::new(),
                            }),
                        };
                        let color = color.and_then(|color| color.resolve(&inherited.theme));
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
                    // A modifier of the colour just named: `lumMod`, `lumOff`, `tint`, `shade`.
                    b"lumMod" | b"lumOff" | b"tint" | b"shade" => {
                        let value = attr_number::<f64>(&element, b"val").unwrap_or(0.0) / 1000.0;
                        let name = String::from_utf8_lossy(&tag).to_string();
                        let target = match where_.fill_target() {
                            FillTarget::Shape => shape.fill_color.as_mut(),
                            FillTarget::Run => shape.run_color.as_mut(),
                            FillTarget::None => None,
                        };
                        if let Some(ColorRef::Scheme { modifiers, .. }) = target {
                            modifiers.push((name, value));
                        }
                    }
                    b"latin" if shape.run.is_some() => {
                        if let Some(run) = shape.run.as_mut() {
                            run.font = attr(&element, b"typeface");
                        }
                    }
                    // A colour and a typeface inside a list style belong to the level, not to a
                    // run that is being read at the same time.
                    b"latin" if where_.in_list_style => {
                        if let Some(style) = level_style.as_mut() {
                            style.font = attr(&element, b"typeface");
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
                        // A colour is resolved when its own element ends, because its modifiers are
                        // children of it and arrive before it closes.
                        b"srgbClr" | b"schemeClr" => {
                            let resolved = match where_.fill_target() {
                                FillTarget::Shape => shape.fill_color.take(),
                                FillTarget::Run => shape.run_color.take(),
                                FillTarget::None => None,
                            };
                            let color = resolved.and_then(|color| color.resolve(&inherited.theme));
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
                        b"lstStyle" => where_.in_list_style = false,
                        b"lvl1pPr" | b"lvl2pPr" | b"lvl3pPr" | b"lvl4pPr" | b"lvl5pPr"
                        | b"lvl6pPr" | b"lvl7pPr" | b"lvl8pPr" | b"lvl9pPr"
                            if where_.in_list_style =>
                        {
                            if let (Some(style), Some(levels)) =
                                (level_style.take(), shape.list_style.as_mut())
                            {
                                levels.set(list_level, style);
                            }
                        }
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
                            shapes.push(finish_shape(
                                shape,
                                slide_rels,
                                archive,
                                inherited,
                                images_bytes,
                            )?);
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

/// A shape as the pane draws it, with its picture resolved into a `data:` URL and the styling it
/// inherits from its layout, its master and the theme filled in.
fn finish_shape(
    mut shape: PendingShape,
    slide_rels: &HashMap<String, String>,
    archive: &Archive,
    inherited: &Inherited,
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
    let fill = shape
        .fill_color
        .take()
        .and_then(|color| color.resolve(&inherited.theme))
        .or_else(|| shape.fill.take());
    // A placeholder that states no transform is where the layout puts it, and where the master
    // puts it when the layout states none. Without this the box was zero by zero at the origin,
    // which is a shape the pane draws and no one can see.
    if !shape.boxed {
        if let Some(key) = shape.placeholder_key.as_deref() {
            if let Some(box_) = inherited
                .layout_boxes
                .get(key)
                .or_else(|| inherited.master_boxes.get(key))
                .filter(|box_| !box_.is_empty())
            {
                shape.x = box_.x;
                shape.y = box_.y;
                shape.width = box_.width;
                shape.height = box_.height;
            }
        }
    }
    let paragraphs = apply_inheritance(
        std::mem::take(&mut shape.paragraphs),
        &shape,
        inherited,
    );
    Ok(PptxShape {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        rotation: shape.rotation,
        kind: shape.kind,
        fill,
        image: shape.image,
        paragraphs,
    })
}

/// Every paragraph of a shape with what it inherits from the shape, the layout and the master.
///
/// Three levels reach a run and the narrowest wins: the master's list for this kind of shape, the
/// shape's own `a:lstStyle`, and the run's `<a:rPr>`. What none of them states stays unset, which
/// leaves the pane drawing it at its own default rather than at a size the file never asked for.
fn apply_inheritance(
    paragraphs: Vec<PptxParagraph>,
    shape: &PendingShape,
    inherited: &Inherited,
) -> Vec<PptxParagraph> {
    let own = shape.list_style.clone().unwrap_or_default();
    paragraphs
        .into_iter()
        .map(|mut paragraph| {
            let level = paragraph.level as usize;
            let master = inherited
                .master
                .for_placeholder(shape.placeholder.as_deref(), level);
            let style = own.at(level).over(master);
            for run in &mut paragraph.runs {
                if run.size.is_none() {
                    run.size = style.size;
                }
                if !run.bold {
                    run.bold = style.bold.unwrap_or(false);
                }
                if !run.italic {
                    run.italic = style.italic.unwrap_or(false);
                }
                if run.color.is_none() {
                    run.color = style
                        .color
                        .as_deref()
                        .and_then(|color| theme_colour(color, &inherited.theme));
                }
                if run.font.is_none() {
                    run.font = style
                        .font
                        .as_deref()
                        .map(|font| theme_font(font, &inherited.theme))
                        .filter(|font| !font.is_empty());
                }
            }
            // A run that named a theme slot for itself is drawn in the typeface that slot stands
            // for, whether the slot came from the run or from a level above it.
            for run in &mut paragraph.runs {
                if let Some(font) = run.font.as_deref().map(|font| theme_font(font, &inherited.theme))
                {
                    run.font = (!font.is_empty()).then_some(font);
                }
            }
            paragraph
        })
        .collect()
}

/// A colour a style states, resolved through the theme.
///
/// A style names either a literal `#rrggbb` or a theme role, and the two are told apart by the
/// leading `#`: a role is a word such as `tx2`.
fn theme_colour(stated: &str, theme: &Theme) -> Option<String> {
    if stated.starts_with('#') {
        return Some(stated.to_string());
    }
    let reference = ColorRef::Scheme {
        role: stated.to_string(),
        modifiers: Vec::new(),
    };
    reference.resolve(theme)
}

/// A typeface a style states, resolved through the theme when it names a slot such as `+mj-lt`.
fn theme_font(stated: &str, theme: &Theme) -> String {
    if stated.starts_with('+') {
        return theme.font(stated).cloned().unwrap_or_default();
    }
    stated.to_string()
}

/// What a `p:ph` states: the kind of placeholder it is, and the key the layout and master address
/// it by.
///
/// A placeholder names an `idx` when it is one of several bodies, and a `type` when it is the title
/// or a footer; a slide's counterpart is found by the index first, and by the type when the slide
/// names no index.
fn read_placeholder(element: &BytesStart<'_>, shape: &mut PendingShape) {
    let kind = attr(element, b"type").unwrap_or_else(|| "body".to_string());
    let key = attr(element, b"idx").unwrap_or_else(|| kind.clone());
    shape.placeholder = Some(kind);
    shape.placeholder_key = Some(key);
}

/// The level a `lvlNpPr` element stands for.
fn level_of(element: &BytesStart<'_>) -> usize {
    let name = String::from_utf8_lossy(element.name().as_ref()).to_string();
    name.trim_start_matches(|character: char| !character.is_ascii_digit())
        .trim_end_matches(|character: char| !character.is_ascii_digit())
        .parse::<usize>()
        .map(|depth| depth.saturating_sub(1))
        .unwrap_or(0)
}

/// What a `defRPr` inside a list style states, with the colour and typeface its children carry.
fn level_run_style(element: &BytesStart<'_>) -> RunStyle {
    RunStyle {
        size: attr_number::<f32>(element, b"sz").map(|size| size / 100.0),
        bold: flag(element, b"b"),
        italic: flag(element, b"i"),
        color: None,
        font: None,
    }
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

    // -----------------------------------------------------------------------------------------
    // What a slide inherits from its theme, its master and its layout
    // -----------------------------------------------------------------------------------------

    /// A deck whose slide points at a layout, which points at a master, which points at a theme.
    fn themed_deck(slide: &str, tag: &str) -> PptxDocument {
        read_deck(
            &size(),
            slide,
            &[
                (
                    "ppt/slides/_rels/slide1.xml.rels",
                    &rels_xml(&[("rId9", "../slideLayouts/slideLayout1.xml")]),
                ),
                (
                    "ppt/slideLayouts/slideLayout1.xml",
                    r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree/></p:sldLayout>"#,
                ),
                (
                    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
                    &rels_xml(&[("rId10", "../slideMasters/slideMaster1.xml")]),
                ),
                (
                    "ppt/slideMasters/slideMaster1.xml",
                    r#"<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:clrMap bg1="lt1" tx1="dk1" tx2="dk2"/><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1400"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>"#,
                ),
                (
                    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
                    &rels_xml(&[("rId11", "../theme/theme1.xml")]),
                ),
                (
                    "ppt/theme/theme1.xml",
                    r#"<?xml version="1.0"?><a:theme xmlns:a="a"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>"#,
                ),
            ],
            tag,
        )
    }

    #[test]
    fn a_title_placeholder_takes_the_master_s_size_weight_and_colour() {
        // The master says 36pt bold in `tx2`; before the theme was read every title was 18pt regular
        // in black, which is what the pane's own default happened to be.
        let body = r#"<a:p><a:r><a:rPr/><a:t>Title</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/></p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#,
            px(100), px(50), px(300), px(120)
        ));
        let document = themed_deck(&slide, "ph-title");
        let run = &document.slides[0].shapes[0].paragraphs[0].runs[0];
        assert_eq!(run.size, Some(36.0));
        assert!(run.bold);
        // `tx2` is a role the master's map points at `dk2`, so the colour is the slot, not the word.
        assert_eq!(run.color, Some("#44546a".to_string()));
    }

    #[test]
    fn a_plain_text_box_takes_the_master_s_other_style() {
        // A box with no placeholder is not a title: taking the title's list wholesale is what put
        // 60pt over ordinary text on a real deck.
        let body = r#"<a:p><a:r><a:rPr/><a:t>plain</a:t></a:r></a:p>"#;
        let document = themed_deck(&text_shape(body, None, None), "ph-plain");
        let run = &document.slides[0].shapes[0].paragraphs[0].runs[0];
        assert_eq!(run.size, Some(14.0));
    }

    #[test]
    fn a_run_s_own_size_wins_over_the_master_s() {
        let body = r#"<a:p><a:r><a:rPr sz="2400"/><a:t>big</a:t></a:r></a:p>"#;
        let document = themed_deck(&text_shape(body, None, None), "ph-own-size");
        let run = &document.slides[0].shapes[0].paragraphs[0].runs[0];
        assert_eq!(run.size, Some(24.0));
    }

    #[test]
    fn a_theme_colour_fills_the_shape() {
        // `accent1` is a slot, so the fill is the theme's own colour for it.
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#,
            px(100), px(50), px(300), px(120)
        ));
        let document = themed_deck(&slide, "theme-fill");
        assert_eq!(
            document.slides[0].shapes[0].fill,
            Some("#4472c4".to_string())
        );
    }

    #[test]
    fn a_modifier_on_a_role_darkens_the_slot_it_resolves_to() {
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="20000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#,
            px(100), px(50), px(300), px(120)
        ));
        let document = themed_deck(&slide, "theme-modifier");
        // `#4472c4` at a fifth of its lightness, which is the same arithmetic the colour module's
        // own test pins.
        assert_eq!(
            document.slides[0].shapes[0].fill,
            Some("#0d1728".to_string())
        );
    }

    #[test]
    fn a_shape_s_own_list_style_sets_the_level_it_states() {
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Box"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="2000" b="1"/></a:lvl1pPr></a:lstStyle>{body}</p:txBody></p:sp>"#,
            px(100), px(50), px(300), px(120)
        ));
        let document = themed_deck(&slide, "own-list-style");
        let run = &document.slides[0].shapes[0].paragraphs[0].runs[0];
        assert_eq!(run.size, Some(20.0));
        assert!(run.bold);
    }

    #[test]
    fn the_theme_font_replaces_the_slot_a_run_names() {
        let body = r#"<a:p><a:r><a:rPr><a:latin typeface="+mj-lt"/></a:rPr><a:t>x</a:t></a:r></a:p>"#;
        let document = themed_deck(&text_shape(body, None, None), "theme-font");
        let run = &document.slides[0].shapes[0].paragraphs[0].runs[0];
        assert_eq!(run.font, Some("Calibri Light".to_string()));
    }

    #[test]
    fn a_slide_drawn_on_a_picture_carries_the_picture_as_a_data_url() {
        // 38 of the 3857 slides measured here are drawn on a photograph, and every one of them came
        // out as plain white paper: the background reader knew only about colours.
        let xml = r#"<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:bg><p:bgPr><a:blipFill rotWithShape="1"><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>"#;
        let document = read_deck_with_png(xml, "bg-picture");
        let slide = &document.slides[0];
        assert!(
            slide
                .background_image
                .as_deref()
                .is_some_and(|url| url.starts_with("data:image/png;base64,")),
            "{:?}",
            slide.background_image
        );
        // A paper that is a picture states no colour, so the two never both apply.
        assert_eq!(slide.background, None);
    }

    /// A deck whose master paints its slides dark and whose slide states its own paper, if any.
    fn deck_over_a_dark_master(slide: &str, tag: &str) -> PptxDocument {
        let dir = std::env::temp_dir().join(format!("verta-pptx-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("deck.pptx");
        let master = r#"<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:sldMaster>"#;
        let layout = r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree/></p:sldLayout>"#;
        let parts: Vec<(&str, Vec<u8>)> = vec![
            ("ppt/presentation.xml", size().into_bytes()),
            (
                "ppt/_rels/presentation.xml.rels",
                rels_xml(&[("rId2", "slides/slide1.xml")]).into_bytes(),
            ),
            ("ppt/slides/slide1.xml", slide.as_bytes().to_vec()),
            (
                "ppt/slides/_rels/slide1.xml.rels",
                rels_xml(&[
                    ("rId3", "../media/image1.png"),
                    ("rId9", "../slideLayouts/slideLayout1.xml"),
                ])
                .into_bytes(),
            ),
            ("ppt/slideLayouts/slideLayout1.xml", layout.as_bytes().to_vec()),
            (
                "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
                rels_xml(&[("rId10", "../slideMasters/slideMaster1.xml")]).into_bytes(),
            ),
            ("ppt/slideMasters/slideMaster1.xml", master.as_bytes().to_vec()),
            ("ppt/media/image1.png", PNG.to_vec()),
        ];
        std::fs::write(&file, write_zip_bytes(&parts)).unwrap();
        let document = read_pptx_sync(&file).unwrap();
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
        document
    }

    #[test]
    fn a_slide_on_its_own_picture_paper_does_not_also_take_the_master_s_colour() {
        // The two kinds of paper fall back together, not one at a time: a slide drawn on a photograph
        // has a paper, and reaching past it for the master's colour would paint one behind the other.
        let slide = r#"<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:bg><p:bgPr><a:blipFill rotWithShape="1"><a:blip r:embed="rId3"/></a:blipFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>"#;
        let document = deck_over_a_dark_master(slide, "paper-picture");
        let read = &document.slides[0];
        assert!(read.background_image.is_some(), "{:?}", read.background_image);
        assert_eq!(read.background, None);
    }

    #[test]
    fn a_slide_that_states_no_paper_takes_the_master_s_colour() {
        let slide = r#"<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree/></p:cSld></p:sld>"#;
        let document = deck_over_a_dark_master(slide, "paper-master");
        assert_eq!(
            document.slides[0].background,
            Some("#1f3864".to_string())
        );
        assert_eq!(document.slides[0].background_image, None);
    }

    #[test]
    fn a_slide_s_own_background_is_the_colour_it_states() {
        let slide = r#"<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sld>"#;
        let document = themed_deck(slide, "bg-own");
        assert_eq!(document.slides[0].background, Some("#1f3864".to_string()));
    }

    /// A deck whose layout gives its placeholders the boxes a slide may inherit.
    fn deck_with_layout_boxes(slide: &str, layout: &str, tag: &str) -> PptxDocument {
        read_deck(
            &size(),
            slide,
            &[
                (
                    "ppt/slides/_rels/slide1.xml.rels",
                    &rels_xml(&[("rId9", "../slideLayouts/slideLayout1.xml")]),
                ),
                ("ppt/slideLayouts/slideLayout1.xml", layout),
                (
                    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
                    &rels_xml(&[("rId10", "../slideMasters/slideMaster1.xml")]),
                ),
                (
                    "ppt/slideMasters/slideMaster1.xml",
                    r#"<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="7"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="76200" y="85725"/><a:ext cx="190500" cy="285750"/></a:xfrm></p:spPr></p:sp></p:spTree></p:sldMaster>"#,
                ),
            ],
            tag,
        )
    }

    #[test]
    fn a_placeholder_that_states_no_box_is_drawn_in_the_layout_s() {
        // 868 placeholders across the decks measured here state no transform at all; drawn at the
        // origin with no size, their text is a shape nobody can see.
        let body = r#"<a:p><a:r><a:rPr/><a:t>Where am I</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#
        ));
        let layout = r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="9525" y="19050"/><a:ext cx="95250" cy="28575"/></a:xfrm></p:spPr></p:sp></p:spTree></p:sldLayout>"#;
        let document = deck_with_layout_boxes(&slide, layout, "box-layout");
        let shape = &document.slides[0].shapes[0];
        assert_eq!((shape.x, shape.y), (1.0, 2.0));
        assert_eq!((shape.width, shape.height), (10.0, 3.0));
        assert_eq!(shape.paragraphs[0].runs[0].text, "Where am I");
    }

    #[test]
    fn each_layout_gives_its_own_boxes_even_when_it_shares_a_master() {
        // A deck's layouts almost always share one master. The first version cached "layout ->
        // master" and then answered every slide on any layout from that master's entry, so from the
        // second slide of the second layout on, a title took the *first* layout's title box.
        let layout = |width: i64| {
            format!(
                r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{}" cy="{}"/></a:xfrm></p:spPr></p:sp></p:spTree></p:sldLayout>"#,
                px(width),
                px(100)
            )
        };
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let title = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#
        ));
        let layout_rels = rels_xml(&[("rId10", "../slideMasters/slideMaster1.xml")]);
        let master = r#"<?xml version="1.0"?><p:sldMaster xmlns:p="p" xmlns:a="a"><p:spTree/></p:sldMaster>"#;

        let mut parts: Vec<(&str, String)> = vec![
            (
                "ppt/presentation.xml",
                presentation_xml(
                    px(960),
                    px(540),
                    &[("256", "rId2"), ("257", "rId3"), ("258", "rId4")],
                ),
            ),
            (
                "ppt/_rels/presentation.xml.rels",
                rels_xml(&[
                    ("rId2", "slides/slide1.xml"),
                    ("rId3", "slides/slide2.xml"),
                    ("rId4", "slides/slide3.xml"),
                ]),
            ),
            ("ppt/slideLayouts/slideLayout1.xml", layout(400)),
            ("ppt/slideLayouts/slideLayout2.xml", layout(120)),
            ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels.clone()),
            ("ppt/slideLayouts/_rels/slideLayout2.xml.rels", layout_rels),
            ("ppt/slideMasters/slideMaster1.xml", master.to_string()),
        ];
        // The first slide is on the wide layout, the next two on the narrow one: the third is the one
        // the cache used to answer with the wrong layout's boxes.
        for (at, target) in [
            (1, "slideLayout1"),
            (2, "slideLayout2"),
            (3, "slideLayout2"),
        ] {
            parts.push((
                Box::leak(format!("ppt/slides/slide{at}.xml").into_boxed_str()),
                title.clone(),
            ));
            parts.push((
                Box::leak(format!("ppt/slides/_rels/slide{at}.xml.rels").into_boxed_str()),
                rels_xml(&[("rId9", &format!("../slideLayouts/{target}.xml"))]),
            ));
        }
        let dir = std::env::temp_dir().join(format!("verta-pptx-layouts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("deck.pptx");
        let borrowed: Vec<(&str, &str)> = parts
            .iter()
            .map(|(name, content)| (*name, content.as_str()))
            .collect();
        std::fs::write(&file, write_zip(&borrowed)).unwrap();
        let document = read_pptx_sync(&file).unwrap();
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();

        let widths: Vec<f32> = document
            .slides
            .iter()
            .map(|slide| slide.shapes[0].width)
            .collect();
        assert_eq!(widths, vec![400.0, 120.0, 120.0]);
    }

    #[test]
    fn a_placeholder_the_layout_does_not_place_takes_the_master_s_box() {
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="B"/><p:nvPr><p:ph idx="7"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#
        ));
        let layout = r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree/></p:sldLayout>"#;
        let document = deck_with_layout_boxes(&slide, layout, "box-master");
        let shape = &document.slides[0].shapes[0];
        assert_eq!((shape.x, shape.y), (8.0, 9.0));
        assert_eq!((shape.width, shape.height), (20.0, 30.0));
    }

    #[test]
    fn a_placeholder_that_states_its_own_box_keeps_it() {
        // A box the author moved is the box the author meant; the layout only answers for the ones
        // that state nothing.
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#,
            px(100), px(50), px(300), px(120)
        ));
        let layout = r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="9525" y="19050"/><a:ext cx="95250" cy="28575"/></a:xfrm></p:spPr></p:sp></p:spTree></p:sldLayout>"#;
        let document = deck_with_layout_boxes(&slide, layout, "box-own");
        let shape = &document.slides[0].shapes[0];
        assert_eq!((shape.x, shape.y), (100.0, 50.0));
        assert_eq!((shape.width, shape.height), (300.0, 120.0));
    }

    #[test]
    fn a_placeholder_no_level_places_stays_at_the_origin_rather_than_being_invented() {
        // 442 of the 868 measured placeholders have no box anywhere in the file. Guessing one would
        // put text somewhere the file never asked for, so it stays as it was.
        let body = r#"<a:p><a:r><a:rPr/><a:t>x</a:t></a:r></a:p>"#;
        let slide = slide_xml(&format!(
            r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="B"/><p:nvPr><p:ph idx="99"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>{body}</p:txBody></p:sp>"#
        ));
        let layout = r#"<?xml version="1.0"?><p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree/></p:sldLayout>"#;
        let document = deck_with_layout_boxes(&slide, layout, "box-none");
        let shape = &document.slides[0].shapes[0];
        assert_eq!((shape.x, shape.y), (0.0, 0.0));
        assert_eq!((shape.width, shape.height), (0.0, 0.0));
    }

    #[test]
    fn a_deck_with_no_theme_still_draws_its_slides() {
        // A missing theme is a deck drawn as it was before: no inherited size, no inherited colour.
        // Failing the whole read over it would lose text the slide does state.
        let body = r#"<a:p><a:r><a:rPr/><a:t>still here</a:t></a:r></a:p>"#;
        let document = read_deck(
            &size(),
            &slide_xml(&text_shape(body, None, None)),
            &[],
            "no-theme",
        );
        assert_eq!(document.slides.len(), 1);
        let run = &document.slides[0].shapes[0].paragraphs[0].runs[0];
        assert_eq!(run.text, "still here");
        assert_eq!(run.size, None);
        assert_eq!(document.slides[0].background, None);
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

