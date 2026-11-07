//! Conditional formatting: the rules a sheet states about its own cells.
//!
//! A rule is not decoration. A workbook with a list of journal names says "highlight the ones that
//! appear twice", a score sheet says "colour this by its value"; what the rule paints is the answer
//! to a question the file is asking. Four kinds are read here, which is what the workbooks measured
//! on this machine use: duplicates, uniques, a comparison, and a two or three colour scale.
//!
//! Not read: data bars, icon sets, `expression`, `top10`, `aboveAverage` and blanks. Each is a
//! different drawing rather than a different colour, and a guess at one would be worse than
//! drawing the cell plainly.

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::Reader;

use super::office::{attr, attr_number, local};
use super::xlsx::{color_of, CellStyle, XlsxCell, XlsxRow};

/// How far a range reaches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Area {
    pub(crate) row: u32,
    pub(crate) column: u32,
    pub(crate) row_span: u32,
    pub(crate) column_span: u32,
}

impl Area {
    fn holds(&self, row: u32, column: u32) -> bool {
        row >= self.row
            && row < self.row + self.row_span
            && column >= self.column
            && column < self.column + self.column_span
    }
}

/// Which cells a rule marks.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Kind {
    /// A value that appears more than once in the rule's own ranges.
    Duplicate,
    /// A value that appears exactly once.
    Unique,
    /// A number compared with a constant, or between two.
    Compare {
        operator: Compare,
        first: f64,
        second: Option<f64>,
    },
    /// The cell's text against a needle.
    Text { operator: TextOp, needle: String },
    /// A colour chosen by where the value sits between the range's smallest and largest.
    Scale(Vec<(f64, String)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Compare {
    GreaterThan,
    LessThan,
    GreaterThanOrEqual,
    LessThanOrEqual,
    Equal,
    NotEqual,
    Between,
    NotBetween,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TextOp {
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
}

/// One rule as the sheet states it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Rule {
    pub(crate) areas: Vec<Area>,
    pub(crate) kind: Kind,
    /// What the rule paints, for every kind but a colour scale, which paints per cell.
    pub(crate) style: CellStyle,
    /// Lower is more important, and the first rule that matches a cell is the one that paints it.
    pub(crate) priority: i64,
}

/// The rules a sheet states, and the styles they paint with.
///
/// `dxfs` are the differential formats a workbook keeps apart from its cell styles, which is where
/// a conditional rule's colours live.
pub(crate) fn read_rules(sheet_xml: &str, dxfs: &[CellStyle], theme: &[String]) -> Vec<Rule> {
    let mut rules = Vec::new();
    let mut areas: Vec<Area> = Vec::new();
    let mut open: Option<PendingRule> = None;
    let mut reader = Reader::from_str(sheet_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) => {
                begin(&element, theme, &mut areas, &mut open);
            }
            // A rule is nearly always written self closed, so it is finished where it stands: there
            // is no end tag to wait for, and waiting for one lost every rule in a real workbook.
            Ok(Event::Empty(element)) => {
                begin(&element, theme, &mut areas, &mut open);
                if local(element.name()) == b"cfRule" {
                    finish(&mut open, &areas, dxfs, &mut rules);
                }
            }
            Ok(Event::Text(text)) => {
                // A `<formula>` carries its value as text between its tags.
                if let Some(rule) = open.as_mut() {
                    if !rule.in_scale {
                        let value = String::from_utf8_lossy(text.as_ref()).to_string();
                        rule.push_formula_text(&value);
                    }
                }
            }
            Ok(Event::End(element)) => {
                if local(element.name()) == b"cfRule" {
                    finish(&mut open, &areas, dxfs, &mut rules);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    rules.sort_by_key(|rule| rule.priority);
    rules
}

/// Reads one opening tag, which either starts a rule, names a range, or adds to the rule open.
fn begin(
    element: &quick_xml::events::BytesStart<'_>,
    theme: &[String],
    areas: &mut Vec<Area>,
    open: &mut Option<PendingRule>,
) {
    match local(element.name()) {
        // The range this block of rules applies to.
        b"conditionalFormatting" => {
            *areas = attr(element, b"sqref")
                .map(|value| sqref_areas(&value))
                .unwrap_or_default();
        }
        b"cfRule" => {
            *open = Some(PendingRule {
                kind: attr(element, b"type").unwrap_or_default(),
                operator: attr(element, b"operator").unwrap_or_default(),
                text: attr(element, b"text"),
                formulas: Vec::new(),
                dxf: attr_number::<i64>(element, b"dxfId"),
                priority: attr_number::<i64>(element, b"priority").unwrap_or(0),
                colors: Vec::new(),
                in_scale: false,
            });
        }
        b"formula" => {
            if let Some(rule) = open.as_mut() {
                rule.expect_formula();
            }
        }
        b"colorScale" => {
            if let Some(rule) = open.as_mut() {
                rule.in_scale = true;
            }
        }
        // Inside a colour scale, each `<color>` is one stop of it.
        b"color" if open.as_ref().is_some_and(|rule| rule.in_scale) => {
            if let Some(colour) = color_of(element, theme) {
                if let Some(rule) = open.as_mut() {
                    rule.colors.push(colour);
                }
            }
        }
        _ => {}
    }
}

/// Turns the rule that was open into one the sheet can be painted with.
fn finish(
    open: &mut Option<PendingRule>,
    areas: &[Area],
    dxfs: &[CellStyle],
    rules: &mut Vec<Rule>,
) {
    let Some(pending) = open.take() else { return };
    let Some(kind) = pending.kind_of() else { return };
    rules.push(Rule {
        areas: areas.to_vec(),
        kind,
        style: pending
            .dxf
            .and_then(|index| dxfs.get(index as usize).cloned())
            .unwrap_or_default(),
        priority: pending.priority,
    });
}

/// A rule as it is being read, before the sheet's ranges and styles are attached.
#[derive(Debug)]
struct PendingRule {
    kind: String,
    operator: String,
    text: Option<String>,
    formulas: Vec<String>,
    dxf: Option<i64>,
    priority: i64,
    colors: Vec<String>,
    in_scale: bool,
}

impl PendingRule {
    fn expect_formula(&mut self) {
        self.formulas.push(String::new());
    }

    fn push_formula_text(&mut self, value: &str) {
        if let Some(last) = self.formulas.last_mut() {
            last.push_str(value);
        }
    }

    /// What this rule marks, or nothing when it is a kind this reader does not draw.
    fn kind_of(&self) -> Option<Kind> {
        match self.kind.as_str() {
            "duplicateValues" => Some(Kind::Duplicate),
            "uniqueValues" => Some(Kind::Unique),
            "cellIs" => {
                let operator = match self.operator.as_str() {
                    "greaterThan" => Compare::GreaterThan,
                    "lessThan" => Compare::LessThan,
                    "greaterThanOrEqual" => Compare::GreaterThanOrEqual,
                    "lessThanOrEqual" => Compare::LessThanOrEqual,
                    "equal" => Compare::Equal,
                    "notEqual" => Compare::NotEqual,
                    "between" => Compare::Between,
                    "notBetween" => Compare::NotBetween,
                    _ => return None,
                };
                let numbers: Vec<f64> = self
                    .formulas
                    .iter()
                    .filter_map(|formula| formula.trim().parse::<f64>().ok())
                    .collect();
                Some(Kind::Compare {
                    operator,
                    first: *numbers.first()?,
                    second: numbers.get(1).copied(),
                })
            }
            "containsText" => self.text_rule(TextOp::Contains),
            "notContainsText" => self.text_rule(TextOp::NotContains),
            "beginsWith" => self.text_rule(TextOp::BeginsWith),
            "endsWith" => self.text_rule(TextOp::EndsWith),
            "colorScale" => {
                // Two or three stops, each a position and the colour there.
                if self.colors.len() < 2 {
                    return None;
                }
                let stops: Vec<(f64, String)> = self
                    .colors
                    .iter()
                    .enumerate()
                    .map(|(at, color)| {
                        let position = at as f64 / (self.colors.len() - 1) as f64;
                        (position, color.clone())
                    })
                    .collect();
                Some(Kind::Scale(stops))
            }
            _ => None,
        }
    }

    fn text_rule(&self, operator: TextOp) -> Option<Kind> {
        Some(Kind::Text {
            operator,
            needle: self.text.clone()?,
        })
    }
}

/// The areas an `sqref` names, which is one range or several separated by spaces.
fn sqref_areas(value: &str) -> Vec<Area> {
    value.split_whitespace().filter_map(single_area).collect()
}

/// One `A1:B3` or `A1`, as an area.
fn single_area(text: &str) -> Option<Area> {
    let (start, end) = match text.split_once(':') {
        Some((start, end)) => (start, end),
        None => (text, text),
    };
    let (start_row, start_column) = cell_reference(start)?;
    let (end_row, end_column) = cell_reference(end)?;
    let (top, bottom) = (start_row.min(end_row), start_row.max(end_row));
    let (left, right) = (start_column.min(end_column), start_column.max(end_column));
    Some(Area {
        row: top,
        column: left,
        row_span: bottom - top + 1,
        column_span: right - left + 1,
    })
}

/// `B7` as a row and a column, both zero based.
fn cell_reference(text: &str) -> Option<(u32, u32)> {
    let letters: String = text
        .chars()
        .take_while(|character| character.is_ascii_alphabetic())
        .collect();
    let digits: String = text
        .chars()
        .skip_while(|character| character.is_ascii_alphabetic())
        .collect();
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let mut column = 0u32;
    for letter in letters.to_ascii_uppercase().chars() {
        column = column * 26 + (letter as u32 - 'A' as u32 + 1);
    }
    let row = digits.parse::<u32>().ok()?;
    Some((row.checked_sub(1)?, column.checked_sub(1)?))
}

/// Paints every cell a rule marks, appending one style per painted rule to the sheet's table.
pub(crate) fn apply(rules: &[Rule], rows: &mut [XlsxRow], table: &mut Vec<CellStyle>) {
    if rules.is_empty() {
        return;
    }
    // A cell is painted once: the first rule that matches it, in priority order.
    let mut painted: HashMap<(u32, u32), u32> = HashMap::new();
    for rule in rules {
        if let Kind::Scale(stops) = &rule.kind {
            paint_scale(rule, stops, rows, &mut painted, table);
            continue;
        }
        table.push(rule.style.clone());
        let style = (table.len() - 1) as u32;
        let counts = matches_duplicate(&rule.kind).then(|| value_counts(rule, rows));
        for row in rows.iter_mut() {
            for cell in row.cells.iter_mut() {
                if !rule.areas.iter().any(|area| area.holds(row.index, cell.column)) {
                    continue;
                }
                if painted.contains_key(&(row.index, cell.column)) {
                    continue;
                }
                let matches = match &rule.kind {
                    Kind::Duplicate => counts
                        .as_ref()
                        .is_some_and(|counts| counts.get(&value_of(cell)).copied().unwrap_or(0) > 1),
                    Kind::Unique => counts
                        .as_ref()
                        .is_some_and(|counts| counts.get(&value_of(cell)).copied().unwrap_or(0) == 1),
                    Kind::Compare {
                        operator,
                        first,
                        second,
                    } => number_of(cell).is_some_and(|number| compares(*operator, number, *first, *second)),
                    Kind::Text { operator, needle } => text_matches(*operator, &cell.text, needle),
                    Kind::Scale(_) => false,
                };
                if matches {
                    cell.conditional = Some(style);
                    painted.insert((row.index, cell.column), style);
                }
            }
        }
    }
}

/// A colour scale paints each cell a different colour, so it is applied in one pass over the range.
fn paint_scale(
    rule: &Rule,
    stops: &[(f64, String)],
    rows: &mut [XlsxRow],
    painted: &mut HashMap<(u32, u32), u32>,
    table: &mut Vec<CellStyle>,
) {
    let mut values: Vec<f64> = Vec::new();
    for row in rows.iter() {
        for cell in row.cells.iter() {
            if !rule.areas.iter().any(|area| area.holds(row.index, cell.column)) {
                continue;
            }
            if let Some(number) = number_of(cell) {
                values.push(number);
            }
        }
    }
    let Some(smallest) = values.iter().copied().reduce(f64::min) else {
        return;
    };
    let largest = values.iter().copied().reduce(f64::max).unwrap_or(smallest);
    let span = largest - smallest;
    // One style per colour a cell actually lands on, so a thousand cells do not add a thousand
    // entries to the table.
    let mut used: HashMap<String, u32> = HashMap::new();
    for row in rows.iter_mut() {
        for cell in row.cells.iter_mut() {
            if !rule.areas.iter().any(|area| area.holds(row.index, cell.column)) {
                continue;
            }
            if painted.contains_key(&(row.index, cell.column)) {
                continue;
            }
            let Some(number) = number_of(cell) else {
                continue;
            };
            let position = if span <= 0.0 { 0.0 } else { (number - smallest) / span };
            let colour = blend(stops, position);
            let index = *used.entry(colour.clone()).or_insert_with(|| {
                table.push(CellStyle {
                    fill: Some(colour),
                    ..Default::default()
                });
                (table.len() - 1) as u32
            });
            cell.conditional = Some(index);
            painted.insert((row.index, cell.column), index);
        }
    }
}

/// The colour at a position along a colour scale, interpolated between the stops either side of it.
fn blend(stops: &[(f64, String)], position: f64) -> String {
    let position = position.clamp(0.0, 1.0);
    let mut lower = &stops[0];
    let mut upper = &stops[stops.len() - 1];
    for pair in stops.windows(2) {
        if position >= pair[0].0 && position <= pair[1].0 {
            lower = &pair[0];
            upper = &pair[1];
            break;
        }
    }
    let width = upper.0 - lower.0;
    let ratio = if width <= 0.0 { 0.0 } else { (position - lower.0) / width };
    match (channels(&lower.1), channels(&upper.1)) {
        (Some(low), Some(high)) => {
            let mix = |at: usize| {
                (low[at] + (high[at] - low[at]) * ratio).round().clamp(0.0, 255.0) as u8
            };
            format!("#{:02x}{:02x}{:02x}", mix(0), mix(1), mix(2))
        }
        _ => lower.1.clone(),
    }
}

fn channels(color: &str) -> Option<[f64; 3]> {
    let hex = color.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    Some([
        u8::from_str_radix(&hex[0..2], 16).ok()? as f64,
        u8::from_str_radix(&hex[2..4], 16).ok()? as f64,
        u8::from_str_radix(&hex[4..6], 16).ok()? as f64,
    ])
}

/// The value a duplicate check compares, which is what the cell holds rather than how it reads: two
/// dates formatted differently are still the same date.
fn value_of(cell: &XlsxCell) -> String {
    cell.raw
        .clone()
        .unwrap_or_else(|| cell.text.clone())
        .trim()
        .to_lowercase()
}

fn number_of(cell: &XlsxCell) -> Option<f64> {
    let text = cell.raw.clone().unwrap_or_else(|| cell.text.clone());
    text.trim().parse::<f64>().ok()
}

fn matches_duplicate(kind: &Kind) -> bool {
    matches!(kind, Kind::Duplicate | Kind::Unique)
}

/// How often each value appears across the rule's own ranges.
fn value_counts(rule: &Rule, rows: &[XlsxRow]) -> HashMap<String, usize> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for row in rows {
        for cell in &row.cells {
            if !rule.areas.iter().any(|area| area.holds(row.index, cell.column)) {
                continue;
            }
            let value = value_of(cell);
            // A blank is not a duplicate of another blank.
            if value.is_empty() {
                continue;
            }
            *counts.entry(value).or_default() += 1;
        }
    }
    counts
}

fn compares(operator: Compare, value: f64, first: f64, second: Option<f64>) -> bool {
    match operator {
        Compare::GreaterThan => value > first,
        Compare::LessThan => value < first,
        Compare::GreaterThanOrEqual => value >= first,
        Compare::LessThanOrEqual => value <= first,
        Compare::Equal => value == first,
        Compare::NotEqual => value != first,
        Compare::Between => second.is_some_and(|second| value >= first.min(second) && value <= first.max(second)),
        Compare::NotBetween => second.is_none_or(|second| value < first.min(second) || value > first.max(second)),
    }
}

fn text_matches(operator: TextOp, haystack: &str, needle: &str) -> bool {
    let haystack = haystack.to_lowercase();
    let needle = needle.to_lowercase();
    match operator {
        TextOp::Contains => haystack.contains(&needle),
        TextOp::NotContains => !haystack.contains(&needle),
        TextOp::BeginsWith => haystack.starts_with(&needle),
        TextOp::EndsWith => haystack.ends_with(&needle),
    }
}

/// The differential formats a workbook keeps for its conditional rules.
///
/// A `dxf` states only what differs from the cell's own style, so every field it leaves out is left
/// out here too rather than filled with a default that would repaint the cell.
pub(crate) fn read_dxfs(styles_xml: &str, theme: &[String]) -> Vec<CellStyle> {
    let mut out: Vec<CellStyle> = Vec::new();
    let mut reader = Reader::from_str(styles_xml);
    reader.config_mut().trim_text(false);
    let mut current: Option<CellStyle> = None;
    let mut in_dxfs = false;
    let mut in_font = false;
    let mut in_fill = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(element)) | Ok(Event::Empty(element)) => {
                match local(element.name()) {
                    b"dxfs" => in_dxfs = true,
                    b"dxf" if in_dxfs => current = Some(CellStyle::default()),
                    b"font" if current.is_some() => in_font = true,
                    b"fill" if current.is_some() => in_fill = true,
                    b"b" if in_font => {
                        if let Some(style) = current.as_mut() {
                            style.bold = attr(&element, b"val").as_deref() != Some("0");
                        }
                    }
                    b"i" if in_font => {
                        if let Some(style) = current.as_mut() {
                            style.italic = attr(&element, b"val").as_deref() != Some("0");
                        }
                    }
                    b"color" if in_font => {
                        if let Some(style) = current.as_mut() {
                            if let Some(colour) = color_of(&element, theme) {
                                style.color = Some(colour);
                            }
                        }
                    }
                    // In a differential format the fill's background is the colour the rule paints,
                    // which is the opposite of how a cell's own style stores it.
                    b"bgColor" | b"fgColor" if in_fill => {
                        if let Some(colour) = color_of(&element, theme) {
                            if let Some(style) = current.as_mut() {
                                if style.fill.is_none() || local(element.name()) == b"bgColor" {
                                    style.fill = Some(colour);
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(element)) => match local(element.name()) {
                b"dxfs" => in_dxfs = false,
                b"font" => in_font = false,
                b"fill" => in_fill = false,
                b"dxf" => {
                    if let Some(style) = current.take() {
                        out.push(style);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::xlsx::CellKind;

    fn cell(column: u32, text: &str) -> XlsxCell {
        XlsxCell {
            column,
            text: text.to_string(),
            kind: CellKind::Text,
            style: 0,
            raw: None,
            conditional: None,
        }
    }

    fn row(index: u32, cells: Vec<XlsxCell>) -> XlsxRow {
        XlsxRow {
            index,
            height: None,
            cells,
        }
    }

    const NAMES: &str = r#"<?xml version="1.0"?>
<worksheet xmlns="s"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>
<conditionalFormatting sqref="A1:A3"><cfRule type="duplicateValues" dxfId="0" priority="1"/></conditionalFormatting>
</worksheet>"#;

    const RED: &str = r#"<?xml version="1.0"?>
<styleSheet xmlns="s"><dxfs count="1"><dxf><fill><patternFill patternType="solid"><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs></styleSheet>"#;

    #[test]
    fn a_reference_splits_into_the_cells_it_names() {
        assert_eq!(
            sqref_areas("B7"),
            vec![Area {
                row: 6,
                column: 1,
                row_span: 1,
                column_span: 1
            }]
        );
        assert_eq!(
            sqref_areas("A1:B3 C5"),
            vec![
                Area {
                    row: 0,
                    column: 0,
                    row_span: 3,
                    column_span: 2
                },
                Area {
                    row: 4,
                    column: 2,
                    row_span: 1,
                    column_span: 1
                },
            ]
        );
        // `AA` is the twenty seventh column, and a reference written backwards still names the box.
        assert_eq!(sqref_areas("AA10:Z2")[0].column, 25);
        assert_eq!(sqref_areas("AA10:Z2")[0].column_span, 2);
    }

    #[test]
    fn a_differential_format_is_the_colour_the_rule_paints() {
        let dxfs = read_dxfs(RED, &[]);
        assert_eq!(dxfs.len(), 1);
        assert_eq!(dxfs[0].fill, Some("#ffc7ce".to_string()));
        // What the file leaves out stays out: a default here would repaint every cell the rule
        // touches.
        assert!(!dxfs[0].bold);
        assert_eq!(dxfs[0].color, None);
    }

    #[test]
    fn a_duplicate_rule_paints_the_values_that_appear_twice() {
        let dxfs = read_dxfs(RED, &[]);
        let rules = read_rules(NAMES, &dxfs, &[]);
        assert_eq!(rules.len(), 1);
        let mut rows = vec![
            row(0, vec![cell(0, "材料学报")]),
            row(1, vec![cell(0, "机械工程")]),
            row(2, vec![cell(0, "材料学报")]),
            // Outside the rule's range, so a duplicate there is not counted.
            row(3, vec![cell(0, "材料学报")]),
        ];
        let mut table: Vec<CellStyle> = Vec::new();
        apply(&rules, &mut rows, &mut table);
        assert!(rows[0].cells[0].conditional.is_some());
        assert_eq!(rows[1].cells[0].conditional, None);
        assert!(rows[2].cells[0].conditional.is_some());
        assert_eq!(rows[3].cells[0].conditional, None);
        let style = &table[rows[0].cells[0].conditional.unwrap() as usize];
        assert_eq!(style.fill, Some("#ffc7ce".to_string()));
    }

    #[test]
    fn a_unique_rule_paints_the_values_that_appear_once() {
        let xml = r#"<worksheet><conditionalFormatting sqref="A1:A3"><cfRule type="uniqueValues" dxfId="0" priority="1"/></conditionalFormatting></worksheet>"#;
        let dxfs = read_dxfs(RED, &[]);
        let rules = read_rules(xml, &dxfs, &[]);
        let mut rows = vec![
            row(0, vec![cell(0, "a")]),
            row(1, vec![cell(0, "a")]),
            row(2, vec![cell(0, "b")]),
        ];
        let mut table: Vec<CellStyle> = Vec::new();
        apply(&rules, &mut rows, &mut table);
        assert_eq!(rows[0].cells[0].conditional, None);
        assert_eq!(rows[1].cells[0].conditional, None);
        assert!(rows[2].cells[0].conditional.is_some());
    }

    #[test]
    fn a_comparison_rule_paints_by_the_numbers_it_states() {
        let xml = r#"<worksheet><conditionalFormatting sqref="B1:B4"><cfRule type="cellIs" operator="greaterThan" dxfId="0" priority="1"><formula>60</formula></cfRule></conditionalFormatting></worksheet>"#;
        let dxfs = read_dxfs(RED, &[]);
        let rules = read_rules(xml, &dxfs, &[]);
        let mut rows = vec![
            row(0, vec![XlsxCell { raw: Some("59.5".into()), ..cell(1, "59.5") }]),
            row(1, vec![XlsxCell { raw: Some("60".into()), ..cell(1, "60") }]),
            row(2, vec![XlsxCell { raw: Some("61".into()), ..cell(1, "61") }]),
            row(3, vec![cell(1, "n/a")]),
        ];
        let mut table: Vec<CellStyle> = Vec::new();
        apply(&rules, &mut rows, &mut table);
        assert_eq!(rows[0].cells[0].conditional, None);
        assert_eq!(rows[1].cells[0].conditional, None);
        assert!(rows[2].cells[0].conditional.is_some());
        // A cell that is not a number does not compare.
        assert_eq!(rows[3].cells[0].conditional, None);
    }

    #[test]
    fn a_text_rule_paints_what_it_matches_and_is_not_case_sensitive() {
        let xml = r#"<worksheet><conditionalFormatting sqref="A1:A2"><cfRule type="containsText" operator="containsText" text="学报" dxfId="0" priority="1"><formula>NOT(ISERROR(SEARCH("学报",A1)))</formula></cfRule></conditionalFormatting></worksheet>"#;
        let dxfs = read_dxfs(RED, &[]);
        let rules = read_rules(xml, &dxfs, &[]);
        let mut rows = vec![
            row(0, vec![cell(0, "材料学报")]),
            row(1, vec![cell(0, "机械工程")]),
        ];
        let mut table: Vec<CellStyle> = Vec::new();
        apply(&rules, &mut rows, &mut table);
        assert!(rows[0].cells[0].conditional.is_some());
        assert_eq!(rows[1].cells[0].conditional, None);
    }

    #[test]
    fn a_colour_scale_paints_each_value_by_where_it_sits() {
        let xml = r#"<worksheet><conditionalFormatting sqref="A1:A3"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min" val="0"/><cfvo type="max" val="100"/><color rgb="FF000000"/><color rgb="FFFFFFFF"/></colorScale></cfRule></conditionalFormatting></worksheet>"#;
        let rules = read_rules(xml, &[], &[]);
        assert_eq!(rules.len(), 1);
        let mut rows = vec![
            row(0, vec![XlsxCell { raw: Some("0".into()), ..cell(0, "0") }]),
            row(1, vec![XlsxCell { raw: Some("50".into()), ..cell(0, "50") }]),
            row(2, vec![XlsxCell { raw: Some("100".into()), ..cell(0, "100") }]),
        ];
        let mut table: Vec<CellStyle> = Vec::new();
        apply(&rules, &mut rows, &mut table);
        let colour = |at: usize| {
            table[rows[at].cells[0].conditional.unwrap() as usize]
                .fill
                .clone()
                .unwrap()
        };
        assert_eq!(colour(0), "#000000");
        assert_eq!(colour(1), "#808080");
        assert_eq!(colour(2), "#ffffff");
    }

    #[test]
    fn the_first_rule_in_priority_order_is_the_one_that_paints() {
        // A cell can be caught by two rules; the file says which one wins by its priority.
        let xml = r#"<worksheet><conditionalFormatting sqref="A1:A2"><cfRule type="duplicateValues" dxfId="1" priority="2"/><cfRule type="duplicateValues" dxfId="0" priority="1"/></conditionalFormatting></worksheet>"#;
        let dxfs = vec![
            CellStyle { fill: Some("#111111".into()), ..Default::default() },
            CellStyle { fill: Some("#222222".into()), ..Default::default() },
        ];
        let rules = read_rules(xml, &dxfs, &[]);
        let mut rows = vec![row(0, vec![cell(0, "x")]), row(1, vec![cell(0, "x")])];
        let mut table: Vec<CellStyle> = Vec::new();
        apply(&rules, &mut rows, &mut table);
        let style = &table[rows[0].cells[0].conditional.unwrap() as usize];
        assert_eq!(style.fill, Some("#111111".to_string()));
    }

    #[test]
    fn a_kind_this_reader_does_not_draw_is_skipped_rather_than_guessed() {
        // Data bars and icon sets are a different drawing, not a different colour.
        let xml = r#"<worksheet><conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting></worksheet>"#;
        assert!(read_rules(xml, &[], &[]).is_empty());
    }
}
