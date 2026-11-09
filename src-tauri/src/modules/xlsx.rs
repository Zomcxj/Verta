//! Spreadsheets, read as a grid.
//!
//! An `.xlsx` is a ZIP of XML, and there is no spreadsheet in the webview to hand it to: without a
//! reader the editor could only say "binary file", which is what it used to say about every
//! workbook. This reads the parts that decide what is on the screen - the sheet list, the strings
//! they refer to by index, the styles that say how each cell is drawn, and the cells themselves -
//! and hands the frontend a grid of already-formatted strings.
//!
//! What this deliberately does not do: write anything, formulas beyond the value the file last
//! cached, charts, pivot tables, data bars and icon sets, or the old `.xls` format (a different
//! container, OLE2 rather than ZIP). A cell's number format is applied here rather than in the
//! frontend, so the drawing rules live in one place with their tests.

use std::collections::HashMap;
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::Serialize;
use tauri::Manager;

use super::fs::blocking;
use super::office::{
    attr, flag, local, reference_of, relationship_target, text_of, toggled, Archive,
};
use super::workspace::{authorize_read, resolve_path, WorkspaceEnv, WorkspaceRegistry};

/// Any one part, inflated. A sheet of a real workbook is a few hundred kilobytes of XML; this is
/// what a mislabeled file, or an archive built to expand, runs into.
const MAX_PART_BYTES: u64 = 16 * 1024 * 1024;
/// `styles.xml` and `sharedStrings.xml` are lookups; a generated workbook can still make them large.
const MAX_STYLES_BYTES: u64 = 8 * 1024 * 1024;
/// Sheets the pane is willing to list. A workbook with more is a database.
const MAX_SHEETS: usize = 50;
/// Cells the pane will draw out of one sheet. The grid is virtualized, but every cell still crosses
/// IPC inside one JSON document.
const MAX_CELLS: usize = 20_000;
/// The row count claimed by a sheet that names no usable dimension is capped at this: a sheet that
/// claims a million rows and holds three would otherwise size its scroller from the claim alone.
const MAX_CLAIMED_ROWS: u32 = 100_000;

/// One sheet as the workbook names it.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SheetInfo {
    pub name: String,
    /// Its position in the workbook, which is the order the tabs are drawn in.
    pub index: u32,
}

/// The sheet list. Read on its own so the pane can draw the tabs without reading any sheet.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XlsxWorkbook {
    pub sheets: Vec<SheetInfo>,
    /// Whether the workbook has more sheets than the pane lists.
    pub truncated: bool,
}

/// How a cell is drawn, shared between every cell that asks for it.
///
/// Deduplicated because a workbook has a handful of distinct cell styles and tens of thousands of
/// cells: sending the style with each cell would be most of the payload.
#[derive(Serialize, Debug, Default, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CellStyle {
    pub bold: bool,
    pub italic: bool,
    /// `left`, `center`, `right`; absent leaves it to the value's own kind.
    pub align: Option<String>,
    /// `#rrggbb`.
    pub color: Option<String>,
    /// `#rrggbb` behind the cell.
    pub fill: Option<String>,
    /// The format code the number was written with, when it is not `General`.
    pub number_format: Option<String>,
    pub wrap: bool,
}

/// What a cell holds, which decides how it sits in its column when nothing else says.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum CellKind {
    /// Right-aligned, and the only kind a number format applies to.
    Number,
    Text,
    Boolean,
    Error,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XlsxCell {
    /// Zero-based column, which is where the cell sits; a row is sparse and may skip columns.
    pub column: u32,
    /// What the cell reads as, already formatted.
    pub text: String,
    pub kind: CellKind,
    /// Index into the sheet's `styles`.
    pub style: u32,
    /// The value before formatting, when formatting changed it, so a date can still be read as the
    /// serial number it is stored as.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// Index into the sheet's `styles` of what a conditional rule paints here. It sits beside
    /// `style` rather than replacing it, so the cell's own formatting is still what a rule that
    /// states only a colour leaves alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conditional: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XlsxRow {
    /// Zero-based row, so a sheet with a gap does not draw the gap as empty rows.
    pub index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f32>,
    pub cells: Vec<XlsxCell>,
}

/// A merged region, as the top-left corner and how far it reaches.
#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    pub row: u32,
    pub column: u32,
    pub row_span: u32,
    pub column_span: u32,
}

/// A column's width or a row's height, in pixels, for the ones that state a value.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrackSize {
    pub index: u32,
    pub size: f32,
}

/// One sheet, ready to draw.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSheet {
    pub name: String,
    /// The rows that have anything in them, in order. A sheet's empty middle is not sent at all.
    pub rows: Vec<XlsxRow>,
    /// One past the last row and column that have anything, so the grid knows how big the table is
    /// without walking it.
    pub row_count: u32,
    pub columns: u32,
    pub merges: Vec<Merge>,
    pub column_sizes: Vec<TrackSize>,
    pub row_heights: Vec<TrackSize>,
    /// Rows and columns held in place while scrolling, from the sheet's frozen pane.
    pub frozen_rows: u32,
    pub frozen_columns: u32,
    /// The style table the cells index into.
    pub styles: Vec<CellStyle>,
    /// Whether the sheet was longer than the pane draws.
    pub truncated: bool,
}

/// The sheet list of a workbook.
#[tauri::command]
pub async fn fs_read_xlsx(
    app: tauri::AppHandle,
    path: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<XlsxWorkbook, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_read(&app.state::<WorkspaceRegistry>(), &target)?;
        read_workbook_sync(&target)
    })
    .await
}

/// One sheet of a workbook, by the name the workbook gives it.
///
/// Read on demand rather than with the workbook: fifty sheets read together is a JSON document of
/// tens of megabytes for the one sheet the user is looking at.
#[tauri::command]
pub async fn fs_read_xlsx_sheet(
    app: tauri::AppHandle,
    path: String,
    name: String,
    workspace: Option<WorkspaceEnv>,
) -> Result<XlsxSheet, String> {
    blocking(move || {
        let workspace = WorkspaceEnv::from_option(workspace);
        let target = resolve_path(&path, &workspace);
        authorize_read(&app.state::<WorkspaceRegistry>(), &target)?;
        read_sheet_sync(&target, &name)
    })
    .await
}

/// The sheet list, in the order the workbook writes it.
fn read_workbook_sync(path: &Path) -> Result<XlsxWorkbook, String> {
    let bytes = std::fs::read(path).map_err(|error| {
        log::debug!("fs_read_xlsx read({}) failed: {error}", path.display());
        error.to_string()
    })?;
    let archive = Archive::open(bytes, ".xlsx")?;
    let workbook = archive.required("xl/workbook.xml", MAX_PART_BYTES, ".xlsx")?;
    let all = sheet_names(&workbook);
    let truncated = all.len() > MAX_SHEETS;
    let sheets = all
        .into_iter()
        .take(MAX_SHEETS)
        .enumerate()
        .map(|(index, name)| SheetInfo {
            name,
            index: index as u32,
        })
        .collect();
    Ok(XlsxWorkbook { sheets, truncated })
}

/// One sheet's cells.
fn read_sheet_sync(path: &Path, name: &str) -> Result<XlsxSheet, String> {
    let bytes = std::fs::read(path).map_err(|error| {
        log::debug!("fs_read_xlsx_sheet read({}) failed: {error}", path.display());
        error.to_string()
    })?;
    let archive = Archive::open(bytes, ".xlsx")?;
    let workbook = archive.required("xl/workbook.xml", MAX_PART_BYTES, ".xlsx")?;
    let rels = archive
        .text("xl/_rels/workbook.xml.rels", MAX_PART_BYTES, ".xlsx")?
        .unwrap_or_default();
    let target = sheet_target(&workbook, &rels, name)?
        .ok_or_else(|| format!("工作簿里没有名为「{name}」的工作表"))?;
    let shared = archive
        .text("xl/sharedStrings.xml", MAX_PART_BYTES, ".xlsx")?
        .map(|xml| shared_strings(&xml))
        .unwrap_or_default();
    let theme = archive
        .text("xl/theme/theme1.xml", MAX_STYLES_BYTES, ".xlsx")?
        .map(|xml| theme_colors(&xml))
        .unwrap_or_default();
    let styles_xml = archive
        .text("xl/styles.xml", MAX_STYLES_BYTES, ".xlsx")?
        .unwrap_or_default();
    let styles = parse_styles(&styles_xml, &theme);
    let dxfs = super::xlsx_conditional::read_dxfs(&styles_xml, &theme);
    let sheet_xml = archive.required(&target, MAX_PART_BYTES, ".xlsx")?;
    parse_sheet(&sheet_xml, name, &shared, &styles, &dxfs, &theme)
}

/// The sheet names, in order, from `xl/workbook.xml`.
fn sheet_names(workbook_xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut reader = Reader::from_str(workbook_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if local(element.name()) == b"sheet" {
                    if let Some(name) = attr(&element, b"name") {
                        names.push(name);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    names
}

/// The part one named sheet lives in, resolved through the workbook's relationship table.
///
/// The sheet's own `r:id` names a relationship, and that relationship carries the path - a workbook
/// written by another tool puts the sheets anywhere it likes, so the path is never guessed from the
/// sheet's position.
fn sheet_target(workbook_xml: &str, rels_xml: &str, wanted: &str) -> Result<Option<String>, String> {
    let mut relationship_id = None;
    let mut reader = Reader::from_str(workbook_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                if local(element.name()) == b"sheet" && attr(&element, b"name").as_deref() == Some(wanted) {
                    relationship_id = attr(&element, b"id");
                    break;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let Some(relationship_id) = relationship_id else {
        return Ok(None);
    };
    // A relationship target is written relative to the part that names it, which is `xl/` here.
    Ok(relationship_target(rels_xml, &relationship_id, "xl"))
}

/// The shared string table, by index. A cell of type `s` holds an index into this.
fn shared_strings(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    let mut in_item = false;
    // `<rPh>` holds the phonetic reading of an East Asian string, which is not what the cell reads
    // as; its `<t>` has to be skipped rather than concatenated.
    let mut phonetic_depth = 0u32;
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = local(element.name()).to_vec();
                if name == b"si" {
                    in_item = true;
                    current = Some(String::new());
                } else if in_item && name == b"rPh" {
                    phonetic_depth += 1;
                }
            }
            Ok(Event::Text(text)) if in_item && phonetic_depth == 0 => {
                if let Some(item) = current.as_mut() {
                    item.push_str(&text_of(&text));
                }
            }
            Ok(Event::GeneralRef(reference)) if in_item && phonetic_depth == 0 => {
                if let Some(item) = current.as_mut() {
                    item.push_str(&reference_of(&reference));
                }
            }
            Ok(Event::End(element)) => {
                let name = local(element.name()).to_vec();
                if name == b"rPh" {
                    phonetic_depth = phonetic_depth.saturating_sub(1);
                } else if name == b"si" {
                    in_item = false;
                    out.push(current.take().unwrap_or_default());
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------

/// A style as the file states it, before it is reduced to what the pane draws.
#[derive(Debug, Default, Clone)]
struct StyleDef {
    bold: bool,
    italic: bool,
    align: Option<String>,
    color: Option<String>,
    fill: Option<String>,
    /// The number format code, already resolved from the builtin table or the custom list.
    number_format: Option<String>,
    wrap: bool,
}

/// The style table of a workbook. An `xf` of `cellXfs`, as the file writes it.
#[derive(Debug, Default, Clone)]
struct Xf {
    num_fmt: u32,
    font: u32,
    fill: u32,
    align: Option<String>,
    wrap: bool,
    apply_number: Option<bool>,
    apply_font: Option<bool>,
    apply_fill: Option<bool>,
    /// The named style this cell style derives from, into `cellStyleXfs`.
    parent: u32,
}

/// The style table of a workbook, reduced and deduplicated.
#[derive(Debug, Default)]
struct Styles {
    /// In `cellXfs` order: a cell's `s` attribute indexes this.
    cells: Vec<StyleDef>,
}

impl Styles {
    fn get(&self, index: u32) -> StyleDef {
        self.cells.get(index as usize).cloned().unwrap_or_default()
    }
}

/// The builtin number format codes, by id. Everything else is a custom `numFmt`.
fn builtin_format(id: u32) -> Option<&'static str> {
    Some(match id {
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "mm-dd-yy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yy h:mm",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        // 0 is `General`, which is the absence of a format.
        _ => return None,
    })
}

/// Which list the styles reader is inside, so `<font>` and `<xf>` mean what they mean in the part
/// they are in rather than what their tag name says on its own.
#[derive(PartialEq, Eq, Clone, Copy)]
enum Section {
    None,
    Fonts,
    Fills,
    CellXfs,
    StyleXfs,
}

/// `xl/styles.xml` reduced to the cell styles the sheet refers to.
fn parse_styles(xml: &str, theme: &[String]) -> Styles {
    let mut custom: HashMap<u32, String> = HashMap::new();
    let mut fonts: Vec<(bool, bool, Option<String>)> = Vec::new();
    let mut fills: Vec<Option<String>> = Vec::new();
    let mut cell_xfs: Vec<Xf> = Vec::new();
    let mut style_xfs: Vec<Xf> = Vec::new();

    let mut section = Section::None;
    let mut current_font: Option<(bool, bool, Option<String>)> = None;
    let mut in_fill_pattern = false;
    let mut current_fill: Option<String> = None;
    let mut current_xf: Option<Xf> = None;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = local(element.name()).to_vec();
                match name.as_slice() {
                    b"fonts" => {
                        section = Section::Fonts;
                        continue;
                    }
                    b"fills" => {
                        section = Section::Fills;
                        continue;
                    }
                    b"cellXfs" => {
                        section = Section::CellXfs;
                        continue;
                    }
                    b"cellStyleXfs" => {
                        section = Section::StyleXfs;
                        continue;
                    }
                    _ => {}
                }
                match (section, name.as_slice()) {
                    (Section::Fonts, b"font") => current_font = Some((false, false, None)),
                    (Section::Fonts, b"b") => {
                        if let Some(font) = current_font.as_mut() {
                            font.0 = toggled(&element);
                        }
                    }
                    (Section::Fonts, b"i") => {
                        if let Some(font) = current_font.as_mut() {
                            font.1 = toggled(&element);
                        }
                    }
                    (Section::Fonts, b"color") => {
                        if let Some(font) = current_font.as_mut() {
                            font.2 = color_of(&element, theme);
                        }
                    }
                    (Section::Fills, b"fill") => current_fill = None,
                    (Section::Fills, b"patternFill") => {
                        let kind = attr(&element, b"patternType").unwrap_or_default();
                        // `none`, and the `gray125` a default fill carries, are not fills.
                        in_fill_pattern = !matches!(kind.as_str(), "none" | "" | "gray125");
                    }
                    (Section::Fills, b"fgColor") if in_fill_pattern => {
                        current_fill = color_of(&element, theme);
                    }
                    (Section::CellXfs | Section::StyleXfs, b"xf") => {
                        current_xf = Some(read_xf(&element));
                    }
                    (Section::CellXfs | Section::StyleXfs, b"alignment") => {
                        read_alignment(&element, current_xf.as_mut());
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(element)) => {
                let name = local(element.name()).to_vec();
                match (section, name.as_slice()) {
                    (_, b"numFmt") => {
                        if let (Some(id), Some(code)) = (
                            attr(&element, b"numFmtId").and_then(|v| v.parse::<u32>().ok()),
                            attr(&element, b"formatCode"),
                        ) {
                            custom.insert(id, code);
                        }
                    }
                    (Section::Fonts, b"b") => {
                        if let Some(font) = current_font.as_mut() {
                            font.0 = toggled(&element);
                        }
                    }
                    (Section::Fonts, b"i") => {
                        if let Some(font) = current_font.as_mut() {
                            font.1 = toggled(&element);
                        }
                    }
                    (Section::Fonts, b"color") => {
                        if let Some(font) = current_font.as_mut() {
                            font.2 = color_of(&element, theme);
                        }
                    }
                    // An empty element is a complete one: `<font/>` is a font with nothing set,
                    // `<xf/>` is a format with nothing set, and neither has an `End` event to
                    // close it with.
                    (Section::Fonts, b"font") => fonts.push((false, false, None)),
                    (Section::Fills, b"fill") => fills.push(None),
                    (Section::Fills, b"fgColor") if in_fill_pattern => {
                        current_fill = color_of(&element, theme);
                    }
                    (Section::CellXfs | Section::StyleXfs, b"xf") => {
                        let xf = read_xf(&element);
                        if section == Section::CellXfs {
                            cell_xfs.push(xf);
                        } else {
                            style_xfs.push(xf);
                        }
                    }
                    (Section::CellXfs | Section::StyleXfs, b"alignment") => {
                        read_alignment(&element, current_xf.as_mut());
                    }
                    _ => {}
                }
            }
            Ok(Event::End(element)) => {
                let name = local(element.name()).to_vec();
                match name.as_slice() {
                    b"fonts" | b"fills" | b"cellXfs" | b"cellStyleXfs" => section = Section::None,
                    b"font" if section == Section::Fonts => {
                        if let Some(font) = current_font.take() {
                            fonts.push(font);
                        }
                    }
                    b"fill" if section == Section::Fills => fills.push(current_fill.take()),
                    b"patternFill" => in_fill_pattern = false,
                    b"xf" if section == Section::CellXfs || section == Section::StyleXfs => {
                        if let Some(xf) = current_xf.take() {
                            if section == Section::CellXfs {
                                cell_xfs.push(xf);
                            } else {
                                style_xfs.push(xf);
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }

    let cells = cell_xfs
        .iter()
        .map(|xf| {
            let parent = style_xfs.get(xf.parent as usize);
            // A cell inherits what it does not apply: `applyFont="0"` means "as the named style
            // says", and Excel writes the plain cells of a workbook that way.
            let inherits = |apply: Option<bool>| apply == Some(false);
            let font_id = if inherits(xf.apply_font) {
                parent.map(|p| p.font).unwrap_or(xf.font)
            } else {
                xf.font
            };
            let fill_id = if inherits(xf.apply_fill) {
                parent.map(|p| p.fill).unwrap_or(xf.fill)
            } else {
                xf.fill
            };
            let num_fmt = if inherits(xf.apply_number) {
                parent.map(|p| p.num_fmt).unwrap_or(xf.num_fmt)
            } else {
                xf.num_fmt
            };
            let font = fonts.get(font_id as usize).cloned().unwrap_or_default();
            let fill = fills
                .get(fill_id as usize)
                .cloned()
                .flatten()
                .or_else(|| parent.and_then(|p| fills.get(p.fill as usize).cloned().flatten()));
            StyleDef {
                bold: font.0,
                italic: font.1,
                color: font.2,
                fill,
                align: xf
                    .align
                    .clone()
                    .or_else(|| parent.and_then(|p| p.align.clone())),
                wrap: xf.wrap || parent.map(|p| p.wrap).unwrap_or(false),
                number_format: format_code(num_fmt, &custom),
            }
        })
        .collect();
    Styles { cells }
}

/// One `xf` of `cellXfs` or `cellStyleXfs`.
fn read_xf(element: &BytesStart<'_>) -> Xf {
    let number = |name: &[u8]| {
        attr(element, name)
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0)
    };
    Xf {
        num_fmt: number(b"numFmtId"),
        font: number(b"fontId"),
        fill: number(b"fillId"),
        parent: number(b"xfId"),
        apply_number: flag(element, b"applyNumberFormat"),
        apply_font: flag(element, b"applyFont"),
        apply_fill: flag(element, b"applyFill"),
        ..Default::default()
    }
}

/// An `alignment` child of an `xf`, which is where horizontal alignment and wrapping live.
fn read_alignment(element: &BytesStart<'_>, xf: Option<&mut Xf>) {
    let Some(xf) = xf else { return };
    if let Some(horizontal) = attr(element, b"horizontal") {
        xf.align = Some(horizontal);
    }
    if flag(element, b"wrapText") == Some(true) {
        xf.wrap = true;
    }
}

/// A number format code, from the custom list first and the builtin table second.
fn format_code(id: u32, custom: &HashMap<u32, String>) -> Option<String> {
    if let Some(code) = custom.get(&id) {
        let trimmed = code.trim();
        return (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    builtin_format(id).map(|code| code.to_string())
}

/// A colour attribute as `#rrggbb`, from the three ways a workbook states one.
pub(crate) fn color_of(element: &BytesStart<'_>, theme: &[String]) -> Option<String> {
    if let Some(rgb) = attr(element, b"rgb") {
        return from_argb(&rgb);
    }
    if let Some(indexed) = attr(element, b"indexed").and_then(|v| v.parse::<u32>().ok()) {
        return indexed_color(indexed);
    }
    if let Some(index) = attr(element, b"theme").and_then(|v| v.parse::<usize>().ok()) {
        return theme.get(index).cloned();
    }
    // `auto` is not a colour: it means "whatever the surface uses".
    None
}

/// `FFRRGGBB` (or `RRGGBB`) as `#rrggbb`, which is the same shape an `a:srgbClr` carries.
fn from_argb(value: &str) -> Option<String> {
    super::office::srgb_color(value)
}

/// The legacy 64 colour palette, for `indexed="n"`. Its first entries are the classic system
/// colours Excel still writes for a plain red or green fill.
fn indexed_color(index: u32) -> Option<String> {
    const PALETTE: [&str; 66] = [
        "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
        "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff",
        "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#c0c0c0", "#808080",
        "#9999ff", "#993366", "#ffffcc", "#ccffff", "#660066", "#ff8080", "#0066cc", "#ccccff",
        "#000080", "#ff00ff", "#ffff00", "#00ffff", "#800080", "#800000", "#008080", "#0000ff",
        "#00ccff", "#ccffff", "#ccffcc", "#ffff99", "#99ccff", "#ff99cc", "#cc99ff", "#ffcc99",
        "#3366ff", "#33cccc", "#99cc00", "#ffcc00", "#ff9900", "#ff6600", "#666699", "#969696",
        "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
        // 64 and 65 are the window foreground and background, which the pane supplies itself.
        "", "",
    ];
    PALETTE
        .get(index as usize)
        .filter(|colour| !colour.is_empty())
        .map(|colour| colour.to_string())
}

/// `xl/theme/theme1.xml`'s colour scheme, in the order `theme="n"` indexes it.
fn theme_colors(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut in_scheme = false;
    // One entry per scheme slot, pushed when the slot opens so a slot with nothing in it still
    // holds the index the file's numbers count from.
    let mut entry_depth = 0u32;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let name = local(element.name()).to_vec();
                if name == b"clrScheme" {
                    in_scheme = true;
                    entry_depth = 0;
                } else if in_scheme {
                    if entry_depth == 0 {
                        out.push(String::new());
                    }
                    entry_depth += 1;
                }
            }
            Ok(Event::Empty(element)) => {
                if in_scheme {
                    if entry_depth == 0 {
                        out.push(String::new());
                        entry_depth = 1;
                    }
                    if let Some(slot) = out.last_mut() {
                        if let Some(value) = scheme_colour(&element) {
                            *slot = value;
                        }
                    }
                }
            }
            Ok(Event::End(element)) => {
                let name = local(element.name()).to_vec();
                if name == b"clrScheme" {
                    in_scheme = false;
                } else if in_scheme && entry_depth > 0 {
                    entry_depth -= 1;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// The colour a scheme slot names, from its `srgbClr` or the `lastClr` of its `sysClr`.
fn scheme_colour(element: &BytesStart<'_>) -> Option<String> {
    match local(element.name()) {
        b"srgbClr" => attr(element, b"val").and_then(|value| from_argb(&value)),
        b"sysClr" => attr(element, b"lastClr").and_then(|value| from_argb(&value)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------------------------

/// One cell as it is being read.
#[derive(Debug, Default)]
struct PendingCell {
    column: u32,
    /// The `t` attribute, which says how to read `<v>`.
    kind: Option<String>,
    style: u32,
    /// The `<v>` value, or the index into the shared strings.
    value: String,
    /// An inline string's text, which `<is><t>` carries rather than an index.
    inline: String,
    in_inline: bool,
    /// Whether the text being read belongs to `<v>`. A `<f>` holds text of its own, and it is not
    /// the cell's value.
    in_value: bool,
}

/// A sheet's cells, as the pane will draw them.
fn parse_sheet(
    xml: &str,
    name: &str,
    shared: &[String],
    styles: &Styles,
    dxfs: &[CellStyle],
    theme: &[String],
) -> Result<XlsxSheet, String> {
    let mut rows: Vec<XlsxRow> = Vec::new();
    let mut merges: Vec<Merge> = Vec::new();
    // By column, not in the order they were written: a `<col>` run that overlaps an earlier one
    // overrides it, which is how a writer states a widened column after the sheet's default run.
    let mut column_sizes: HashMap<u32, f32> = HashMap::new();
    let mut row_heights: Vec<TrackSize> = Vec::new();
    let mut frozen_rows = 0u32;
    let mut frozen_columns = 0u32;
    let mut dimension: Option<(u32, u32)> = None;
    let mut truncated = false;
    let mut cells = 0usize;

    let mut row_index: Option<u32> = None;
    let mut row_height: Option<f32> = None;
    let mut current: Option<PendingCell> = None;
    let mut row_cells: Vec<XlsxCell> = Vec::new();
    let mut next_row = 0u32;
    let mut next_column = 0u32;
    // A `<col>` written with a start tag rather than on its own, which needs its run remembered
    // until it closes.
    let mut col_run: Option<(u32, u32, f32)> = None;
    // Nothing tells the reader that a part ended in the middle of a tree; counting the elements
    // still open at the end is what says the sheet was cut off rather than finished.
    let mut open_elements = 0u32;

    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                let tag = local(element.name()).to_vec();
                open_elements += 1;
                match tag.as_slice() {
                    b"row" => {
                        row_index = Some(
                            attr(&element, b"r")
                                .and_then(|value| value.parse::<u32>().ok())
                                .map(|value| value.saturating_sub(1))
                                .unwrap_or(next_row),
                        );
                        next_row = row_index.unwrap_or(next_row) + 1;
                        row_height = attr(&element, b"ht")
                            .and_then(|value| value.parse::<f32>().ok())
                            .map(points_to_px);
                        row_cells = Vec::new();
                        next_column = 0;
                    }
                    b"c" => {
                        let (cell, next) = start_cell(&element, next_column);
                        next_column = next;
                        current = Some(cell);
                    }
                    b"v" => {
                        if let Some(cell) = current.as_mut() {
                            cell.in_value = true;
                        }
                    }
                    b"is" => {
                        if let Some(cell) = current.as_mut() {
                            cell.in_inline = true;
                        }
                    }
                    b"col" => col_run = Some(col_run_of(&element)),
                    b"pane" => {
                        if let Some((rows, columns)) = frozen_pane(&element) {
                            frozen_rows = rows;
                            frozen_columns = columns;
                        }
                    }
                    b"dimension" => {
                        dimension = attr(&element, b"ref").and_then(|ref_| dimension_of(&ref_));
                    }
                    b"mergeCell" => {
                        if let Some(merge) = attr(&element, b"ref").as_deref().and_then(merge_of) {
                            merges.push(merge);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(element)) => {
                let tag = local(element.name()).to_vec();
                match tag.as_slice() {
                    b"c" => {
                        let (cell, next) = start_cell(&element, next_column);
                        next_column = next;
                        if cells < MAX_CELLS {
                            cells += 1;
                            row_cells.push(finish_cell(cell, shared, styles));
                        } else {
                            truncated = true;
                        }
                    }
                    b"col" => {
                        let (min, max, px) = col_run_of(&element);
                        push_columns(&mut column_sizes, min, max, px);
                    }
                    b"pane" => {
                        if let Some((rows, columns)) = frozen_pane(&element) {
                            frozen_rows = rows;
                            frozen_columns = columns;
                        }
                    }
                    b"dimension" => {
                        dimension = attr(&element, b"ref").and_then(|ref_| dimension_of(&ref_));
                    }
                    b"mergeCell" => {
                        if let Some(merge) = attr(&element, b"ref").as_deref().and_then(merge_of) {
                            merges.push(merge);
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(text)) => {
                if let Some(cell) = current.as_mut() {
                    let value = text_of(&text);
                    if cell.in_inline {
                        cell.inline.push_str(&value);
                    } else if cell.in_value {
                        cell.value.push_str(&value);
                    }
                }
            }
            Ok(Event::GeneralRef(reference)) => {
                if let Some(cell) = current.as_mut() {
                    let value = reference_of(&reference);
                    if cell.in_inline {
                        cell.inline.push_str(&value);
                    } else if cell.in_value {
                        cell.value.push_str(&value);
                    }
                }
            }
            Ok(Event::End(element)) => {
                let tag = local(element.name()).to_vec();
                open_elements = open_elements.saturating_sub(1);
                match tag.as_slice() {
                    b"c" => {
                        if let Some(cell) = current.take() {
                            if cells < MAX_CELLS {
                                cells += 1;
                                row_cells.push(finish_cell(cell, shared, styles));
                            } else {
                                truncated = true;
                            }
                        }
                    }
                    b"v" => {
                        if let Some(cell) = current.as_mut() {
                            cell.in_value = false;
                        }
                    }
                    b"is" => {
                        if let Some(cell) = current.as_mut() {
                            cell.in_inline = false;
                        }
                    }
                    b"col" => {
                        if let Some((min, max, px)) = col_run.take() {
                            push_columns(&mut column_sizes, min, max, px);
                        }
                    }
                    b"row" => {
                        let index = row_index.take().unwrap_or(0);
                        if !row_cells.is_empty() {
                            if let Some(height) = row_height {
                                row_heights.push(TrackSize { index, size: height });
                            }
                            rows.push(XlsxRow {
                                index,
                                height: row_height,
                                cells: std::mem::take(&mut row_cells),
                            });
                        }
                        row_height = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => {
                if open_elements > 0 {
                    truncated = true;
                }
                break;
            }
            Err(_) => {
                // A sheet cut off in the middle is not the sheet the file describes.
                truncated = true;
                break;
            }
            _ => {}
        }
    }

    // The dimension is a hint and the rows are the truth: a tool that leaves the dimension out
    // still wrote the cells, and a dimension that claims more than the rows reach is what sizes the
    // grid so its scroller matches the file.
    let (mut row_count, mut columns) = dimension.unwrap_or((0, 0));
    for row in &rows {
        row_count = row_count.max(row.index + 1);
        for cell in &row.cells {
            columns = columns.max(cell.column + 1);
        }
    }
    for merge in &merges {
        row_count = row_count.max(merge.row + merge.row_span);
        columns = columns.max(merge.column + merge.column_span);
    }
    row_count = row_count.min(MAX_CLAIMED_ROWS);
    let mut column_sizes: Vec<TrackSize> = column_sizes
        .into_iter()
        .map(|(index, size)| TrackSize { index, size })
        .collect();
    column_sizes.sort_by_key(|column| column.index);
    let mut style_table = used_styles(&mut rows, styles);
    // A rule is only worth reading in a sheet that states one, and walking the part a second time
    // is not: the check is a substring of the sheet the reader has already parsed.
    if xml.contains("<conditionalFormatting") {
        let rules = super::xlsx_conditional::read_rules(xml, dxfs, theme);
        super::xlsx_conditional::apply(&rules, &mut rows, &mut style_table);
    }
    Ok(XlsxSheet {
        name: name.to_string(),
        rows,
        row_count,
        columns,
        merges,
        column_sizes,
        row_heights,
        frozen_rows,
        frozen_columns,
        styles: style_table,
        truncated,
    })
}

/// A `<c>` start tag as a cell being read, and the column the next unreferenced cell would take.
fn start_cell(element: &BytesStart<'_>, next_column: u32) -> (PendingCell, u32) {
    let column = attr(element, b"r")
        .and_then(|value| column_of(&value))
        .unwrap_or(next_column);
    let cell = PendingCell {
        column,
        kind: attr(element, b"t"),
        style: attr(element, b"s")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0),
        ..Default::default()
    };
    (cell, column + 1)
}

/// A `<col>` element's span and width: the first and last columns it covers, and its pixels.
fn col_run_of(element: &BytesStart<'_>) -> (u32, u32, f32) {
    let min = attr(element, b"min")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(1);
    let max = attr(element, b"max")
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(min);
    let hidden = flag(element, b"hidden") == Some(true);
    let width = attr(element, b"width")
        .and_then(|value| value.parse::<f32>().ok())
        .unwrap_or(0.0);
    (min, max, if hidden { 0.0 } else { character_width_to_px(width) })
}

/// The columns a `<col>` run covers, zero-based. A run wider than the sheet has columns is bounded
/// by the cap the grid itself uses, because a run may claim a million of them.
fn push_columns(sizes: &mut HashMap<u32, f32>, min: u32, max: u32, px: f32) {
    let last = max.min(min.saturating_add(16_384));
    for index in min.saturating_sub(1)..last {
        sizes.insert(index, px);
    }
}

/// The frozen rows and columns of a `<pane>`, when it is a frozen one.
fn frozen_pane(element: &BytesStart<'_>) -> Option<(u32, u32)> {
    if attr(element, b"state").as_deref() != Some("frozen") {
        return None;
    }
    let count = |name: &[u8]| {
        attr(element, name)
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.0)
            .floor() as u32
    };
    Some((count(b"ySplit"), count(b"xSplit")))
}

/// The styles the sheet's cells actually use, renumbered to a table of only those.
///
/// A workbook's `cellXfs` can hold hundreds of entries that no cell in this sheet refers to; the
/// cells are renumbered so the sheet carries the handful it draws.
fn used_styles(rows: &mut [XlsxRow], styles: &Styles) -> Vec<CellStyle> {
    let mut table: Vec<CellStyle> = Vec::new();
    let mut seen: HashMap<u32, u32> = HashMap::new();
    for row in rows.iter_mut() {
        for cell in row.cells.iter_mut() {
            let index = *seen.entry(cell.style).or_insert_with(|| {
                let def = styles.get(cell.style);
                table.push(CellStyle {
                    bold: def.bold,
                    italic: def.italic,
                    align: def.align.clone(),
                    color: def.color.clone(),
                    fill: def.fill.clone(),
                    number_format: def.number_format.clone(),
                    wrap: def.wrap,
                });
                (table.len() - 1) as u32
            });
            cell.style = index;
        }
    }
    table
}

/// One cell as the pane will draw it.
fn finish_cell(cell: PendingCell, shared: &[String], styles: &Styles) -> XlsxCell {
    let def = styles.get(cell.style);
    let (text, kind, raw) = match cell.kind.as_deref() {
        Some("s") => {
            let index = cell.value.trim().parse::<usize>().unwrap_or(usize::MAX);
            (shared.get(index).cloned().unwrap_or_default(), CellKind::Text, None)
        }
        Some("inlineStr") => (cell.inline.clone(), CellKind::Text, None),
        // `str` is a formula whose cached result is text rather than a number.
        Some("str") => (cell.value.clone(), CellKind::Text, None),
        Some("b") => (
            if cell.value.trim() == "1" { "TRUE" } else { "FALSE" }.to_string(),
            CellKind::Boolean,
            None,
        ),
        Some("e") => (cell.value.trim().to_string(), CellKind::Error, None),
        // An ISO 8601 timestamp, which is what `t="d"` means; it reads as the date it says.
        Some("d") => (cell.value.trim().to_string(), CellKind::Text, None),
        _ => {
            let trimmed = cell.value.trim();
            if trimmed.is_empty() {
                // A cell with a format but no value is still a cell of a styled table.
                (String::new(), CellKind::Number, None)
            } else if let Ok(value) = trimmed.parse::<f64>() {
                let formatted = format_number(value, def.number_format.as_deref());
                let raw = (formatted != trimmed).then(|| trimmed.to_string());
                (formatted, CellKind::Number, raw)
            } else {
                // A `<v>` that is not a number is the tool's own text.
                (trimmed.to_string(), CellKind::Text, None)
            }
        }
    };
    XlsxCell {
        column: cell.column,
        text,
        kind,
        style: cell.style,
        raw,
        // A conditional rule paints the cell after the whole sheet is read, because a duplicate is
        // only a duplicate relative to the other cells.
        conditional: None,
    }
}

/// A column's width in Excel's character units as pixels.
fn character_width_to_px(width: f32) -> f32 {
    // Excel's own approximation for the default font: seven pixels a character, plus the padding a
    // cell carries.
    (width * 7.0 + 5.0).round()
}

/// A row height in points as pixels at 96 dpi.
fn points_to_px(points: f32) -> f32 {
    (points * 96.0 / 72.0).round()
}

/// A column reference as a zero-based column: `A` is 0, `AA` is 26.
fn column_of(reference: &str) -> Option<u32> {
    let mut column = 0u32;
    let mut letters = 0usize;
    for character in reference.chars() {
        if !character.is_ascii_alphabetic() {
            break;
        }
        column = column
            .checked_mul(26)?
            .checked_add((character.to_ascii_uppercase() as u32) - ('A' as u32) + 1)?;
        letters += 1;
    }
    (letters > 0).then(|| column - 1)
}

/// The row of a reference like `B12`, zero-based.
fn row_of(reference: &str) -> Option<u32> {
    let digits: String = reference
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect();
    digits.parse::<u32>().ok()?.checked_sub(1)
}

/// `A1:C3` as the row and column counts it covers, one past the last of each.
fn dimension_of(reference: &str) -> Option<(u32, u32)> {
    let end = reference.rsplit(':').next()?;
    Some((row_of(end)? + 1, column_of(end)? + 1))
}

/// `A1:B2` as a merge of the cells it covers.
fn merge_of(reference: &str) -> Option<Merge> {
    let (start, end) = reference.split_once(':')?;
    let start_column = column_of(start)?;
    let end_column = column_of(end)?;
    let start_row = row_of(start)?;
    let end_row = row_of(end)?;
    Some(Merge {
        row: start_row,
        column: start_column,
        row_span: end_row.saturating_sub(start_row) + 1,
        column_span: end_column.saturating_sub(start_column) + 1,
    })
}

// ---------------------------------------------------------------------------------------------
// Number formats
// ---------------------------------------------------------------------------------------------

/// A value as the format code says to write it.
///
/// This covers what a workbook actually uses: the builtin codes (plain, fixed decimals, thousands,
/// percent, the date and time shapes) and custom codes built out of the same pieces, including the
/// literal text they carry. Anything unrecognized falls back to the general form, which is what the
/// cell would read as with no format at all.
pub fn format_number(value: f64, code: Option<&str>) -> String {
    if !value.is_finite() {
        return String::new();
    }
    let Some(code) = code.map(str::trim).filter(|code| !code.is_empty()) else {
        return general(value);
    };
    if code.eq_ignore_ascii_case("general") || code == "@" {
        return general(value);
    }
    let sections = split_sections(code);
    // A number format has up to three numeric sections: positive, negative, zero. A fourth is the
    // one text takes, which is not reached here.
    let negative = value < 0.0;
    let section = if negative && sections.len() > 1 {
        sections[1].as_str()
    } else if value == 0.0 && sections.len() > 2 {
        sections[2].as_str()
    } else {
        sections.first().map(String::as_str).unwrap_or("General")
    };
    let tokens = tokenize(section);
    if is_date_format(&tokens) {
        return render_date(value, &tokens);
    }
    if tokens
        .iter()
        .any(|token| matches!(token, Token::Placeholder(_)))
    {
        let body = render_number(value.abs(), &tokens);
        // A negative value whose section says nothing about its sign takes a minus in front, unless
        // the format rounds it away: `-0` is not a number a spreadsheet shows.
        if negative && sections.len() < 2 && body.chars().any(|c| c.is_ascii_digit() && c != '0') {
            return format!("-{body}");
        }
        return body;
    }
    // A section with no digit position in it draws only the text it carries, which is what a
    // `"-"` zero section is for, and what an empty one draws nothing for.
    tokens
        .iter()
        .filter_map(|token| match token {
            Token::Literal(text) => Some(text.as_str()),
            Token::Percent => Some("%"),
            _ => None,
        })
        .collect()
}

/// The general form: what a cell reads as with no format at all.
fn general(value: f64) -> String {
    if !value.is_finite() {
        return String::new();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    let magnitude = value.abs();
    // Excel leaves the decimal form outside this range; so does this, because a serial number of
    // 4.5e15 written out is not a number anyone reads.
    if !(1e-4..1e11).contains(&magnitude) {
        return tidy_exponential(&format!("{value:.5e}"));
    }
    // Eleven significant digits is what Excel shows in a column that has not been widened.
    let digits = magnitude.log10().floor() as i32 + 1;
    let decimals = (11 - digits).clamp(0, 10) as usize;
    trim_trailing_zeros(&format!("{value:.decimals$}"))
}

/// A number with the zeros its rounding added taken off: `1.500` is `1.5`, `12.` is `12`.
fn trim_trailing_zeros(text: &str) -> String {
    if !text.contains('.') {
        return text.to_string();
    }
    let trimmed = text.trim_end_matches('0');
    trimmed.strip_suffix('.').unwrap_or(trimmed).to_string()
}

/// `1.23457e+15` as `1.23457E+15`: the mantissa trimmed, the exponent at least two digits.
fn tidy_exponential(text: &str) -> String {
    let Some((mantissa, exponent)) = text.split_once(['e', 'E']) else {
        return text.to_string();
    };
    let mantissa = trim_trailing_zeros(mantissa);
    let (sign, digits) = match exponent.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("+", exponent.trim_start_matches('+')),
    };
    format!("{mantissa}E{sign}{digits:0>2}")
}

/// A format code split into its sections, on `;` outside quotes and brackets.
fn split_sections(code: &str) -> Vec<String> {
    let mut sections = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut in_brackets = false;
    let mut escaped = false;
    for character in code.chars() {
        if escaped {
            current.push('\\');
            current.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => {
                in_quotes = !in_quotes;
                current.push(character);
            }
            '[' if !in_quotes => {
                in_brackets = true;
                current.push(character);
            }
            ']' if !in_quotes => {
                in_brackets = false;
                current.push(character);
            }
            ';' if !in_quotes && !in_brackets => sections.push(std::mem::take(&mut current)),
            _ => current.push(character),
        }
    }
    if escaped {
        current.push('\\');
    }
    sections.push(current);
    sections
}

/// One piece of a format code.
#[derive(Debug, PartialEq, Eq, Clone)]
enum Token {
    /// Text the format says to draw as it is.
    Literal(String),
    /// `0`, `#` or `?`: a digit position.
    Placeholder(char),
    Dot,
    /// A thousands separator, when it sits between digit positions.
    Group,
    Percent,
    /// A date or time letter, read with the tokens around it.
    Letter(char),
    /// `AM/PM` or `A/P`.
    AmPm,
    /// `[h]`, `[m]`, `[s]`: an elapsed span rather than a clock reading.
    Elapsed(char),
}

/// A format code as the pieces that are drawn, with the parts that only talk to Excel dropped.
fn tokenize(code: &str) -> Vec<Token> {
    let characters: Vec<char> = code.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    // Whether the next characters spell `want`, which is how `AM/PM` is told from a bare `A`.
    let spells = |at: usize, want: &str| {
        let mut probe = characters.iter().skip(at);
        want.chars().all(|expected| {
            probe
                .next()
                .is_some_and(|found| found.eq_ignore_ascii_case(&expected))
        })
    };
    while index < characters.len() {
        let character = characters[index];
        index += 1;
        match character {
            '"' => {
                let mut literal = String::new();
                while index < characters.len() {
                    let inner = characters[index];
                    index += 1;
                    if inner == '"' {
                        break;
                    }
                    literal.push(inner);
                }
                tokens.push(Token::Literal(literal));
            }
            '\\' => {
                if index < characters.len() {
                    tokens.push(Token::Literal(characters[index].to_string()));
                    index += 1;
                }
            }
            '_' => {
                // A width placeholder: a space where the next character would be.
                index += 1;
                tokens.push(Token::Literal(" ".to_string()));
            }
            '*' => {
                // A fill character, whose repeat count is the column's business.
                index += 1;
            }
            '[' => {
                let start = index;
                while index < characters.len() && characters[index] != ']' {
                    index += 1;
                }
                let inner: String = characters[start..index].iter().collect();
                index += 1;
                match inner.to_lowercase().as_str() {
                    "h" | "hh" => tokens.push(Token::Elapsed('h')),
                    "m" | "mm" => tokens.push(Token::Elapsed('m')),
                    "s" | "ss" => tokens.push(Token::Elapsed('s')),
                    _ => {
                        // `[Red]`, `[$-409]`, `[$￥-804]`, `[>=100]`: a colour, a locale block that
                        // carries a currency symbol, or a condition. The symbol is drawn.
                        if let Some(rest) = inner.strip_prefix('$') {
                            let symbol: String =
                                rest.chars().take_while(|c| *c != '-').collect();
                            if !symbol.is_empty() {
                                tokens.push(Token::Literal(symbol));
                            }
                        }
                    }
                }
            }
            '0' | '#' | '?' => tokens.push(Token::Placeholder(character)),
            '.' => tokens.push(Token::Dot),
            ',' => tokens.push(Token::Group),
            '%' => tokens.push(Token::Percent),
            'A' | 'a' if spells(index, "M/PM") || spells(index, "/P") => {
                let length = if spells(index, "M/PM") { 4 } else { 2 };
                index += length;
                tokens.push(Token::AmPm);
            }
            'y' | 'Y' | 'm' | 'M' | 'd' | 'D' | 'h' | 'H' | 's' | 'S' => {
                tokens.push(Token::Letter(character.to_ascii_lowercase()));
            }
            // The exponent of a scientific code. `e` is also a letter a custom code can carry as
            // literal text, and the two are told apart by what follows: `E+00` is not text.
            'e' | 'E' if spells(index, "+") || spells(index, "-") => {
                tokens.push(Token::Literal(character.to_ascii_uppercase().to_string()));
                tokens.push(Token::Literal(
                    characters[index].to_string(),
                ));
                index += 1;
            }
            other => tokens.push(Token::Literal(other.to_string())),
        }
    }
    tokens
}

/// Whether the code draws a date or a time rather than a number.
fn is_date_format(tokens: &[Token]) -> bool {
    tokens.iter().any(|token| match token {
        Token::Letter(letter) => matches!(letter, 'y' | 'd' | 'h' | 's' | 'm'),
        Token::AmPm => true,
        _ => false,
    })
}

/// The shape of a numeric format: the text around it, and how the digits are written.
struct NumericShape {
    prefix: String,
    suffix: String,
    decimals: usize,
    grouping: bool,
    minimum_integer: usize,
    /// How many digits a scientific code writes in its exponent.
    exponential: Option<usize>,
}

/// Reads the shape of a numeric format out of its tokens.
fn numeric_shape(tokens: &[Token]) -> NumericShape {
    // A scientific code is two numbers: the mantissa before its `E`, and the exponent after.
    let exponent_at = tokens.iter().position(
        |token| matches!(token, Token::Literal(text) if text.eq_ignore_ascii_case("E")),
    );
    let mantissa_end = exponent_at.unwrap_or(tokens.len());
    // `#` and `?` are positions a digit may go in, not digits the format insists on; only `0`
    // forces a place, which is why `#,##0` writes 3 as `3` and not as `003`.
    let first = tokens[..mantissa_end]
        .iter()
        .position(|token| matches!(token, Token::Placeholder(_)));
    let last = tokens[..mantissa_end]
        .iter()
        .rposition(|token| matches!(token, Token::Placeholder(_)));
    let (first, last) = match (first, last) {
        (Some(first), Some(last)) => (first, last),
        _ => (0, mantissa_end.saturating_sub(1)),
    };
    // Where the format's own trailing text starts: after the exponent's digits when there are any,
    // and after the mantissa's own when there are not.
    let suffix_start = match exponent_at {
        Some(_) => tokens[mantissa_end..]
            .iter()
            .rposition(|token| matches!(token, Token::Placeholder(_)))
            .map(|index| index + mantissa_end + 1)
            .unwrap_or(mantissa_end),
        None => last + 1,
    };

    let mut prefix = String::new();
    let mut suffix = String::new();
    let mut decimals = 0usize;
    let mut minimum_integer = 0usize;
    let mut grouping = false;
    let mut seen_dot = false;
    for (index, token) in tokens.iter().enumerate() {
        if index < first {
            match token {
                Token::Literal(text) => prefix.push_str(text),
                Token::Percent => prefix.push('%'),
                _ => {}
            }
        } else if index >= suffix_start {
            match token {
                Token::Literal(text) => suffix.push_str(text),
                Token::Percent => suffix.push('%'),
                _ => {}
            }
        } else if index <= last {
            match token {
                Token::Placeholder('0') => {
                    if seen_dot {
                        decimals += 1;
                    } else {
                        minimum_integer += 1;
                    }
                }
                Token::Placeholder(_) => {
                    if seen_dot {
                        decimals += 1;
                    }
                }
                Token::Dot => seen_dot = true,
                // A comma between digit positions groups them; one at the end of the number scales
                // by a thousand in Excel, which is not a separator and is not drawn.
                Token::Group if !seen_dot => grouping = true,
                _ => {}
            }
        }
    }
    let exponential = exponent_at.map(|_| {
        tokens[mantissa_end..]
            .iter()
            .filter(|token| matches!(token, Token::Placeholder(_)))
            .count()
            .max(1)
    });
    NumericShape {
        prefix,
        suffix,
        decimals,
        grouping,
        minimum_integer,
        exponential,
    }
}

/// A number as its format code writes it.
fn render_number(value: f64, tokens: &[Token]) -> String {
    let shape = numeric_shape(tokens);
    let scaled = if tokens.iter().any(|token| matches!(token, Token::Percent)) {
        value * 100.0
    } else {
        value
    };
    if let Some(exponent_digits) = shape.exponential {
        let text = format!("{:.*e}", shape.decimals, scaled);
        let mantissa = text.split(['e', 'E']).next().unwrap_or(&text).to_string();
        let exponent: i32 = text
            .split(['e', 'E'])
            .nth(1)
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        let sign = if exponent < 0 { '-' } else { '+' };
        return format!(
            "{}{mantissa}E{sign}{:0>width$}{}",
            shape.prefix,
            exponent.abs(),
            shape.suffix,
            width = exponent_digits
        );
    }
    let digits = format!("{:.*}", shape.decimals, round_half_away(scaled, shape.decimals));
    let (integer, fraction) = match digits.split_once('.') {
        Some((integer, fraction)) => (integer.to_string(), Some(fraction.to_string())),
        None => (digits, None),
    };
    let mut integer = integer;
    if shape.minimum_integer > 0 {
        while integer.chars().filter(char::is_ascii_digit).count() < shape.minimum_integer {
            integer.insert(0, '0');
        }
    }
    if shape.grouping {
        integer = group_digits(&integer);
    }
    let mut out = shape.prefix;
    out.push_str(&integer);
    if let Some(fraction) = fraction {
        out.push('.');
        out.push_str(&fraction);
    }
    out.push_str(&shape.suffix);
    out
}

/// Digits in groups of three, counted from the right.
fn group_digits(integer: &str) -> String {
    let digits: Vec<char> = integer.chars().collect();
    let mut out = String::new();
    for (index, character) in digits.iter().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*character);
    }
    out
}

/// A value rounded to `decimals` places the way a spreadsheet rounds it: half away from zero, which
/// is not the half-to-even rounding `format!` on its own would use.
fn round_half_away(value: f64, decimals: usize) -> f64 {
    let factor = 10f64.powi(decimals as i32);
    (value * factor).round() / factor
}

/// The month and day names a date format draws. English, as Excel's own default is.
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// A serial number as the date and time its format code draws.
fn render_date(value: f64, tokens: &[Token]) -> String {
    // Excel's own counting: day 1 is 1900-01-01, and the 1900 leap year it wrongly counts puts
    // every later serial one day ahead of a real calendar.
    let days = value.floor() as i64;
    let date_days = if days < 60 {
        days - 1
    } else {
        // 60 is the 1900-02-29 the file believes in and the calendar does not have.
        days - 2
    };
    let (year, month, day) = civil_from_days(date_days);
    // 1900-01-01 was a Monday, and the count here is days from that day.
    let weekday = (date_days + 1).rem_euclid(7) as usize;

    // The time of day is the fraction, rounded to the second, carried rather than truncated so a
    // value that rounds up to midnight moves the date with it.
    let total_seconds = (value * 86400.0).round() as i64;
    let seconds_of_day = total_seconds.rem_euclid(86400);
    let hours = seconds_of_day / 3600;
    let minutes = (seconds_of_day % 3600) / 60;
    let seconds = seconds_of_day % 60;
    let am_pm = tokens.iter().any(|token| matches!(token, Token::AmPm));

    let mut out = String::new();
    let mut index = 0usize;
    while index < tokens.len() {
        match &tokens[index] {
            // `[h]` counts the whole span rather than the hour of the day.
            Token::Elapsed(unit) => {
                let count = match unit {
                    'h' => value * 24.0,
                    'm' => value * 1440.0,
                    _ => value * 86400.0,
                };
                out.push_str(&(count.round() as i64).to_string());
                index += 1;
            }
            Token::AmPm => {
                out.push_str(if hours < 12 { "AM" } else { "PM" });
                index += 1;
            }
            Token::Literal(text) => {
                out.push_str(text);
                index += 1;
            }
            Token::Percent => {
                out.push('%');
                index += 1;
            }
            Token::Letter(letter) => {
                let letter = *letter;
                // The run's length is what decides `m` from `mmmm`.
                let mut run = 0usize;
                while index + run < tokens.len()
                    && matches!(tokens.get(index + run), Some(Token::Letter(next)) if *next == letter)
                {
                    run += 1;
                }
                // A single `m` is minutes next to an hour or a second, and the month otherwise. The
                // separators the format draws sit between them, so they are stepped over.
                let mut next_is_seconds = false;
                let mut at = index + run;
                while at < tokens.len() {
                    match &tokens[at] {
                        Token::Letter(other) => {
                            next_is_seconds = *other == 's';
                            break;
                        }
                        // `[s]` is a second count, so a `m` beside it is minutes too.
                        Token::Elapsed(unit) => {
                            next_is_seconds = *unit == 's';
                            break;
                        }
                        Token::Literal(_) | Token::Percent => at += 1,
                        _ => break,
                    }
                }
                let mut previous_is_hours = false;
                let mut at = index;
                while at > 0 {
                    at -= 1;
                    match &tokens[at] {
                        Token::Letter(other) => {
                            previous_is_hours = *other == 'h';
                            break;
                        }
                        Token::Elapsed(unit) => {
                            previous_is_hours = *unit == 'h';
                            break;
                        }
                        Token::Literal(_) | Token::Percent => {}
                        _ => break,
                    }
                }
                let month_name = MONTHS[(month.clamp(1, 12) - 1) as usize];
                let text = match letter {
                    'y' if run >= 3 => format!("{year:04}"),
                    'y' => format!("{:02}", year.rem_euclid(100)),
                    'm' if previous_is_hours || next_is_seconds => {
                        if run >= 2 {
                            format!("{minutes:02}")
                        } else {
                            minutes.to_string()
                        }
                    }
                    'm' => match run {
                        1 => month.to_string(),
                        2 => format!("{month:02}"),
                        3 => month_name[..3].to_string(),
                        4 => month_name.to_string(),
                        _ => month_name[..1].to_string(),
                    },
                    'd' => match run {
                        1 => day.to_string(),
                        2 => format!("{day:02}"),
                        3 => WEEKDAYS[weekday][..3].to_string(),
                        _ => WEEKDAYS[weekday].to_string(),
                    },
                    'h' => {
                        let hour = if am_pm {
                            let hour = hours % 12;
                            if hour == 0 { 12 } else { hour }
                        } else {
                            hours
                        };
                        if run >= 2 {
                            format!("{hour:02}")
                        } else {
                            hour.to_string()
                        }
                    }
                    // A second whose format asks for a fraction of one is not divided further here.
                    's' if run >= 2 => format!("{seconds:02}"),
                    's' => seconds.to_string(),
                    _ => String::new(),
                };
                out.push_str(&text);
                index += run;
            }
            _ => index += 1,
        }
    }
    out
}

/// A date from a count of days since 1900-01-01, as (year, month, day).
///
/// The count is shifted to the Unix epoch and converted there, which is the one conversion with a
/// derivation worth trusting rather than a table.
fn civil_from_days(days_since_1900: i64) -> (i32, u32, u32) {
    // 1900-01-01 is 25 567 days before 1970-01-01.
    let z = days_since_1900 - 25_567 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = y + i64::from(month <= 2);
    (year as i32, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    // -----------------------------------------------------------------------------------------
    // Fixtures: a workbook built in memory, so a test states the shape of the file it reads.
    // -----------------------------------------------------------------------------------------

    /// The bytes of a ZIP holding the parts given, in the order given.
    fn write_zip(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, content) in parts {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    fn workbook_xml(sheets: &[(&str, &str)]) -> String {
        let entries: String = sheets
            .iter()
            .enumerate()
            .map(|(index, (name, id))| {
                format!(
                    r#"<sheet name="{name}" sheetId="{}" r:id="{id}"/>"#,
                    index + 1
                )
            })
            .collect();
        format!(
            r#"<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>{entries}</sheets></workbook>"#
        )
    }

    fn rels_xml(rels: &[(&str, &str)]) -> String {
        let entries: String = rels
            .iter()
            .map(|(id, target)| {
                format!(
                    r#"<Relationship Id="{id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="{target}"/>"#
                )
            })
            .collect();
        format!(r#"<?xml version="1.0"?><Relationships>{entries}</Relationships>"#)
    }

    /// One cell of a fixture: its reference, its `t` attribute and its value.
    type TestCell<'a> = (Option<&'a str>, Option<&'a str>, &'a str);
    /// One row of a fixture: its `r` attribute and its cells.
    type TestRow<'a> = (Option<&'a str>, Vec<TestCell<'a>>);

    /// A sheet part holding the rows given, as `(reference, type, value)` cells per row.
    fn sheet_xml(rows: &[TestRow<'_>]) -> String {
        let mut body = String::new();
        for (row_ref, cells) in rows {
            let reference = row_ref.map(|r| format!(r#" r="{r}""#)).unwrap_or_default();
            body.push_str(&format!("<row{reference}>"));
            for (column_ref, kind, value) in cells {
                let reference = column_ref.map(|c| format!(r#" r="{c}""#)).unwrap_or_default();
                let kind = kind.map(|t| format!(r#" t="{t}""#)).unwrap_or_default();
                body.push_str(&format!("<c{reference}{kind}><v>{value}</v></c>"));
            }
            body.push_str("</row>");
        }
        format!(
            r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>"#
        )
    }

    /// The parts of a one-sheet workbook, the sheet and its lookups as given.
    fn book(
        sheet: &str,
        shared: Option<&str>,
        styles: Option<&str>,
        theme: Option<&str>,
        rels: Option<&str>,
    ) -> Vec<(&'static str, String)> {
        let mut parts: Vec<(&'static str, String)> = vec![
            ("xl/workbook.xml", workbook_xml(&[("S", "rId1")])),
            (
                "xl/_rels/workbook.xml.rels",
                rels
                    .map(str::to_string)
                    .unwrap_or_else(|| rels_xml(&[("rId1", "worksheets/sheet1.xml")])),
            ),
            ("xl/worksheets/sheet1.xml", sheet.to_string()),
        ];
        for (name, content) in [
            ("xl/sharedStrings.xml", shared),
            ("xl/styles.xml", styles),
            ("xl/theme/theme1.xml", theme),
        ] {
            if let Some(content) = content {
                parts.push((name, content.to_string()));
            }
        }
        parts
    }

    /// The parts as the borrows `write_zip` takes.
    fn borrow<'a>(parts: &'a [(&'static str, String)]) -> Vec<(&'a str, &'a str)> {
        parts
            .iter()
            .map(|(name, content)| (*name, content.as_str()))
            .collect()
    }

    /// A one-sheet workbook on disk, read back.
    fn read_book(parts: &[(&'static str, String)], tag: &str) -> XlsxSheet {
        let dir = std::env::temp_dir().join(format!("verta-xlsx-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("book.xlsx");
        std::fs::write(&file, write_zip(&borrow(parts))).unwrap();
        let sheet = read_sheet_sync(&file, "S").unwrap();
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
        sheet
    }

    // -----------------------------------------------------------------------------------------
    // What a conditional rule paints
    // -----------------------------------------------------------------------------------------

    /// A one-sheet workbook whose sheet carries a conditional rule, read back whole.
    fn read_book_with_rule(sheet: &str, styles: &str, tag: &str) -> XlsxSheet {
        let parts: Vec<(&'static str, String)> = vec![
            ("xl/workbook.xml", workbook_xml(&[("S", "rId1")])),
            (
                "xl/_rels/workbook.xml.rels",
                rels_xml(&[("rId1", "worksheets/sheet1.xml")]),
            ),
            ("xl/worksheets/sheet1.xml", sheet.to_string()),
            ("xl/styles.xml", styles.to_string()),
        ];
        read_book(&parts, tag)
    }

    const DUPES: &str = r#"<?xml version="1.0"?>
<styleSheet xmlns="s"><dxfs count="1"><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFFF9900"/></patternFill></fill></dxf></dxfs></styleSheet>"#;

    #[test]
    fn a_duplicate_rule_reaches_the_cells_it_marks() {
        // The rule a real journal list carries: highlight the names that appear twice. Reading the
        // rule but not the differential format it points at would paint nothing.
        let sheet = r#"<?xml version="1.0"?>
<worksheet xmlns="s"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>材料学报</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>机械工程</t></is></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>材料学报</t></is></c></row>
</sheetData>
<conditionalFormatting sqref="A1:A3"><cfRule type="duplicateValues" dxfId="0" priority="1"/></conditionalFormatting>
</worksheet>"#;
        let read = read_book_with_rule(sheet, DUPES, "cf-dupe");
        let painted: Vec<u32> = read
            .rows
            .iter()
            .flat_map(|row| row.cells.iter())
            .filter(|cell| cell.conditional.is_some())
            .map(|cell| cell.column)
            .collect();
        assert_eq!(painted, vec![0, 0]);
        let style = &read.styles[read.rows[0].cells[0].conditional.unwrap() as usize];
        assert_eq!(style.fill, Some("#ff9900".to_string()));
        // The cell that appears once is left alone.
        assert_eq!(read.rows[1].cells[0].conditional, None);
    }

    #[test]
    fn a_sheet_with_no_rule_sends_no_conditional_style() {
        let sheet = r#"<?xml version="1.0"?><worksheet xmlns="s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>"#;
        let read = read_book_with_rule(sheet, DUPES, "cf-none");
        assert_eq!(read.rows[0].cells[0].conditional, None);
    }

    // -----------------------------------------------------------------------------------------
    // References
    // -----------------------------------------------------------------------------------------

    #[test]
    fn a_column_reference_counts_past_z() {
        assert_eq!(column_of("A1"), Some(0));
        assert_eq!(column_of("B2"), Some(1));
        assert_eq!(column_of("Z9"), Some(25));
        assert_eq!(column_of("AA1"), Some(26));
        assert_eq!(column_of("AB100"), Some(27));
        assert_eq!(column_of("1"), None);
    }

    #[test]
    fn a_dimension_says_how_big_the_sheet_claims_to_be() {
        assert_eq!(dimension_of("A1:F20"), Some((20, 6)));
        assert_eq!(dimension_of("B3"), Some((3, 2)));
    }

    #[test]
    fn a_merge_is_its_corner_and_its_reach() {
        assert_eq!(
            merge_of("A1:B2"),
            Some(Merge {
                row: 0,
                column: 0,
                row_span: 2,
                column_span: 2
            })
        );
        assert_eq!(
            merge_of("C3:C5"),
            Some(Merge {
                row: 2,
                column: 2,
                row_span: 3,
                column_span: 1
            })
        );
    }

    // -----------------------------------------------------------------------------------------
    // The container
    // -----------------------------------------------------------------------------------------

    #[test]
    fn a_workbook_lists_its_sheets_in_order() {
        let dir = std::env::temp_dir().join(format!("verta-xlsx-list-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("list.xlsx");
        let bytes = write_zip(&[
            (
                "xl/workbook.xml",
                &workbook_xml(&[("January", "rId1"), ("二月", "rId2")]),
            ),
            ("xl/worksheets/sheet1.xml", &sheet_xml(&[])),
            ("xl/worksheets/sheet2.xml", &sheet_xml(&[])),
        ]);
        std::fs::write(&file, bytes).unwrap();
        let workbook = read_workbook_sync(&file).unwrap();
        assert_eq!(
            workbook.sheets,
            vec![
                SheetInfo {
                    name: "January".into(),
                    index: 0
                },
                SheetInfo {
                    name: "二月".into(),
                    index: 1
                },
            ]
        );
        assert!(!workbook.truncated);
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn a_sheet_is_found_through_its_relationship_not_its_position() {
        // The relationship of the second sheet points at the first part: a reader that guessed by
        // position would read the wrong sheet.
        assert_eq!(
            sheet_target(
                &workbook_xml(&[("first", "rId7"), ("second", "rId9")]),
                &rels_xml(&[
                    ("rId7", "worksheets/sheet2.xml"),
                    ("rId9", "worksheets/sheet1.xml")
                ]),
                "second"
            )
            .unwrap(),
            Some("xl/worksheets/sheet1.xml".to_string())
        );
        // An absolute target, and one written from the part's own folder.
        assert_eq!(
            relationship_target(&rels_xml(&[("rId1", "/xl/worksheets/sheet1.xml")]), "rId1", "xl"),
            Some("xl/worksheets/sheet1.xml".to_string())
        );
        assert_eq!(
            relationship_target(&rels_xml(&[("rId1", "./sheet3.xml")]), "rId1", "xl"),
            Some("xl/sheet3.xml".to_string())
        );
        assert_eq!(
            relationship_target(&rels_xml(&[("rId1", "../xl/sheet1.xml")]), "rId1", "xl"),
            Some("xl/sheet1.xml".to_string())
        );
    }

    #[test]
    fn a_sheet_read_through_a_relationship_that_moved_lands_in_the_right_place() {
        // The relationship names a part that is not where the name suggests.
        let parts = book(
            &sheet_xml(&[(None, vec![(Some("A1"), None, "7")])]),
            None,
            None,
            None,
            Some(&rels_xml(&[("rId1", "worksheets/elsewhere9.xml")])),
        );
        let dir = std::env::temp_dir().join(format!("verta-xlsx-rel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("rel.xlsx");
        let mut with_moved = parts.clone();
        with_moved.retain(|(name, _)| *name != "xl/worksheets/sheet1.xml");
        with_moved.push((
            "xl/worksheets/elsewhere9.xml",
            sheet_xml(&[(None, vec![(Some("A1"), None, "7")])]),
        ));
        std::fs::write(&file, write_zip(&borrow(&with_moved))).unwrap();
        let sheet = read_sheet_sync(&file, "S").unwrap();
        assert_eq!(sheet.rows[0].cells[0].text, "7");
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn a_sheet_that_is_not_in_the_workbook_is_refused() {
        let dir = std::env::temp_dir().join(format!("verta-xlsx-missing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("missing.xlsx");
        let bytes = write_zip(&[("xl/workbook.xml", &workbook_xml(&[("only", "rId1")]))]);
        std::fs::write(&file, bytes).unwrap();
        let error = read_sheet_sync(&file, "absent").unwrap_err();
        assert!(error.contains("absent"), "{error}");
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn a_file_that_is_not_a_zip_says_so() {
        let error = Archive::open(b"not a zip at all".to_vec(), ".xlsx").unwrap_err();
        assert!(error.contains(".xlsx"), "{error}");
    }

    #[test]
    fn an_entry_named_with_backslashes_is_still_found() {
        // A ZIP written by a Windows tool separates with backslashes and varies the case.
        let dir = std::env::temp_dir().join(format!("verta-xlsx-slash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("slashes.xlsx");
        let bytes = write_zip(&[
            (
                "XL\\Workbook.XML",
                &workbook_xml(&[("S", "rId1")]),
            ),
            ("xl/worksheets/sheet1.xml", &sheet_xml(&[])),
        ]);
        std::fs::write(&file, bytes).unwrap();
        assert_eq!(read_workbook_sync(&file).unwrap().sheets.len(), 1);
        std::fs::remove_file(&file).ok();
        std::fs::remove_dir(&dir).ok();
    }

    // -----------------------------------------------------------------------------------------
    // Cells
    // -----------------------------------------------------------------------------------------

    #[test]
    fn the_cell_types_read_as_what_they_hold() {
        let shared = r#"<sst><si><t>hello</t></si><si><r><t>rich </t></r><r><t>text</t></r></si><si><t>a &amp; b</t></si></sst>"#;
        let sheet = sheet_xml(&[(
            None,
            vec![
                (None, Some("s"), "0"),
                (None, Some("s"), "1"),
                (None, Some("s"), "2"),
                (None, Some("b"), "1"),
                (None, Some("b"), "0"),
                (None, Some("e"), "#DIV/0!"),
                (None, None, "42"),
                (None, Some("str"), "from a formula"),
            ],
        )]);
        let parts = book(&sheet, Some(shared), None, None, None);
        let read = read_book(&parts, "types");
        let cells = &read.rows[0].cells;
        assert_eq!(cells[0].text, "hello");
        assert_eq!(cells[0].kind, CellKind::Text);
        // Rich text runs concatenate; the cell reads as one string.
        assert_eq!(cells[1].text, "rich text");
        // An escaped ampersand comes back as one character, whichever event carried it.
        assert_eq!(cells[2].text, "a & b");
        assert_eq!(cells[3].text, "TRUE");
        assert_eq!(cells[3].kind, CellKind::Boolean);
        assert_eq!(cells[4].text, "FALSE");
        assert_eq!(cells[5].text, "#DIV/0!");
        assert_eq!(cells[5].kind, CellKind::Error);
        assert_eq!(cells[6].text, "42");
        assert_eq!(cells[6].kind, CellKind::Number);
        assert_eq!(cells[7].text, "from a formula");
        assert_eq!(read.columns, 8);
    }

    #[test]
    fn a_shared_string_index_that_is_not_there_is_empty_not_a_panic() {
        let sheet = sheet_xml(&[(None, vec![(None, Some("s"), "99")])]);
        let parts = book(&sheet, Some("<sst><si><t>only</t></si></sst>"), None, None, None);
        let read = read_book(&parts, "range");
        assert_eq!(read.rows[0].cells[0].text, "");
    }

    #[test]
    fn a_sparse_row_says_where_its_cells_are() {
        // Row 5 holds only column D: the row index and the column index are both the file's.
        let sheet = sheet_xml(&[(Some("5"), vec![(Some("D5"), None, "1")])]);
        let parts = book(&sheet, None, None, None, None);
        let read = read_book(&parts, "sparse");
        assert_eq!(read.rows.len(), 1);
        assert_eq!(read.rows[0].index, 4);
        assert_eq!(read.rows[0].cells[0].column, 3);
        assert_eq!(read.row_count, 5);
        assert_eq!(read.columns, 4);
    }

    #[test]
    fn a_gap_in_the_rows_does_not_become_empty_rows() {
        let sheet = sheet_xml(&[
            (Some("1"), vec![(None, None, "1")]),
            (Some("100"), vec![(None, None, "2")]),
        ]);
        let parts = book(&sheet, None, None, None, None);
        let read = read_book(&parts, "gap");
        assert_eq!(read.rows.len(), 2);
        assert_eq!(read.rows[1].index, 99);
        assert_eq!(read.row_count, 100);
    }

    #[test]
    fn cells_without_a_reference_are_read_in_order() {
        // Some writers leave `r` off every cell; the position is then the only thing that says
        // where a cell is, and the last one looked at has to decide the next one's answer.
        let sheet = sheet_xml(&[(
            None,
            vec![(None, None, "1"), (None, None, "2"), (None, None, "3")],
        )]);
        let parts = book(&sheet, None, None, None, None);
        let read = read_book(&parts, "noref");
        let columns: Vec<u32> = read.rows[0].cells.iter().map(|cell| cell.column).collect();
        assert_eq!(columns, vec![0, 1, 2]);
    }

    #[test]
    fn a_formula_contributes_its_cached_value_and_not_its_text() {
        let sheet = r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>30</v></c></row></sheetData></worksheet>"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "formula");
        assert_eq!(read.rows[0].cells[0].text, "30");
    }

    #[test]
    fn an_inline_string_reads_as_its_text() {
        let sheet = r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "inline");
        assert_eq!(read.rows[0].cells[0].text, "inline");
        assert_eq!(read.rows[0].cells[0].kind, CellKind::Text);
    }

    #[test]
    fn the_dimension_sizes_a_sheet_the_rows_do_not_reach() {
        // A sheet whose only cell is A1 but whose dimension claims twenty rows: the grid is told
        // about all twenty, so its scrollbar matches what the file says.
        let sheet = r#"<?xml version="1.0"?><worksheet><dimension ref="A1:F20"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "dim");
        assert_eq!(read.row_count, 20);
        assert_eq!(read.columns, 6);
    }

    #[test]
    fn a_sheet_cut_off_in_the_middle_is_reported_as_truncated() {
        let sheet = r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2">"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "cut");
        assert!(read.truncated);
        assert_eq!(read.rows.len(), 1);
    }

    #[test]
    fn a_sheet_past_the_cell_cap_says_so_and_stops() {
        let cells: Vec<(Option<&str>, Option<&str>, &str)> = (0..MAX_CELLS + 10)
            .map(|_| (None, None, "1"))
            .collect();
        let sheet = sheet_xml(&[(None, cells)]);
        let parts = book(&sheet, None, None, None, None);
        let read = read_book(&parts, "cap");
        assert!(read.truncated);
        assert_eq!(read.rows[0].cells.len(), MAX_CELLS);
    }

    // -----------------------------------------------------------------------------------------
    // Merge, size, freeze
    // -----------------------------------------------------------------------------------------

    #[test]
    fn merges_sizes_and_a_frozen_pane_are_read() {
        let sheet = r#"<?xml version="1.0"?><worksheet>
<sheetViews><sheetView><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="2" width="12.5" customWidth="1"/><col min="4" max="4" width="8" hidden="1"/></cols>
<sheetData><row r="1" ht="30" customHeight="1"><c r="A1"><v>1</v></c></row></sheetData>
<mergeCells count="1"><mergeCell ref="A1:B2"/></mergeCells>
</worksheet>"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "merge");
        assert_eq!(read.frozen_rows, 2);
        assert_eq!(read.frozen_columns, 1);
        assert_eq!(
            read.merges,
            vec![Merge {
                row: 0,
                column: 0,
                row_span: 2,
                column_span: 2
            }]
        );
        // Excel's own width-to-pixels approximation, and a hidden column at zero.
        assert_eq!(read.column_sizes[0].size, 93.0);
        assert_eq!(read.column_sizes[1].size, 93.0);
        assert_eq!(read.column_sizes[2].size, 0.0);
        assert_eq!(read.row_heights[0].size, 40.0);
        assert_eq!(read.rows[0].height, Some(40.0));
        // A merge that reaches past the last cell still sizes the grid.
        assert_eq!(read.row_count, 2);
        assert_eq!(read.columns, 2);
    }

    #[test]
    fn a_later_column_run_overrides_the_one_it_overlaps() {
        // A writer states the sheet's default width for every column, then a `<col>` of its own for
        // the one that was widened: read in order, the wide column keeps the default and the cell
        // is drawn at the wrong width.
        let sheet = r#"<?xml version="1.0"?><worksheet>
<cols><col min="1" max="4" width="8" customWidth="1"/><col min="2" max="2" width="20" customWidth="1"/></cols>
<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>
</worksheet>"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "override");
        let by_index: std::collections::HashMap<u32, f32> = read
            .column_sizes
            .iter()
            .map(|column| (column.index, column.size))
            .collect();
        // 8 characters is 61px, 20 is 145px, and the second run is the one the column keeps.
        assert_eq!(by_index[&0], 61.0);
        assert_eq!(by_index[&1], 145.0);
        assert_eq!(by_index[&3], 61.0);
    }

    #[test]
    fn a_pane_that_says_it_is_only_split_is_not_frozen() {        let sheet = r#"<?xml version="1.0"?><worksheet><sheetViews><sheetView><pane xSplit="1" ySplit="1" state="split"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#;
        let parts = book(sheet, None, None, None, None);
        let read = read_book(&parts, "split");
        assert_eq!(read.frozen_rows, 0);
        assert_eq!(read.frozen_columns, 0);
    }

    // -----------------------------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------------------------

    fn styles_xml(fonts: &str, fills: &str, xfs: &str, num_fmts: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><styleSheet><numFmts count="9">{num_fmts}</numFmts><fonts count="2">{fonts}</fonts><fills count="2">{fills}</fills><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0"/></cellStyleXfs><cellXfs count="2">{xfs}</cellXfs></styleSheet>"#
        )
    }

    #[test]
    fn a_cell_style_carries_its_font_fill_and_format() {
        let styles = styles_xml(
            r#"<font/><font><b/><color rgb="FFFF0000"/></font>"#,
            r#"<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/></patternFill></fill>"#,
            r#"<xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="4" fontId="1" fillId="1" applyNumberFormat="1" applyFont="1" applyFill="1"><alignment horizontal="center" wrapText="1"/></xf>"#,
            "",
        );
        let sheet = r#"<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1234.5</v></c><c r="B1" s="1"><v>1234.5</v></c></row></sheetData></worksheet>"#;
        let parts = book(sheet, None, Some(&styles), None, None);
        let read = read_book(&parts, "style");
        let cells = &read.rows[0].cells;
        // The first cell has no style of its own; the format table holds only what is used.
        assert_eq!(read.styles.len(), 2);
        assert!(!read.styles[0].bold);
        assert_eq!(read.styles[0].fill, None);
        // The second is bold, red on green, centred and wrapped, and written with two decimals.
        let style = &read.styles[cells[1].style as usize];
        assert!(style.bold);
        assert_eq!(style.color.as_deref(), Some("#ff0000"));
        assert_eq!(style.fill.as_deref(), Some("#00ff00"));
        assert_eq!(style.align.as_deref(), Some("center"));
        assert!(style.wrap);
        assert_eq!(style.number_format.as_deref(), Some("#,##0.00"));
        assert_eq!(cells[1].text, "1,234.50");
        // The value before formatting is kept, so a reader can see what is under it.
        assert_eq!(cells[1].raw.as_deref(), Some("1234.5"));
        assert_eq!(cells[0].raw, None);
    }

    #[test]
    fn a_style_the_workbook_does_not_use_is_not_sent() {
        // `cellXfs` holds four formats and the sheet's one cell asks for none of them but the
        // plain one, so the sheet carries one style rather than four.
        let styles = styles_xml(
            "<font/><font/>",
            r#"<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>"#,
            r#"<xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="1" fontId="0" fillId="0"/><xf numFmtId="2" fontId="0" fillId="0"/><xf numFmtId="3" fontId="0" fillId="0"/>"#,
            "",
        );
        let parts = book(
            &sheet_xml(&[(None, vec![(None, None, "1")])]),
            None,
            Some(&styles),
            None,
            None,
        );
        let read = read_book(&parts, "unused");
        assert_eq!(read.styles.len(), 1);
        assert_eq!(read.rows[0].cells[0].style, 0);
    }

    #[test]
    fn a_cell_inherits_the_named_style_it_does_not_override() {
        // `applyFont="0"` means "as the named style says", and Excel writes the plain cells of a
        // workbook that way.
        let styles = r#"<?xml version="1.0"?><styleSheet>
<fonts count="2"><font/><font><b/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="1" fillId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" xfId="0" applyFont="0"/></cellXfs>
</styleSheet>"#;
        let parts = book(
            &sheet_xml(&[(None, vec![(None, None, "1")])]),
            None,
            Some(styles),
            None,
            None,
        );
        let read = read_book(&parts, "inherit");
        assert!(read.styles[0].bold);
    }

    #[test]
    fn a_custom_number_format_is_read_by_id() {
        let styles = styles_xml(
            "<font/>",
            r#"<fill><patternFill patternType="none"/></fill>"#,
            r#"<xf numFmtId="164" fontId="0" fillId="0" applyNumberFormat="1"/>"#,
            r#"<numFmt numFmtId="164" formatCode="0.000&quot; s&quot;"/>"#,
        );
        let parts = book(
            &sheet_xml(&[(None, vec![(None, None, "1.5")])]),
            None,
            Some(&styles),
            None,
            None,
        );
        let read = read_book(&parts, "custom");
        assert_eq!(read.styles[0].number_format.as_deref(), Some("0.000\" s\""));
        assert_eq!(read.rows[0].cells[0].text, "1.500 s");
    }

    #[test]
    fn a_colour_named_by_the_theme_is_found_through_the_theme_part() {
        let theme = r#"<?xml version="1.0"?><a:theme xmlns:a="x"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>"#;
        let styles = styles_xml(
            r#"<font><color theme="2"/></font>"#,
            r#"<fill><patternFill patternType="none"/></fill>"#,
            r#"<xf numFmtId="0" fontId="0" fillId="0"/>"#,
            "",
        );
        let parts = book(
            &sheet_xml(&[(None, vec![(None, None, "1")])]),
            None,
            Some(&styles),
            Some(theme),
            None,
        );
        let read = read_book(&parts, "theme");
        assert_eq!(read.styles[0].color.as_deref(), Some("#4472c4"));
    }

    #[test]
    fn a_theme_scheme_keeps_the_positions_its_numbers_count_from() {
        let theme = r#"<a:theme><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme></a:themeElements></a:theme>"#;
        let colors = theme_colors(theme);
        assert_eq!(colors.len(), 4);
        assert_eq!(colors[0], "#000000");
        assert_eq!(colors[2], "#44546a");
        assert_eq!(colors[3], "#4472c4");
    }

    #[test]
    fn a_colour_that_is_not_a_colour_is_none() {
        assert_eq!(from_argb("00FF0000"), None);
        assert_eq!(from_argb("FFFF0000").as_deref(), Some("#ff0000"));
        assert_eq!(from_argb("FF0000").as_deref(), Some("#ff0000"));
        assert_eq!(from_argb("auto"), None);
        // The legacy palette, and the two system entries that are not colours.
        assert_eq!(indexed_color(2).as_deref(), Some("#ff0000"));
        assert_eq!(indexed_color(64), None);
        assert_eq!(indexed_color(9_999), None);
    }

    #[test]
    fn a_fill_that_is_only_the_default_pattern_is_no_fill_at_all() {
        let styles = styles_xml(
            "<font/>",
            r#"<fill><patternFill patternType="gray125"/></fill>"#,
            r#"<xf numFmtId="0" fontId="0" fillId="0"/>"#,
            "",
        );
        let parts = book(
            &sheet_xml(&[(None, vec![(None, None, "1")])]),
            None,
            Some(&styles),
            None,
            None,
        );
        assert_eq!(read_book(&parts, "gray").styles[0].fill, None);
    }

    // -----------------------------------------------------------------------------------------
    // Number formats
    // -----------------------------------------------------------------------------------------

    #[test]
    fn the_general_form_reads_like_a_spreadsheet() {
        assert_eq!(general(0.0), "0");
        assert_eq!(general(42.0), "42");
        assert_eq!(general(1234.5), "1234.5");
        assert_eq!(general(-7.25), "-7.25");
        // Eleven significant digits, with the zeros its own rounding added taken off.
        assert_eq!(general(1.0 / 3.0), "0.3333333333");
        assert_eq!(general(123456789012.0), "1.23457E+11");
        assert_eq!(general(0.000012345), "1.2345E-05");
    }

    #[test]
    fn the_builtin_formats_read_as_the_table_says() {
        assert_eq!(format_number(1234.5, Some("0")), "1235");
        assert_eq!(format_number(1234.5, Some("0.00")), "1234.50");
        assert_eq!(format_number(1234.5, Some("#,##0")), "1,235");
        assert_eq!(format_number(1234.5, Some("#,##0.00")), "1,234.50");
        assert_eq!(format_number(-1234.5, Some("#,##0.00")), "-1,234.50");
        assert_eq!(format_number(0.125, Some("0%")), "13%");
        assert_eq!(format_number(0.125, Some("0.00%")), "12.50%");
        assert_eq!(format_number(0.125, Some("0.00E+00")), "1.25E-01");
        // A plain integer with a leading zero places it.
        assert_eq!(format_number(5.0, Some("000")), "005");
    }

    #[test]
    fn a_negative_value_that_rounds_to_zero_has_no_sign_to_carry() {
        assert_eq!(format_number(-0.001, Some("0")), "0");
    }

    #[test]
    fn a_custom_format_keeps_its_own_literals() {
        // The currency symbol comes out of the locale block, and the unit out of quotes.
        assert_eq!(format_number(3.0, Some("[$￥-804]#,##0.00")), "￥3.00");
        assert_eq!(format_number(3.5, Some(r#"0.0" kg""#)), "3.5 kg");
        assert_eq!(format_number(3.5, Some(r"\#0.0")), "#3.5");
        assert_eq!(format_number(3.5, Some(r"0.0_)")), "3.5 ");
        // A negative section carries its own parentheses, and the space the positive one ends with
        // is the room they take: it is part of what the format draws.
        assert_eq!(format_number(-12.0, Some("#,##0 ;(#,##0)")), "(12)");
        assert_eq!(format_number(12.0, Some("#,##0 ;(#,##0)")), "12 ");
        // A third section is what zero reads as.
        assert_eq!(format_number(0.0, Some("0;(0);\"-\"")), "-");
        assert_eq!(format_number(5.0, Some("0;(0);\"-\"")), "5");
        assert_eq!(format_number(-5.0, Some("0;(0);\"-\"")), "(5)");
    }

    #[test]
    fn a_date_serial_reads_as_the_date_it_stands_for() {
        // 45119 is 2023-07-12 in Excel's own counting, on the far side of its 1900 leap year.
        assert_eq!(format_number(45119.0, Some("mm-dd-yy")), "07-12-23");
        assert_eq!(format_number(45119.0, Some("d-mmm-yy")), "12-Jul-23");
        assert_eq!(format_number(45119.0, Some("mmm-yy")), "Jul-23");
        assert_eq!(format_number(45119.0, Some("yyyy-mm-dd")), "2023-07-12");
        assert_eq!(format_number(45119.0, Some("dddd")), "Wednesday");
        assert_eq!(format_number(45119.0, Some("ddd")), "Wed");
        assert_eq!(format_number(45119.0, Some("mmm")), "Jul");
        assert_eq!(format_number(45119.0, Some("mmmm")), "July");
        assert_eq!(format_number(45119.0, Some("m")), "7");
        assert_eq!(format_number(45119.0, Some("d")), "12");
        assert_eq!(format_number(45119.0, Some("yy")), "23");
        // The calendar the serial numbers start from.
        assert_eq!(format_number(1.0, Some("yyyy-mm-dd")), "1900-01-01");
        assert_eq!(format_number(59.0, Some("yyyy-mm-dd")), "1900-02-28");
        // Excel counts a 1900-02-29 that never happened, and every later serial is a day off it.
        assert_eq!(format_number(61.0, Some("yyyy-mm-dd")), "1900-03-01");
        assert_eq!(format_number(36526.0, Some("yyyy-mm-dd")), "2000-01-01");
    }

    #[test]
    fn a_time_reads_as_the_clock_or_as_an_elapsed_span() {
        let noon_and_a_half = 12.5 / 24.0;
        assert_eq!(format_number(noon_and_a_half, Some("h:mm")), "12:30");
        assert_eq!(format_number(noon_and_a_half, Some("h:mm:ss")), "12:30:00");
        assert_eq!(format_number(noon_and_a_half, Some("h:mm AM/PM")), "12:30 PM");
        assert_eq!(format_number(noon_and_a_half, Some("hh:mm")), "12:30");
        assert_eq!(format_number(0.25, Some("h:mm AM/PM")), "6:00 AM");
        assert_eq!(format_number(0.0, Some("h:mm AM/PM")), "12:00 AM");
        // A date and a time in one, which is what `m/d/yy h:mm` is for.
        assert_eq!(
            format_number(45119.5, Some("m/d/yy h:mm")),
            "7/12/23 12:00"
        );
        // The elapsed form counts past the day rather than wrapping at midnight.
        assert_eq!(format_number(1.5, Some("[h]:mm")), "36:00");
        assert_eq!(format_number(0.5, Some("mm:ss")), "00:00");
        // The minutes of `mm:ss` are minutes; the same letters next to a day are a month.
        assert_eq!(format_number(0.51, Some("mm:ss")), "14:24");
    }

    #[test]
    fn an_unknown_format_still_gives_a_readable_number() {
        // Nothing here is a format a spreadsheet writes, and the value is not lost to it.
        assert_eq!(format_number(42.0, Some("")), "42");
        assert_eq!(format_number(42.0, Some("General")), "42");
        assert_eq!(format_number(42.0, None), "42");
        assert_eq!(format_number(1234.5, Some("@")), "1234.5");
        assert_eq!(format_number(f64::NAN, None), "");
        assert_eq!(format_number(f64::INFINITY, Some("0.00")), "");
    }

    #[test]
    fn a_thousands_separator_only_counts_between_digits() {
        // A comma at the end of a format scales by a thousand in Excel, not grouping.
        assert!(numeric_shape(&tokenize("#,##0")).grouping);
        assert!(!numeric_shape(&tokenize("#0,")).grouping);
        assert_eq!(group_digits("1234567"), "1,234,567");
        assert_eq!(group_digits("123"), "123");
    }

    #[test]
    fn a_format_splits_into_sections_outside_quotes() {
        let sections = split_sections("#,##0.00;[Red](#,##0.00);\"none at all\"");
        assert_eq!(sections.len(), 3);
        assert_eq!(sections[1], "[Red](#,##0.00)");
        // The quoted semicolon is part of the section, not a split.
        assert!(sections[2].contains("none at all"));
    }

    #[test]
    fn a_quoted_letter_is_text_and_does_not_make_it_a_date() {
        // `"days"` is the format's own word, not the date token `d`.
        let tokens = tokenize(r#"0" days""#);
        assert!(!is_date_format(&tokens));
        assert_eq!(format_number(3.0, Some(r#"0" days""#)), "3 days");
    }

    #[test]
    fn a_date_a_day_and_a_month_still_read_as_a_date() {
        // `d` and `m` together are the date tokens, wherever they sit.
        assert!(is_date_format(&tokenize("yy")));
        assert!(is_date_format(&tokenize("mmm")));
        assert!(!is_date_format(&tokenize("#,##0.00")));
        assert!(!is_date_format(&tokenize("0.00E+00")));
    }
}
