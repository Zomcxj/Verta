//! What a deck's theme says about colour and type, and how a slide inherits it.
//!
//! Three levels of text style reach a run, from the widest to the narrowest: the master's
//! `p:txStyles`, the shape's own `a:lstStyle`, and the run's own `<a:rPr>`. The first two are the
//! same shape of data - `a:lvl1pPr` to `a:lvl9pPr`, each with an `a:defRPr` - so they share one
//! reader, and a narrower level fills in what a wider one left unsaid.

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::Reader;

use super::office::{attr, attr_number, emu_to_px, flag, local, srgb_color};
use super::pptx_color::Theme;

/// The colour a master's `<p:clrMap>` says each role stands for, and the defaults when it says
/// nothing.
pub(crate) fn read_clr_map(xml: &str) -> HashMap<String, String> {
    // `bg1`/`tx1` default to the light and dark pair, which is what every deck relies on; every
    // other role defaults to the slot it is named after.
    let mut map: HashMap<String, String> = HashMap::new();
    for (role, slot) in [
        ("bg1", "lt1"),
        ("tx1", "dk1"),
        ("bg2", "lt2"),
        ("tx2", "dk2"),
    ] {
        map.insert(role.to_string(), slot.to_string());
    }
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if local(element.name()) != b"clrMap" {
                    continue;
                }
                // Every attribute of the map is a role, whatever it is called.
                for attribute in element.attributes().flatten() {
                    let role = String::from_utf8_lossy(attribute.key.local_name().as_ref()).to_string();
                    if let Ok(slot) = attribute.unescape_value() {
                        map.insert(role, slot.into_owned());
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

/// The theme a `themeN.xml` states: its colour slots and its font scheme.
pub(crate) fn read_theme(xml: &str) -> Theme {
    let mut slots: Vec<(String, String)> = Vec::new();
    let mut fonts: Vec<(String, String)> = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // Which list the reader is inside, since both are lists of named colours and fonts.
    let mut in_colours = false;
    let mut in_fonts = false;
    // A font slot is `<a:latin>` inside `<a:majorFont>`, so the list decides the prefix.
    let mut font_prefix = String::new();
    let mut pending_slot: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => match local(element.name()) {
                b"clrScheme" => in_colours = true,
                b"fontScheme" => in_fonts = true,
                b"majorFont" => font_prefix = "+mj-".to_string(),
                b"minorFont" => font_prefix = "+mn-".to_string(),
                b"sysClr" => {
                    if let Some(slot) = pending_slot.take() {
                        let named = attr(&element, b"val").unwrap_or_default();
                        // `lastClr` is the writer's fallback, and the only way to know what
                        // `windowText` was on the machine that wrote the file.
                        let colour = attr(&element, b"lastClr").unwrap_or_else(|| {
                            if named == "window" {
                                "FFFFFF".to_string()
                            } else {
                                "000000".to_string()
                            }
                        });
                        if let Some(colour) = srgb_color(&colour) {
                            slots.push((slot, colour));
                        }
                    }
                }
                b"srgbClr" if in_colours => {
                    if let Some(slot) = pending_slot.take() {
                        if let Some(colour) = attr(&element, b"val").as_deref().and_then(srgb_color) {
                            slots.push((slot, colour));
                        }
                    }
                }
                b"latin" if in_fonts => {
                    if let Some(typeface) = attr(&element, b"typeface") {
                        // An empty typeface is the file saying nothing, not a font called "".
                        if !typeface.is_empty() {
                            fonts.push((format!("{font_prefix}lt"), typeface));
                        }
                    }
                }
                b"ea" if in_fonts => {
                    if let Some(typeface) = attr(&element, b"typeface") {
                        if !typeface.is_empty() {
                            fonts.push((format!("{font_prefix}ea"), typeface));
                        }
                    }
                }
                // A slot name is the element's own name, and its colour is the child it holds.
                name if in_colours => {
                    pending_slot = Some(String::from_utf8_lossy(name).to_string());
                }
                _ => {}
            },
            Ok(Event::End(element)) => match local(element.name()) {
                b"clrScheme" => in_colours = false,
                b"fontScheme" => in_fonts = false,
                b"majorFont" | b"minorFont" => font_prefix.clear(),
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    Theme::from_parts(slots, [], fonts)
}

/// One level of text style, as the levels above it leave it.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct RunStyle {
    /// Point size.
    pub(crate) size: Option<f32>,
    pub(crate) bold: Option<bool>,
    pub(crate) italic: Option<bool>,
    /// A colour as the file states it: a literal `#rrggbb`, or a theme role to resolve later.
    pub(crate) color: Option<String>,
    /// A typeface, which may itself be a theme slot such as `+mj-lt`.
    pub(crate) font: Option<String>,
}

impl RunStyle {
    /// This style over a wider one: what it states wins, what it leaves unsaid is inherited.
    pub(crate) fn over(&self, wider: RunStyle) -> RunStyle {
        RunStyle {
            size: self.size.or(wider.size),
            bold: self.bold.or(wider.bold),
            italic: self.italic.or(wider.italic),
            color: self.color.clone().or(wider.color),
            font: self.font.clone().or(wider.font),
        }
    }
}

/// `a:lvl1pPr` to `a:lvl9pPr`, by level.
#[derive(Debug, Default, Clone)]
pub(crate) struct LevelStyles {
    levels: Vec<RunStyle>,
}

impl LevelStyles {
    /// The style at a level, falling back to the nearest level below it that states one.
    pub(crate) fn at(&self, level: usize) -> RunStyle {
        if let Some(style) = self.levels.get(level) {
            return style.clone();
        }
        // A list that stops at level 3 still answers for level 5 with what level 3 said.
        self.levels.last().cloned().unwrap_or_default()
    }

    /// This list over a wider one, level by level.
    ///
    /// Used by the test that pins a shape's own list style against the master's; the reader itself
    /// merges level by level as it walks each paragraph.
    #[cfg(test)]
    pub(crate) fn over(&self, wider: LevelStyles) -> LevelStyles {
        let length = self.levels.len().max(wider.levels.len());
        let levels = (0..length)
            .map(|level| self.at(level).over(wider.at(level)))
            .collect();
        LevelStyles { levels }
    }

    fn push(&mut self, level: usize, style: RunStyle) {
        while self.levels.len() <= level {
            self.levels.push(RunStyle::default());
        }
        self.levels[level] = style;
    }

    /// Records one level, which is how a shape's own `a:lstStyle` is built while the slide is read.
    pub(crate) fn set(&mut self, level: usize, style: RunStyle) {
        self.push(level, style);
    }
}

/// Which list of a master a set of levels belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum List {
    Title,
    Body,
    Other,
}

/// A master's three lists of text styles.
#[derive(Debug, Default, Clone)]
pub(crate) struct MasterStyles {
    title: LevelStyles,
    body: LevelStyles,
    other: LevelStyles,
}

impl MasterStyles {
    /// The style a shape takes from the master, by what its placeholder is and how deep its
    /// paragraph sits.
    ///
    /// A box with no placeholder is an ordinary text box, and a master's `otherStyle` is what
    /// says how one is set.
    pub(crate) fn for_placeholder(&self, placeholder: Option<&str>, level: usize) -> RunStyle {
        let list = match placeholder {
            Some("title") | Some("ctrTitle") => &self.title,
            Some("body") | Some("subTitle") => &self.body,
            Some(_) => &self.other,
            None => &self.other,
        };
        list.at(level)
    }
}

/// A master's `p:txStyles`, read as its three lists.
pub(crate) fn read_master_styles(xml: &str) -> MasterStyles {
    let mut styles = MasterStyles::default();
    for (kind, levels) in read_level_lists(xml) {
        match kind {
            List::Title => styles.title = levels,
            List::Body => styles.body = levels,
            List::Other => styles.other = levels,
        }
    }
    styles
}

/// A shape's own `a:lstStyle`, when it states one.
///
/// The reader itself collects a shape's levels as it walks the slide, so this is the same reader
/// applied to a whole part, which is what the tests use to pin the two paths together.
#[cfg(test)]
pub(crate) fn read_list_style(xml: &str) -> Option<LevelStyles> {
    read_level_lists(xml).into_iter().next().map(|(_, levels)| levels)
}

/// The `a:lvlNpPr` lists a part holds, and which of a master's three they are.
///
/// A master wraps each list in `p:titleStyle`, `p:bodyStyle` or `p:otherStyle`; a shape wraps its
/// one list in `a:lstStyle`. Both are read here so the two levels of inheritance cannot drift
/// apart.
fn read_level_lists(xml: &str) -> Vec<(List, LevelStyles)> {
    let mut out: Vec<(List, LevelStyles)> = Vec::new();
    let mut current: Option<List> = None;
    let mut levels = LevelStyles::default();
    let mut level: Option<usize> = None;
    let mut style = RunStyle::default();
    let mut in_run_props = false;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                match local(element.name()) {
                    b"titleStyle" => {
                        current = Some(List::Title);
                        levels = LevelStyles::default();
                    }
                    b"bodyStyle" => {
                        current = Some(List::Body);
                        levels = LevelStyles::default();
                    }
                    b"otherStyle" => {
                        current = Some(List::Other);
                        levels = LevelStyles::default();
                    }
                    b"lstStyle" => {
                        current = Some(List::Other);
                        levels = LevelStyles::default();
                    }
                    b"defRPr" => {
                        in_run_props = true;
                        if let Some(size) = attr_number::<f32>(&element, b"sz") {
                            style.size = Some(size / 100.0);
                        }
                        if let Some(bold) = flag(&element, b"b") {
                            style.bold = Some(bold);
                        }
                        if let Some(italic) = flag(&element, b"i") {
                            style.italic = Some(italic);
                        }
                    }
                    b"latin" if in_run_props => {
                        if let Some(typeface) = attr(&element, b"typeface") {
                            style.font = Some(typeface);
                        }
                    }
                    b"srgbClr" if in_run_props => {
                        style.color = attr(&element, b"val").and_then(|value| srgb_color(&value));
                    }
                    // A role is kept as written, because the map that turns it into a slot lives
                    // on the master and is not known here.
                    b"schemeClr" if in_run_props => {
                        style.color = attr(&element, b"val");
                    }
                    name => {
                        let name = String::from_utf8_lossy(name).to_string();
                        if let Some(digit) =
                            name.strip_prefix("lvl").and_then(|rest| rest.strip_suffix("pPr"))
                        {
                            if let Ok(depth) = digit.parse::<usize>() {
                                level = Some(depth.saturating_sub(1));
                                style = RunStyle::default();
                            }
                        }
                    }
                }
            }
            Ok(Event::End(element)) => match local(element.name()) {
                b"defRPr" => in_run_props = false,
                // A list ends with its own wrapper; each of a master's three is kept apart, and
                // one shared accumulator would let the last list overwrite the two before it.
                b"titleStyle" | b"bodyStyle" | b"otherStyle" | b"lstStyle" => {
                    if let Some(kind) = current.take() {
                        out.push((kind, std::mem::take(&mut levels)));
                    }
                }
                name => {
                    let name = String::from_utf8_lossy(name).to_string();
                    if name.starts_with("lvl") && name.ends_with("pPr") {
                        if let Some(depth) = level.take() {
                            levels.push(depth, style.clone());
                            style = RunStyle::default();
                        }
                    }
                }
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    // A part cut off before its wrapper closed still contributes what it read.
    if let Some(kind) = current {
        out.push((kind, levels));
    }
    out
}

/// The colour a `p:bg` fills the slide with, or nothing when it names none this reader understands.
///
/// Two forms exist: `<p:bgPr>` with a solid fill, and `<p:bgRef>` pointing into the theme's own
/// fill list. The first is read; the second is not, and answers nothing so the caller falls back.
pub(crate) fn read_background(xml: &str, theme: &Theme) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // A `bgRef` means the fill comes from a list this reader does not read.
    let mut by_reference = false;
    let mut in_background = false;
    let mut depth = 0usize;
    let mut colour: Option<String> = None;
    let mut role: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                let tag = local(element.name()).to_vec();
                if tag == b"bg" {
                    in_background = true;
                    depth = 0;
                }
                if !in_background {
                    continue;
                }
                match tag.as_slice() {
                    b"bgRef" => by_reference = true,
                    b"srgbClr" => {
                        colour = attr(&element, b"val").and_then(|value| srgb_color(&value));
                    }
                    b"schemeClr" => role = attr(&element, b"val"),
                    _ => {}
                }
            }
            Ok(Event::End(element)) => {
                if local(element.name()) == b"bg" && in_background {
                    in_background = false;
                }
                depth = depth.saturating_sub(1);
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let _ = depth;
    if by_reference {
        return None;
    }
    match (colour, role) {
        (Some(colour), _) => Some(colour),
        (None, Some(role)) => theme.slot(&role).cloned(),
        _ => None,
    }
}

/// The box a placeholder sits in, in the pixels of the slide's own coordinate space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PlaceholderBox {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

impl PlaceholderBox {
    /// Whether the box has any area to draw in, which a box of zeroes does not.
    pub(crate) fn is_empty(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }
}

/// The picture a `p:bg` fills the slide with, named by the relationship it points at.
///
/// A slide whose paper is a photograph states it as `<p:bgPr><a:blipFill><a:blip r:embed="rIdN"/>`.
/// The relationship is the slide's own, so resolving it is the caller's job; this only says which
/// one the background names, and answers nothing for a paper that is a colour.
pub(crate) fn read_background_picture(xml: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut in_background = false;
    let mut in_picture = false;
    let mut embed: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                match local(element.name()) {
                    b"bg" => in_background = true,
                    b"blipFill" if in_background => in_picture = true,
                    // `r:embed` is the picture's own name for the relationship.
                    b"blip" if in_picture => embed = attr(&element, b"embed").or(embed.take()),
                    _ => {}
                }
            }
            Ok(Event::End(element)) => match local(element.name()) {
                b"blipFill" => in_picture = false,
                b"bg" => in_background = false,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    embed
}

/// The boxes a layout or a master gives its placeholders, by the key a slide addresses them with.
///
/// A slide's placeholder states its own `<a:xfrm>` when the author moved it, and nothing at all when
/// the box is the one the layout or the master puts it in. Matching is by `idx` first and by `type`
/// when the slide names no index, which is how PowerPoint finds the counterpart.
pub(crate) fn read_placeholder_boxes(
    xml: &str,
    what: &str,
) -> Result<HashMap<String, PlaceholderBox>, String> {
    let mut boxes: HashMap<String, PlaceholderBox> = HashMap::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    // The placeholder being read, and the box it states.
    let mut key: Option<String> = None;
    let mut inside_shape = false;
    let (mut x, mut y, mut width, mut height) = (None, None, None, None);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                match local(element.name()) {
                    b"sp" => {
                        inside_shape = true;
                        key = None;
                        (x, y, width, height) = (None, None, None, None);
                    }
                    // `p:ph` is written self closed, so it arrives in this arm only.
                    b"ph" if inside_shape => {
                        let index = attr(&element, b"idx");
                        let kind = attr(&element, b"type").unwrap_or_else(|| "body".to_string());
                        key = Some(index.unwrap_or(kind));
                    }
                    b"off" if inside_shape => {
                        x = attr_number::<f64>(&element, b"x").map(emu_to_px);
                        y = attr_number::<f64>(&element, b"y").map(emu_to_px);
                    }
                    b"ext" if inside_shape => {
                        width = attr_number::<f64>(&element, b"cx").map(emu_to_px);
                        height = attr_number::<f64>(&element, b"cy").map(emu_to_px);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(element)) => {
                if local(element.name()) == b"sp" && inside_shape {
                    inside_shape = false;
                    if let (Some(key), Some(x), Some(y), Some(width), Some(height)) =
                        (key.take(), x, y, width, height)
                    {
                        boxes.insert(
                            key,
                            PlaceholderBox {
                                x,
                                y,
                                width,
                                height,
                            },
                        );
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return Err(format!("{what} 的形状树读不下去")),
            _ => {}
        }
    }
    Ok(boxes)
}


#[cfg(test)]
mod tests {
    use super::*;

    const THEME: &str = r#"<?xml version="1.0"?>
<a:theme xmlns:a="a" name="Office">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/></a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>"#;

    const MASTER: &str = r#"<?xml version="1.0"?>
<p:sldMaster xmlns:p="p" xmlns:a="a">
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>
  <p:txStyles>
    <p:titleStyle>
      <a:lvl1pPr><a:defRPr sz="3600" b="1"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr>
      <a:lvl2pPr><a:defRPr sz="3200"/></a:lvl2pPr>
    </p:titleStyle>
    <p:bodyStyle>
      <a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr>
    </p:bodyStyle>
    <p:otherStyle>
      <a:lvl1pPr><a:defRPr sz="1400"/></a:lvl1pPr>
    </p:otherStyle>
  </p:txStyles>
</p:sldMaster>"#;

    #[test]
    fn the_theme_answers_with_its_slots_and_a_system_colour_falls_back_to_the_one_it_names() {
        let theme = read_theme(THEME);
        assert_eq!(theme.slot("dk1"), Some(&"#000000".to_string()));
        assert_eq!(theme.slot("lt1"), Some(&"#ffffff".to_string()));
        assert_eq!(theme.slot("accent1"), Some(&"#4472c4".to_string()));
    }

    #[test]
    fn the_font_scheme_answers_for_the_slots_a_run_names() {
        let theme = read_theme(THEME);
        assert_eq!(theme.font("+mj-lt"), Some(&"Calibri Light".to_string()));
        assert_eq!(theme.font("+mn-lt"), Some(&"Calibri".to_string()));
        // An empty typeface is the file saying nothing, not a font called "".
        assert_eq!(theme.font("+mj-ea"), None);
    }

    #[test]
    fn the_map_turns_the_roles_a_slide_names_into_the_slots_the_theme_has() {
        let map = read_clr_map(MASTER);
        let theme = read_theme(THEME).with_roles(map);
        assert_eq!(theme.slot("tx1"), Some(&"#000000".to_string()));
        assert_eq!(theme.slot("bg1"), Some(&"#ffffff".to_string()));
        assert_eq!(theme.slot("tx2"), Some(&"#44546a".to_string()));
    }

    #[test]
    fn a_master_with_no_map_still_answers_the_default_roles() {
        // `bg1`/`tx1` default to `lt1`/`dk1`, which is the pair every deck relies on.
        let theme = read_theme(THEME).with_roles(read_clr_map("<p:sldMaster xmlns:p='p'/>"));
        assert_eq!(theme.slot("tx1"), Some(&"#000000".to_string()));
        assert_eq!(theme.slot("bg1"), Some(&"#ffffff".to_string()));
    }

    #[test]
    fn a_title_placeholder_takes_the_master_s_title_style() {
        // The master says 36pt bold in the text colour; without this every title was 18pt regular.
        let styles = read_master_styles(MASTER);
        let style = styles.for_placeholder(Some("title"), 0);
        assert_eq!(style.size, Some(36.0));
        assert_eq!(style.bold, Some(true));
        assert_eq!(style.color, Some("tx2".to_string()));
        assert_eq!(style.font, Some("+mj-lt".to_string()));
    }

    #[test]
    fn a_body_placeholder_takes_the_body_style_and_a_plain_box_the_other_style() {
        let styles = read_master_styles(MASTER);
        assert_eq!(styles.for_placeholder(Some("body"), 0).size, Some(18.0));
        assert_eq!(styles.for_placeholder(None, 0).size, Some(14.0));
        // The second level is its own size.
        assert_eq!(styles.for_placeholder(Some("title"), 1).size, Some(32.0));
    }

    #[test]
    fn a_shape_s_own_list_style_wins_over_the_master() {
        let shape =
            r#"<a:lstStyle><a:lvl1pPr><a:defRPr sz="2000" b="1"/></a:lvl1pPr></a:lstStyle>"#;
        let own = read_list_style(shape).unwrap();
        let styles = read_master_styles(MASTER);
        // The shape's list as a whole over the master's, then the level that paragraph sits at.
        let style = own.over(LevelStyles {
            levels: vec![styles.for_placeholder(None, 0)],
        });
        let style = style.at(0);
        assert_eq!(style.size, Some(20.0));
        assert_eq!(style.bold, Some(true));
    }

    #[test]
    fn a_background_is_the_colour_it_names_and_nothing_when_it_names_none() {
        let theme = read_theme(THEME).with_roles(read_clr_map(MASTER));
        let solid =
            r#"<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></p:bgPr></p:bg>"#;
        assert_eq!(read_background(solid, &theme), Some("#1f3864".to_string()));
        let named =
            r#"<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg>"#;
        assert_eq!(read_background(named, &theme), Some("#ffffff".to_string()));
        // A background that references the theme's fill list is not read this round.
        let by_ref =
            r#"<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>"#;
        assert_eq!(read_background(by_ref, &theme), None);
        assert_eq!(read_background("", &theme), None);
    }

    const LAYOUT: &str = r#"<?xml version="1.0"?>
<p:sldLayout xmlns:p="p" xmlns:a="a">
  <p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="9525" y="9525"/><a:ext cx="19050" cy="28575"/></a:xfrm></p:spPr></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="38100" y="47625"/><a:ext cx="57150" cy="95250"/></a:xfrm></p:spPr></p:sp>
    <p:pic><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9525" cy="9525"/></a:xfrm></p:spPr></p:pic>
  </p:spTree>
</p:sldLayout>"#;

    #[test]
    fn a_layout_s_placeholders_are_found_by_the_key_a_slide_addresses_them_with() {
        // A title has no index and is addressed by its type; a body placeholder carries `idx="1"`.
        let boxes = read_placeholder_boxes(LAYOUT, "布局").unwrap();
        assert_eq!(
            boxes.get("title"),
            Some(&PlaceholderBox {
                x: 1.0,
                y: 1.0,
                width: 2.0,
                height: 3.0
            })
        );
        assert_eq!(
            boxes.get("1"),
            Some(&PlaceholderBox {
                x: 4.0,
                y: 5.0,
                width: 6.0,
                height: 10.0
            })
        );
    }

    #[test]
    fn a_shape_that_is_not_a_placeholder_contributes_no_box() {
        // The picture in that layout states a transform but has no `p:ph`, so it answers for no
        // placeholder: reading it would give some slide a box that was meant for a picture.
        let boxes = read_placeholder_boxes(LAYOUT, "布局").unwrap();
        assert_eq!(boxes.len(), 2);
    }

    #[test]
    fn a_placeholder_with_no_transform_answers_nothing_rather_than_a_box_of_zeroes() {
        // A box of zeroes would be indistinguishable from a real one once the slide is drawn, and
        // the caller falls back to the next level when a key is missing.
        let xml = r#"<p:sldLayout xmlns:p="p" xmlns:a="a"><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:sldLayout>"#;
        let boxes = read_placeholder_boxes(xml, "布局").unwrap();
        assert!(boxes.is_empty());
    }

    #[test]
    fn a_background_that_is_a_picture_names_the_relationship_it_points_at() {
        // 38 of the 3857 slides measured here are drawn on a photograph, and the reader used to
        // answer nothing for them: the whole slide came out as white paper.
        let picture = r#"<p:bg><p:bgPr><a:blipFill rotWithShape="1"><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:bgPr></p:bg>"#;
        assert_eq!(read_background_picture(picture), Some("rId1".to_string()));
        // And such a background states no colour, so the two readers do not disagree.
        assert_eq!(read_background(picture, &Theme::default()), None);
    }

    #[test]
    fn a_background_that_is_a_colour_names_no_picture() {
        let solid =
            r#"<p:bg><p:bgPr><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></p:bgPr></p:bg>"#;
        assert_eq!(read_background_picture(solid), None);
        assert_eq!(read_background_picture(""), None);
    }
}
