//! WMF and EMF: the metafiles a Word document keeps a pasted chart, an equation or a screenshot in.
//!
//! Windows metafiles are recorded GDI calls. A webview has no decoder for either format, so a
//! document full of them draws as a page with holes in it - which is why the reader used to count
//! them and say so. This turns them into something a webview does draw: the records are replayed
//! into an SVG document (rectangles, polygons, lines and text are what the records are), and a
//! record that carries a bitmap - which is what a pasted screenshot is - becomes a PNG.
//!
//! It is a reader, not a renderer: it understands the records a document actually holds, and an
//! unknown record is skipped by its own length rather than failing the read. Nothing here needs a
//! dependency the reader did not already have: the PNG comes out of the `image` crate the screenshot
//! encoder uses, and the SVG is text.

use std::collections::HashMap;

use base64::Engine;

/// Whether these bytes are a metafile this reader knows at all, so the caller can tell "a picture it
/// cannot draw" from "not a picture".
pub(crate) fn is_metafile(bytes: &[u8]) -> bool {
    kind(bytes).is_some()
}

/// The metafile as a `data:` URL a webview can draw, or `None` when it holds nothing to draw.
pub(crate) fn data_url(bytes: &[u8]) -> Option<String> {
    let mut painter = Painter::default();
    match kind(bytes)? {
        Kind::Wmf(header) => painter.wmf(bytes, header)?,
        Kind::Emf => painter.emf(bytes)?,
    }
    painter.data_url()
}

/// Which metafile this is, and where its standard header starts.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Kind {
    /// A WMF, and the offset of its `METAHEADER` (`0`, or `22` past a placeable header).
    Wmf(usize),
    Emf,
}

/// The signature an enhanced metafile starts with, `" EMF"` as a little endian `u32`.
const EMF_SIGNATURE: u32 = 0x464D_4520;
/// The magic a placeable WMF starts with.
const PLACEABLE_MAGIC: u32 = 0x9AC6_CDD7;

fn kind(bytes: &[u8]) -> Option<Kind> {
    if bytes.len() >= 64
        && u32_at(bytes, 0)? == 1
        && u32_at(bytes, 40)? == EMF_SIGNATURE
        && u32_at(bytes, 4)? >= 88
    {
        return Some(Kind::Emf);
    }
    let header = if u32_at(bytes, 0)? == PLACEABLE_MAGIC { 22 } else { 0 };
    if bytes.len() < header + 18 {
        return None;
    }
    // A standard header is nine words: the type (`0` for a memory metafile, `1` for one on disk),
    // the header's own length, and the version, which is `0x0300` for every WMF in the wild.
    let kind = u16_at(bytes, header)?;
    let header_size = u16_at(bytes, header + 2)?;
    let version = u16_at(bytes, header + 4)?;
    if kind <= 1 && header_size == 9 && version == 0x0300 {
        return Some(Kind::Wmf(header));
    }
    None
}

// ---------------------------------------------------------------------------------------------
// Reading fields out of a record
// ---------------------------------------------------------------------------------------------

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn i16_at(bytes: &[u8], at: usize) -> Option<i32> {
    Some(i16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?) as i32)
}

fn i32_at(bytes: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// A point in a record: two 16 bit coordinates.
fn point16(bytes: &[u8], at: usize) -> Option<(f32, f32)> {
    Some((i16_at(bytes, at)? as f32, i16_at(bytes, at + 2)? as f32))
}

/// A point in a record: two 32 bit coordinates.
fn point32(bytes: &[u8], at: usize) -> Option<(f32, f32)> {
    Some((i32_at(bytes, at)? as f32, i32_at(bytes, at + 4)? as f32))
}

/// A `COLORREF` (`0x00BBGGRR`) as `#rrggbb`.
fn color_ref(value: u32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        value & 0xFF,
        (value >> 8) & 0xFF,
        (value >> 16) & 0xFF
    )
}

// ---------------------------------------------------------------------------------------------
// The GDI state a record stream moves through
// ---------------------------------------------------------------------------------------------

/// A pen, a brush or a font, as `SELECTOBJECT` addresses them.
#[derive(Debug, Clone, PartialEq)]
enum Object {
    Pen { color: String, width: f32 },
    Brush { color: String },
    Font(Font),
    /// A stock object this reader has no use for: a palette, a region, a font it does not draw with.
    Other,
}

#[derive(Debug, Clone, PartialEq)]
struct Font {
    /// Character height in logical units, which for GDI is the cell height.
    height: f32,
    weight: u32,
    italic: bool,
    face: String,
}

impl Default for Font {
    fn default() -> Self {
        Font {
            height: 12.0,
            weight: 400,
            italic: false,
            face: "sans-serif".to_string(),
        }
    }
}

/// The stock objects, which every device context starts with. WMF addresses them by their index in
/// this list, EMF by `0x80000000 + index`.
fn stock(index: u32) -> Object {
    match index {
        0..=4 => Object::Brush {
            color: ["#ffffff", "#c0c0c0", "#808080", "#404040", "#000000"][index as usize].to_string(),
        },
        5 | 6 => Object::Brush {
            color: "none".to_string(),
        },
        7 | 8 => Object::Pen {
            color: if index == 7 { "#ffffff" } else { "#000000" }.to_string(),
            width: 1.0,
        },
        9 => Object::Pen {
            color: "none".to_string(),
            width: 1.0,
        },
        10..=14 | 16 | 17 => Object::Font(Font::default()),
        _ => Object::Other,
    }
}

/// What the replay has drawn, and where.
struct Painter {
    /// The window and viewport origins and extents, and the world transform: the three mappings a
    /// logical coordinate goes through before it is a pixel.
    window_org: (f32, f32),
    window_ext: (f32, f32),
    viewport_org: (f32, f32),
    viewport_ext: (f32, f32),
    world: (f32, f32, f32, f32, f32, f32),
    /// The objects a device context holds, addressed as `SELECTOBJECT` addresses them.
    objects: HashMap<u32, Object>,
    pen: Object,
    brush: Object,
    text_color: String,
    font: Font,
    fill_rule: &'static str,
    /// The last `MOVETO`, for `LINETO` and for a `POLYLINE` that starts from it.
    current: (f32, f32),
    /// The path being built, when an EMF is between `BEGINPATH` and `ENDPATH`.
    path: Option<String>,
    /// The SVG elements drawn so far.
    body: String,
    /// How many drawing operations there were, and how many of them were bitmaps: a metafile that is
    /// one bitmap and nothing else is that bitmap, not an SVG around it.
    drawings: usize,
    bitmaps: usize,
    sole_bitmap: Option<String>,
    /// The ink, which is what the SVG is sized to.
    ink: Option<(f32, f32, f32, f32)>,
}

impl Default for Painter {
    /// A device context as one starts: a white brush, a black pen one pixel wide, black text, and
    /// the three mappings set to identity - which is the `MM_TEXT` a metafile opens in.
    fn default() -> Self {
        Painter {
            window_org: (0.0, 0.0),
            window_ext: (1.0, 1.0),
            viewport_org: (0.0, 0.0),
            viewport_ext: (1.0, 1.0),
            world: (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
            objects: HashMap::new(),
            pen: Object::Pen {
                color: "#000000".to_string(),
                width: 1.0,
            },
            brush: Object::Brush {
                color: "#ffffff".to_string(),
            },
            text_color: "#000000".to_string(),
            font: Font::default(),
            fill_rule: "nonzero",
            current: (0.0, 0.0),
            path: None,
            body: String::new(),
            drawings: 0,
            bitmaps: 0,
            sole_bitmap: None,
            ink: None,
        }
    }
}

impl Painter {
    /// A logical point as a pixel.
    fn map(&self, x: f32, y: f32) -> (f32, f32) {
        let (a, b, c, d, e, f) = self.world;
        let (x, y) = (a * x + c * y + e, b * x + d * y + f);
        let window = self.window_ext;
        let viewport = self.viewport_ext;
        let scale_x = if window.0 != 0.0 { viewport.0 / window.0 } else { 1.0 };
        let scale_y = if window.1 != 0.0 { viewport.1 / window.1 } else { 1.0 };
        (
            (x - self.window_org.0) * scale_x + self.viewport_org.0,
            (y - self.window_org.1) * scale_y + self.viewport_org.1,
        )
    }

    /// A length, in the pixels the ink is measured in.
    fn scale_x(&self) -> f32 {
        let scale = if self.window_ext.0 != 0.0 {
            self.viewport_ext.0 / self.window_ext.0
        } else {
            1.0
        };
        scale.abs().max(0.01)
    }

    fn scale_y(&self) -> f32 {
        let scale = if self.window_ext.1 != 0.0 {
            self.viewport_ext.1 / self.window_ext.1
        } else {
            1.0
        };
        scale.abs().max(0.01)
    }

    fn pen(&self) -> (String, f32) {
        match &self.pen {
            Object::Pen { color, width } => (color.clone(), *width),
            _ => ("none".to_string(), 1.0),
        }
    }

    fn pen_color(&self) -> String {
        self.pen().0
    }

    fn pen_width(&self) -> f32 {
        let (_, width) = self.pen();
        width * self.scale_x().max(self.scale_y())
    }

    fn brush_color(&self) -> String {
        match &self.brush {
            Object::Brush { color } => color.clone(),
            _ => "none".to_string(),
        }
    }

    /// Note that something was drawn where Word would show it, which is how the SVG is sized.
    fn note_ink(&mut self, points: &[(f32, f32)], pen: f32) {
        for (x, y) in points {
            let half = pen / 2.0;
            let (min_x, min_y, max_x, max_y) = *self
                .ink
                .get_or_insert((x - half, y - half, x + half, y + half));
            self.ink = Some((
                min_x.min(x - half),
                min_y.min(y - half),
                max_x.max(x + half),
                max_y.max(y + half),
            ));
        }
    }

    /// The stroke and fill attributes a drawing call paints with, empty when it paints nothing.
    fn paint(&self) -> String {
        let stroke = self.pen_color();
        let pen = self.pen_width();
        let brush = self.brush_color();
        let mut out = format!(
            " fill=\"{}\" fill-rule=\"{}\"",
            if brush == "none" { "none" } else { &brush },
            self.fill_rule
        );
        if stroke == "none" {
            out.push_str(" stroke=\"none\"");
        } else {
            out.push_str(&format!(" stroke=\"{stroke}\" stroke-width=\"{pen:.2}\""));
        }
        out
    }

    fn push(&mut self, element: String) {
        if let Some(path) = &mut self.path {
            // Inside a path bracket the primitives are accumulated, so a file that fills a path
            // fills the whole outline rather than each piece.
            path.push_str(&element);
            path.push(' ');
        } else {
            self.body.push_str(&element);
            self.body.push('\n');
        }
    }

    fn drawn(&mut self) {
        self.drawings += 1;
    }

    // ---- the drawing calls the records speak ----

    fn rectangle(&mut self, left: f32, top: f32, right: f32, bottom: f32, round: f32) {
        let (x1, y1) = self.map(left, top);
        let (x2, y2) = self.map(right, bottom);
        let (x, y) = (x1.min(x2), y1.min(y2));
        let (w, h) = ((x2 - x1).abs(), (y2 - y1).abs());
        let paint = self.paint();
        self.note_ink(&[(x, y), (x + w, y + h)], self.pen_width());
        self.drawn();
        if self.path.is_some() {
            self.push(format!("M {x:.2} {y:.2} h {w:.2} v {h:.2} h -{w:.2} Z"));
        } else if round > 0.0 {
            self.push(format!(
                "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" rx=\"{round:.2}\" ry=\"{round:.2}\"{paint}/>"
            ));
        } else {
            self.push(format!(
                "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\"{paint}/>"
            ));
        }
    }

    fn ellipse(&mut self, left: f32, top: f32, right: f32, bottom: f32) {
        let (cx, cy) = self.map((left + right) / 2.0, (top + bottom) / 2.0);
        let rx = ((right - left).abs() / 2.0) * self.scale_x();
        let ry = ((bottom - top).abs() / 2.0) * self.scale_y();
        let paint = self.paint();
        self.note_ink(
            &[(cx - rx, cy - ry), (cx + rx, cy + ry)],
            self.pen_width(),
        );
        self.drawn();
        if self.path.is_some() {
            // A path bracket holding an ellipse is filled by the same brush the ellipse itself would
            // be filled with, so drawing it here reads the same and needs no arc arithmetic.
            self.push(format!(
                "M {:.2} {:.2} A {rx:.2} {ry:.2} 0 1 0 {:.2} {:.2} A {rx:.2} {ry:.2} 0 1 0 {:.2} {:.2}",
                cx - rx,
                cy,
                cx + rx,
                cy,
                cx - rx,
                cy
            ));
        } else {
            self.push(format!(
                "<ellipse cx=\"{cx:.2}\" cy=\"{cy:.2}\" rx=\"{rx:.2}\" ry=\"{ry:.2}\"{paint}/>"
            ));
        }
    }

    fn polygon(&mut self, points: &[(f32, f32)], close: bool) {
        let mapped: Vec<(f32, f32)> = points.iter().map(|(x, y)| self.map(*x, *y)).collect();
        let coordinates = mapped
            .iter()
            .map(|(x, y)| format!("{x:.2},{y:.2}"))
            .collect::<Vec<_>>()
            .join(" ");
        let paint = self.paint();
        self.note_ink(&mapped, self.pen_width());
        self.drawn();
        if self.path.is_some() {
            let path = mapped
                .iter()
                .enumerate()
                .map(|(index, (x, y))| {
                    if index == 0 {
                        format!("M {x:.2} {y:.2}")
                    } else {
                        format!("L {x:.2} {y:.2}")
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            self.push(if close { format!("{path} Z") } else { path });
        } else if close {
            self.push(format!("<polygon points=\"{coordinates}\"{paint}/>"));
        } else {
            self.push(format!(
                "<polyline points=\"{coordinates}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"/>",
                self.pen_color(),
                self.pen_width()
            ));
        }
    }

    fn line(&mut self, x: f32, y: f32) {
        let (from_x, from_y) = self.map(self.current.0, self.current.1);
        let (to_x, to_y) = self.map(x, y);
        self.current = (x, y);
        let color = self.pen_color();
        let width = self.pen_width();
        self.note_ink(&[(from_x, from_y), (to_x, to_y)], width);
        self.drawn();
        if self.path.is_some() {
            self.push(format!("M {to_x:.2} {to_y:.2}"));
        } else {
            self.push(format!(
                "<line x1=\"{from_x:.2}\" y1=\"{from_y:.2}\" x2=\"{to_x:.2}\" y2=\"{to_y:.2}\" stroke=\"{color}\" stroke-width=\"{width:.2}\"/>"
            ));
        }
    }

    fn pixel(&mut self, x: f32, y: f32, color: String) {
        let (x, y) = self.map(x, y);
        self.note_ink(&[(x, y)], 1.0);
        self.drawn();
        self.push(format!(
            "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"1\" height=\"1\" fill=\"{color}\"/>"
        ));
    }

    fn text(&mut self, x: f32, y: f32, text: &str, align: Option<u32>) {
        if text.is_empty() {
            return;
        }
        let (mut x, y) = self.map(x, y);
        // GDI states the size as a cell height; a browser states an em size, which for the faces
        // Windows uses is about three quarters of it.
        let size = (self.font.height.abs() * 0.75 * self.scale_y()).max(1.0);
        let width = text.chars().count() as f32 * size * 0.52;
        // `ExTextOut` may align the text on the point rather than start it there.
        match align {
            Some(1) => x -= width,        // TA_RIGHT
            Some(2) => x -= width / 2.0,  // TA_CENTER
            _ => {}
        }
        let escaped = escape(text, true);
        let weight = self.font.weight;
        let style = if self.font.italic { "italic" } else { "normal" };
        let face = escape(&self.font.face, false);
        let color = self.text_color.clone();
        self.note_ink(&[(x, y - size), (x + width, y)], 0.0);
        self.drawn();
        self.push(format!(
            "<text x=\"{x:.2}\" y=\"{y:.2}\" font-family=\"{face}, sans-serif\" font-size=\"{size:.2}px\" font-weight=\"{weight}\" font-style=\"{style}\" fill=\"{color}\">{escaped}</text>"
        ));
    }

    fn bitmap(&mut self, image: String, dx: f32, dy: f32, dw: f32, dh: f32) {
        let (x, y) = self.map(dx, dy);
        let width = dw.abs() * self.scale_x();
        let height = dh.abs() * self.scale_y();
        self.bitmaps += 1;
        self.sole_bitmap = Some(image.clone());
        self.drawings += 1;
        self.note_ink(&[(x, y), (x + width, y + height)], 0.0);
        self.push(format!(
            "<image x=\"{x:.2}\" y=\"{y:.2}\" width=\"{width:.2}\" height=\"{height:.2}\" preserveAspectRatio=\"none\" href=\"{image}\"/>"
        ));
    }

    /// What was drawn, as a `data:` URL.
    fn data_url(&self) -> Option<String> {
        if self.drawings == 0 {
            return None;
        }
        // A metafile that is one bitmap and nothing else is that bitmap: wrapping it in an SVG would
        // base64 it twice over, which for a pasted screenshot is megabytes.
        if self.bitmaps == 1 && self.drawings == 1 {
            return self.sole_bitmap.clone();
        }
        let (min_x, min_y, max_x, max_y) = self.ink?;
        let width = (max_x - min_x).max(1.0);
        let height = (max_y - min_y).max(1.0);
        // A little air around the ink: GDI draws a pen centred on the outline, and the pane scales
        // the picture to the size the document asks for anyway.
        let svg = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"{width:.0}\" height=\"{height:.0}\" viewBox=\"{min_x:.2} {min_y:.2} {width:.2} {height:.2}\"><rect x=\"{min_x:.2}\" y=\"{min_y:.2}\" width=\"{width:.2}\" height=\"{height:.2}\" fill=\"#ffffff\"/>\n{}\n</svg>",
            self.body
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
        Some(format!("data:image/svg+xml;base64,{encoded}"))
    }

    // ---- the two record streams ----

    /// Replay a WMF: 16 bit words, `[size in words][function][parameters]`.
    fn wmf(&mut self, bytes: &[u8], header: usize) -> Option<()> {
        let mut at = header + u16_at(bytes, header + 2)? as usize * 2;
        while at + 6 <= bytes.len() {
            let size = u32_at(bytes, at)? as usize;
            let function = u16_at(bytes, at + 4)?;
            if size < 3 || at + size * 2 > bytes.len() {
                break;
            }
            let record = &bytes[at..at + size * 2];
            let parameters = &record[6..];
            self.wmf_record(function, parameters);
            at += size * 2;
        }
        Some(())
    }

    fn wmf_record(&mut self, function: u16, p: &[u8]) {
        match function {
            0x0000 => {} // EOF
            0x0102 => {} // SETBKMODE: a background mode only shows through opaque text.
            0x0104 => {} // SETROP2: the pane draws solid; DSTINVERT and the like are not reproduced.
            0x0106 => self.fill_rule = fill_rule(u16_at(p, 0).unwrap_or(1) as u32),
            0x0103 | 0x0107 | 0x010A | 0x0108 | 0x0109 | 0x012E | 0x00F0 | 0x00F7 | 0x00F8
            | 0x0035 | 0x0034 | 0x01F9 | 0x02FF | 0x02FE | 0x0105 => {} // state this reader ignores
            0x0320 => {
                // SETPIXEL: a colour, then the point as y and x.
                if let (Some(color), Some(y), Some(x)) = (u32_at(p, 0), i16_at(p, 4), i16_at(p, 6)) {
                    self.pixel(x as f32, y as f32, color_ref(color));
                }
            }
            0x0A32 => self.wmf_ext_text_out(p),
            0x0521 => {
                // TEXTOUT: the count, the text, then where it starts as y and x.
                let Some(count) = u16_at(p, 0).map(usize::from) else {
                    return;
                };
                let text = text_from(p, 2, count, 1);
                let padded = count.div_ceil(2) * 2;
                let (Some(y), Some(x)) = (i16_at(p, 2 + padded), i16_at(p, 4 + padded)) else {
                    return;
                };
                self.text(x as f32, y as f32, &text, None);
            }
            0x0209 => self.text_color = color_ref(u32_at(p, 0).unwrap_or(0)),
            0x0201 => {} // SETBKCOLOR
            0x020C | 0x010C => {
                if let Some((x, y)) = point16(p, 2) {
                    self.window_ext = (x, y);
                }
            }
            0x020B | 0x010B => {
                if let Some((x, y)) = point16(p, 2) {
                    self.window_org = (x, y);
                }
            }
            0x020E | 0x010E => {
                if let Some((x, y)) = point16(p, 2) {
                    self.viewport_ext = (x, y);
                }
            }
            0x020D | 0x010D => {
                if let Some((x, y)) = point16(p, 2) {
                    self.viewport_org = (x, y);
                }
            }
            0x0214 | 0x0114 => {
                // MOVETO: the corner as y and x.
                if let (Some(y), Some(x)) = (i16_at(p, 0), i16_at(p, 2)) {
                    self.current = (x as f32, y as f32);
                }
            }
            0x0213 | 0x0113 => {
                if let (Some(y), Some(x)) = (i16_at(p, 0), i16_at(p, 2)) {
                    self.line(x as f32, y as f32);
                }
            }
            0x02FA => {
                // CREATEPENINDIRECT: a style, a width, then the colour two words further on (the
                // width is written as a word with a word of padding after it).
                let color = color_ref(u32_at(p, 6).unwrap_or(0));
                let width = i16_at(p, 2).unwrap_or(1).abs() as f32;
                self.objects.insert(
                    self.wmf_object_slot(),
                    Object::Pen {
                        color,
                        width: width.max(1.0),
                    },
                );
            }
            0x02FC => {
                // CREATEBRUSHINDIRECT: a style and a colour; a null brush (`style == 5`) paints
                // nothing, which is how a document draws an unfilled shape.
                let style = u16_at(p, 0).unwrap_or(0);
                let color = if style == 5 {
                    "none".to_string()
                } else {
                    color_ref(u32_at(p, 2).unwrap_or(0))
                };
                self.objects.insert(self.wmf_object_slot(), Object::Brush { color });
            }
            0x02FB => {
                let font = self.wmf_font(p);
                self.objects.insert(self.wmf_object_slot(), Object::Font(font));
            }
            0x012D => {
                let index = u16_at(p, 0).unwrap_or(0) as u32;
                self.select(index);
            }
            0x01F0 => {
                let index = u16_at(p, 0).unwrap_or(0) as u32;
                self.objects.remove(&index);
            }
            0x041B => {
                if let Some((l, t, r, b)) = wmf_box(p) {
                    self.rectangle(l, t, r, b, 0.0);
                }
            }
            0x061C => {
                if let (Some((l, t, r, b)), Some((w, h))) = (wmf_box(p), point16(p, 10)) {
                    self.rectangle(l, t, r, b, ((w + h) / 2.0).max(0.0));
                }
            }
            0x0418 => {
                if let Some((l, t, r, b)) = wmf_box(p) {
                    self.ellipse(l, t, r, b);
                }
            }
            0x0324 | 0x0325 => {
                let Some(count) = u16_at(p, 0).map(|value| value as usize) else {
                    return;
                };
                if count == 0 || count > 10_000 {
                    return;
                }
                let points = (0..count)
                    .filter_map(|index| point16(p, 2 + index * 4))
                    .collect::<Vec<_>>();
                self.polygon(&points, function == 0x0324);
            }
            0x0538 => {
                // POLYPOLYGON: how many polygons, the total point count, then each polygon's count.
                let Some(polygons) = u16_at(p, 0).map(|value| value as usize) else {
                    return;
                };
                let Some(total) = u16_at(p, 2).map(|value| value as usize) else {
                    return;
                };
                if polygons == 0 || polygons > 10_000 || total > 100_000 {
                    return;
                }
                let counts = (0..polygons)
                    .filter_map(|index| u16_at(p, 4 + index * 2))
                    .collect::<Vec<_>>();
                let mut at = 4 + polygons * 2;
                for count in counts {
                    let points = (0..count as usize)
                        .filter_map(|index| point16(p, at + index * 4))
                        .collect::<Vec<_>>();
                    self.polygon(&points, true);
                    at += count as usize * 4;
                }
            }
            // A picture, written four different ways by four Windows versions. Each is a raster
            // op, the destination's size and corner, and then the `BITMAPINFO` and its pixels.
            0x0F43 | 0x0B41 => self.wmf_bitmap(p, 20, false),
            0x0940 => self.wmf_bitmap(p, 12, false),
            0x0D33 => {
                // SETDIBTODEV names only where it goes; the size is the bitmap's own.
                self.wmf_bitmap(p, 18, true)
            }
            _ => {}
        }
    }

    /// Where the next brush or pen a WMF creates goes: the object table is a list, and a slot a
    /// `DELETEOBJECT` emptied is used again.
    fn wmf_object_slot(&self) -> u32 {
        let mut slot = 0;
        while self.objects.contains_key(&slot) {
            slot += 1;
        }
        slot
    }

    fn wmf_font(&self, p: &[u8]) -> Font {
        // CREATEFONTINDIRECT is the sixteen bit `LOGFONT`: five words of sizes, a word of weight,
        // then the four one byte flags, then the face name as UTF-16.
        let face = text_from(p, 18, 32, 2);
        Font {
            height: i16_at(p, 0).unwrap_or(-12).abs() as f32,
            weight: u16_at(p, 8).unwrap_or(400) as u32,
            italic: p.get(10).map(|value| value & 1 != 0).unwrap_or(false),
            face: face_name(&face),
        }
    }

    /// A WMF's bitmap record.
    ///
    /// GDI's own writer leaves two bytes of padding between the raster op and the fields after it, and
    /// a writer that does not is just as valid, so the bitmap is *looked for* - the first offset that
    /// reads as a `BITMAPINFO` whose rows fit - and the destination corner is read from where the
    /// bitmap actually starts. `size_from_dib` is for the record that names no destination size.
    fn wmf_bitmap(&mut self, p: &[u8], from: usize, size_from_dib: bool) {
        let Some(at) = (from..from + 8).find(|at| p.get(*at..).and_then(dib_png).is_some()) else {
            return;
        };
        // The destination corner is the two words in front of the bitmap, and its size the two
        // before those.
        let (Some(x), Some(y)) = (i16_at(p, at - 2), i16_at(p, at - 4)) else {
            return;
        };
        let (width, height) = if size_from_dib {
            dib_size(&p[at..]).unwrap_or((0.0, 0.0))
        } else {
            match (i16_at(p, at - 6), i16_at(p, at - 8)) {
                (Some(width), Some(height)) => (width as f32, height as f32),
                _ => return,
            }
        };
        if width <= 0.0 || height <= 0.0 {
            return;
        }
        if let Some(image) = p.get(at..).and_then(dib_png) {
            self.bitmap(image, x as f32, y as f32, width, height);
        }
    }

    /// Replay an EMF: 32 bit records, `[type][size][parameters]`.
    fn emf(&mut self, bytes: &[u8]) -> Option<()> {
        let mut at = 0;
        while at + 8 <= bytes.len() {
            let kind = u32_at(bytes, at)?;
            let size = u32_at(bytes, at + 4)? as usize;
            if size < 8 || at + size > bytes.len() {
                break;
            }
            let p = &bytes[at + 8..at + size];
            self.emf_record(kind, p);
            at += size;
        }
        Some(())
    }

    fn emf_record(&mut self, kind: u32, p: &[u8]) {
        match kind {
            1 | 14 => {} // HEADER, EOF
            19 => self.fill_rule = fill_rule(u32_at(p, 0).unwrap_or(1)),
            18 | 20 | 21 | 98 | 13 | 16 | 22 | 28 | 33 | 40 | 58 => {} // state, read where it matters
            24 => self.text_color = color_ref(u32_at(p, 0).unwrap_or(0)),
            25 => {}
            9 => self.window_ext = (i32_at(p, 0).unwrap_or(1) as f32, i32_at(p, 4).unwrap_or(1) as f32),
            10 => self.window_org = (i32_at(p, 0).unwrap_or(0) as f32, i32_at(p, 4).unwrap_or(0) as f32),
            11 => {
                self.viewport_ext = (i32_at(p, 0).unwrap_or(1) as f32, i32_at(p, 4).unwrap_or(1) as f32)
            }
            12 => {
                self.viewport_org = (i32_at(p, 0).unwrap_or(0) as f32, i32_at(p, 4).unwrap_or(0) as f32)
            }
            35 | 36 => {
                // SETWORLDTRANSFORM / MODIFYWORLDTRANSFORM: a 2x2 and a translation, in `FLOAT`s.
                let values = (0..6)
                    .filter_map(|index| float_at(p, index * 4))
                    .collect::<Vec<f32>>();
                if let [a, b, c, d, e, f] = values[..] {
                    if kind == 35 {
                        self.world = (a, b, c, d, e, f);
                    } else {
                        // The mode is the last field: copy, left-multiply or reset.
                        match u32_at(p, 24) {
                            Some(1) => self.world = (a, b, c, d, e, f),
                            Some(2) => self.world = multiply(&self.world, &(a, b, c, d, e, f)),
                            _ => self.world = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
                        }
                    }
                }
            }
            27 => {
                if let Some(point) = point32(p, 0) {
                    self.current = point;
                }
            }
            54 => {
                if let Some(point) = point32(p, 0) {
                    self.line(point.0, point.1);
                }
            }
            15 => {
                // SETPIXELV: the point, then the colour.
                if let (Some((x, y)), Some(color)) = (point32(p, 0), u32_at(p, 8)) {
                    self.pixel(x, y, color_ref(color));
                }
            }
            42 => {
                if let (Some((l, t)), Some((r, b))) = (point32(p, 0), point32(p, 8)) {
                    self.ellipse(l, t, r, b);
                }
            }
            43 => {
                if let (Some((l, t)), Some((r, b))) = (point32(p, 0), point32(p, 8)) {
                    self.rectangle(l, t, r, b, 0.0);
                }
            }
            44 => {
                if let (Some((l, t)), Some((r, b)), Some((w, h))) =
                    (point32(p, 0), point32(p, 8), point32(p, 16))
                {
                    self.rectangle(l, t, r, b, ((w + h) / 2.0).max(0.0));
                }
            }
            86 | 87 => self.emf_points16(p, kind == 86),
            3 | 4 => self.emf_points32(p, kind == 3),
            59 => self.path = Some(String::new()),
            60 | 68 => {
                // ENDPATH leaves the path for the fill that follows; ABORTPATH throws it away.
                if kind == 68 {
                    self.path = None;
                }
            }
            61 => {
                if let Some(path) = &mut self.path {
                    path.push('Z');
                    path.push(' ');
                }
            }
            62 | 63 => {
                // FILLPATH / STROKEANDFILLPATH: the gathered outline is one shape now.
                if let Some(path) = self.path.take() {
                    if !path.trim().is_empty() {
                        let paint = self.paint();
                        self.push_positioned(path, paint);
                        self.drawings += 1;
                    }
                }
            }
            64 => {
                // STROKEPATH: the outline with no fill.
                if let Some(path) = self.path.take() {
                    if !path.trim().is_empty() {
                        self.push_positioned(
                            path,
                            format!(
                                " fill=\"none\" stroke=\"{}\" stroke-width=\"{:.2}\"",
                                self.pen_color(),
                                self.pen_width()
                            ),
                        );
                        self.drawings += 1;
                    }
                }
            }
            67 => {
                // SELECTCLIPPATH: the path becomes the clip, which this reader does not carry.
                self.path = None;
            }
            37 => {
                let handle = u32_at(p, 0).unwrap_or(0);
                self.select(handle);
            }
            38 => {
                // CREATEPEN: the handle, the style, the width, a hatch style, then the colour.
                let Some(handle) = u32_at(p, 0) else { return };
                let style = u32_at(p, 4).unwrap_or(0);
                let width = i32_at(p, 8).unwrap_or(1).abs() as f32;
                let color = if style == 5 {
                    "none".to_string()
                } else {
                    color_ref(u32_at(p, 16).unwrap_or(0))
                };
                self.objects
                    .insert(handle, Object::Pen { color, width: width.max(1.0) });
            }
            95 => {
                // EXTCREATEPEN: a header this reader reads the width and the colour out of.
                let Some(handle) = u32_at(p, 0) else { return };
                let width = u32_at(p, 8).unwrap_or(1) as f32;
                self.objects.insert(
                    handle,
                    Object::Pen {
                        color: color_ref(u32_at(p, 12).unwrap_or(0)),
                        width: width.max(1.0),
                    },
                );
            }
            39 => {
                // CREATEBRUSHINDIRECT: the handle, the style, the colour, the hatch.
                let Some(handle) = u32_at(p, 0) else { return };
                let style = u32_at(p, 4).unwrap_or(0);
                let color = if style == 5 {
                    "none".to_string()
                } else {
                    color_ref(u32_at(p, 8).unwrap_or(0))
                };
                self.objects.insert(handle, Object::Brush { color });
            }
            93 | 94 => {
                // A monochrome or pattern brush: this reader paints solid black rather than dropping
                // the shape, which keeps a diagram's boxes where they were.
                let Some(handle) = u32_at(p, 0) else { return };
                self.objects.insert(
                    handle,
                    Object::Brush {
                        color: "#000000".to_string(),
                    },
                );
            }
            82 => {
                // EXTCREATEFONTINDIRECTW: the handle, then a `LOGFONTW` (its face name as UTF-16).
                let Some(handle) = u32_at(p, 0) else { return };
                if p.len() >= 96 {
                    let face = text_from(p, 32, 32, 2);
                    self.objects.insert(
                        handle,
                        Object::Font(Font {
                            height: i32_at(p, 4).unwrap_or(-12).abs() as f32,
                            weight: u32_at(p, 20).unwrap_or(400),
                            italic: p.get(24).map(|value| value & 1 != 0).unwrap_or(false),
                            face: face_name(&face),
                        }),
                    );
                }
            }
            81 => {
                // STRETCHDIBITS: where it goes, where it is cropped from, then the header and the
                // pixels at offsets of their own.
                let (Some(x), Some(y)) = (i32_at(p, 16), i32_at(p, 20)) else {
                    return;
                };
                let (Some(width), Some(height)) = (i32_at(p, 64), i32_at(p, 68)) else {
                    return;
                };
                let dib = emf_dib(
                    p,
                    u32_at(p, 40).unwrap_or(0),
                    u32_at(p, 44).unwrap_or(0),
                    u32_at(p, 48).unwrap_or(0),
                    u32_at(p, 52).unwrap_or(0),
                );
                if let Some(dib) = dib {
                    if let Some(image) = dib_png(&dib) {
                        self.bitmap(image, x as f32, y as f32, width as f32, height as f32);
                    }
                }
            }
            76 | 77 => {
                // BITBLT / STRETCHBLT: when the source is a device bitmap the record carries no
                // pixels, and a metafile in a document is written from a `DIB` instead - which is a
                // `STRETCHDIBITS`. Left out rather than guessed at.
            }
            80 => {
                // SETDIBITSTODEVICE: where it goes, then the header and the pixels; the size is the
                // bitmap's own.
                let (Some(x), Some(y)) = (i32_at(p, 16), i32_at(p, 20)) else {
                    return;
                };
                let dib = emf_dib(
                    p,
                    u32_at(p, 40).unwrap_or(0),
                    u32_at(p, 44).unwrap_or(0),
                    u32_at(p, 48).unwrap_or(0),
                    u32_at(p, 52).unwrap_or(0),
                );
                if let Some(dib) = dib {
                    let (width, height) = dib_size(&dib).unwrap_or((0.0, 0.0));
                    if let Some(image) = dib_png(&dib) {
                        self.bitmap(image, x as f32, y as f32, width, height);
                    }
                }
            }
            83 | 84 => self.emf_ext_text_out(p, kind == 84),
            _ => {}
        }
    }

    fn emf_points16(&mut self, p: &[u8], close: bool) {
        // The record opens with the bounds of the points that follow; the count is what says how
        // many there are, and the points start after it.
        let Some(count) = u32_at(p, 16).map(|value| value as usize) else {
            return;
        };
        if count == 0 || count > 100_000 {
            return;
        }
        let points = (0..count)
            .filter_map(|index| point16(p, 20 + index * 4))
            .collect::<Vec<_>>();
        self.polygon(&points, close);
    }

    fn emf_points32(&mut self, p: &[u8], close: bool) {
        let Some(count) = u32_at(p, 16).map(|value| value as usize) else {
            return;
        };
        if count == 0 || count > 100_000 {
            return;
        }
        let points = (0..count)
            .filter_map(|index| point32(p, 20 + index * 8))
            .collect::<Vec<_>>();
        self.polygon(&points, close);
    }

    /// An `EMRTEXT` record: the bounds, the graphics mode and the scales, then where the text is,
    /// how much of it there is, and the offset of its bytes from the start of the record.
    fn emf_ext_text_out(&mut self, p: &[u8], wide: bool) {
        let (Some(x), Some(y)) = (i32_at(p, 28), i32_at(p, 32)) else {
            return;
        };
        let Some(count) = u32_at(p, 36).map(|value| value as usize) else {
            return;
        };
        let Some(offset) = u32_at(p, 40).map(|value| value as usize).filter(|value| *value >= 8)
        else {
            return;
        };
        let unit = if wide { 2 } else { 1 };
        let text = text_from(p, offset - 8, count, unit);
        self.text(x as f32, y as f32, &text, None);
    }

    /// A `EXTTEXTOUT` in a WMF: where the text is as y and x, the count, the options, an optional
    /// rectangle when the options ask for one, then the string.
    fn wmf_ext_text_out(&mut self, p: &[u8]) {
        let (Some(y), Some(x)) = (i16_at(p, 0), i16_at(p, 2)) else {
            return;
        };
        let Some(count) = i16_at(p, 4).map(|value| value.max(0) as usize) else {
            return;
        };
        let options = u16_at(p, 6).unwrap_or(0);
        // ETO_CLIPPED (4) and ETO_OPAQUE (2) each add the rectangle the text is clipped to.
        let at = if options & 0x6 != 0 { 16 } else { 8 };
        let text = text_from(p, at, count, 1);
        self.text(x as f32, y as f32, &text, Some(options as u32));
    }

    /// Select an object, by its index in a WMF's table or by the handle an EMF created it with.
    fn select(&mut self, handle: u32) {
        let object = self.objects.get(&handle).cloned().unwrap_or_else(|| {
            if handle & 0x8000_0000 != 0 {
                stock(handle & 0x7FFF_FFFF)
            } else {
                Object::Other
            }
        });
        match object {
            Object::Pen { .. } => self.pen = object,
            Object::Brush { .. } => self.brush = object,
            Object::Font(_) => {
                if let Object::Font(font) = object {
                    self.font = font;
                }
            }
            _ => {}
        }
    }

    /// A gathered path is pushed as it is: the coordinates inside it are already pixels.
    fn push_positioned(&mut self, path: String, paint: String) {
        self.body
            .push_str(&format!("<path d=\"{path}\"{paint}/>\n"));
    }
}

/// `SETPOLYFILLMODE`'s value, which decides whether a shape's holes are filled.
fn fill_rule(mode: u32) -> &'static str {
    if mode == 2 {
        "evenodd"
    } else {
        "nonzero"
    }
}

/// The world transform multiplied on the right by another.
fn multiply(
    left: &(f32, f32, f32, f32, f32, f32),
    right: &(f32, f32, f32, f32, f32, f32),
) -> (f32, f32, f32, f32, f32, f32) {
    let (a, b, c, d, e, f) = *left;
    let (g, h, i, j, k, l) = *right;
    (
        a * g + c * h,
        b * g + d * h,
        a * i + c * j,
        b * i + d * j,
        a * k + c * l + e,
        b * k + d * l + f,
    )
}

fn float_at(bytes: &[u8], at: usize) -> Option<f32> {
    Some(f32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// A face name as GDI stores it: an ANSI name, sometimes with the character set in front of it.
fn face_name(face: &str) -> String {
    let face = face.trim();
    let face = match face.split_once(':') {
        Some((prefix, rest)) if prefix.len() == 3 => rest,
        _ => face,
    };
    face.trim().to_string()
}

/// Text from a record: `unit` bytes a character, trimmed of nothing but the NUL padding.
fn text_from(bytes: &[u8], at: usize, count: usize, unit: usize) -> String {
    let length = count * unit;
    let Some(slice) = bytes.get(at..(at + length).min(bytes.len())) else {
        return String::new();
    };
    if unit == 1 {
        return slice.iter().map(|byte| *byte as char).collect();
    }
    slice
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .map(|value| char::from_u32(value as u32).unwrap_or('?'))
        .collect()
}

/// Text (or any attribute value) as SVG, with the characters that would end the text or the
/// attribute written as entities.
fn escape(text: &str, text_node: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if !text_node => out.push_str("&quot;"),
            '\'' if !text_node => out.push_str("&apos;"),
            // Text nodes keep their whitespace; attributes and text both lose control characters,
            // which are not valid XML and would end the SVG at the parser.
            '\n' | '\t' if !text_node => out.push(' '),
            character if (character as u32) < 0x20 => {}
            character => out.push(character),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Bitmaps: a `BITMAPINFO` and its pixels, which is what a `STRETCHDIB` record carries
// ---------------------------------------------------------------------------------------------

/// A rectangle-shaped record's box, in the order GDI writes it: bottom, right, top, left.
fn wmf_box(p: &[u8]) -> Option<(f32, f32, f32, f32)> {
    Some((
        i16_at(p, 6)? as f32,
        i16_at(p, 4)? as f32,
        i16_at(p, 2)? as f32,
        i16_at(p, 0)? as f32,
    ))
}

/// A `BITMAPINFO` and the pixels an EMF keeps apart: the header at one offset with a length of its
/// own, the pixels at another. A `DIB` is the two together, which is what the decoder reads, and a
/// record is free to leave a gap between them.
///
/// Both offsets count from the start of the record, and the parameters here start after its eight
/// byte header.
fn emf_dib(p: &[u8], bmi_at: u32, bmi_len: u32, bits_at: u32, bits_len: u32) -> Option<Vec<u8>> {
    let bmi_start = (bmi_at as usize).checked_sub(8)?;
    let bits_start = (bits_at as usize).checked_sub(8)?;
    let bmi = p.get(bmi_start..bmi_start.checked_add(bmi_len as usize)?)?;
    let bits = p.get(bits_start..bits_start.checked_add(bits_len as usize)?)?;
    let mut dib = Vec::with_capacity(bmi.len() + bits.len());
    dib.extend_from_slice(bmi);
    dib.extend_from_slice(bits);
    Some(dib)
}

/// The pixels of a `DIB`: a `BITMAPINFOHEADER` (or the older `BITMAPCOREHEADER`), a palette, and the
/// rows. Returns the picture's size in pixels.
fn dib_size(dib: &[u8]) -> Option<(f32, f32)> {
    let header = u32_at(dib, 0)?;
    if header == 12 {
        return Some((u16_at(dib, 4)? as f32, u16_at(dib, 6)? as f32));
    }
    let width = i32_at(dib, 4)? as f32;
    let height = i32_at(dib, 8)? as f32;
    Some((width.abs(), height.abs()))
}

/// A `DIB` as a PNG `data:` URL, or `None` when the compression or the bit depth is one this reader
/// does not take apart.
fn dib_png(dib: &[u8]) -> Option<String> {
    let (width, height, pixels) = dib_rgba(dib)?;
    let image = image::RgbaImage::from_raw(width, height, pixels)?;
    let mut png = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
    Some(format!("data:image/png;base64,{encoded}"))
}

/// The pixels of a `DIB` as RGBA, bottom row first, which is the order both a BMP and a metafile
/// record keep them in.
fn dib_rgba(dib: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    let header = u32_at(dib, 0)? as usize;
    let (width, height, bits, compression, colors_used, palette_entry, palette_at, data_at) =
        if header == 12 {
            // `BITMAPCOREHEADER`: 16 bit width and height, and a palette of three byte entries.
            let width = u16_at(dib, 4)? as i32;
            let height = u16_at(dib, 6)? as i32;
            let bits = u16_at(dib, 10)? as u32;
            let entries = if bits <= 8 { 1usize << bits } else { 0 };
            (
                width,
                height,
                bits,
                0u32,
                entries as u32,
                3usize,
                12usize,
                12 + entries * 3,
            )
        } else {
            let width = i32_at(dib, 4)?;
            let height = i32_at(dib, 8)?;
            let bits = u16_at(dib, 14)? as u32;
            let compression = u32_at(dib, 16)?;
            let colors_used = u32_at(dib, 32)?;
            let entries = if bits <= 8 {
                if colors_used != 0 {
                    colors_used as usize
                } else {
                    1usize << bits
                }
            } else {
                0
            };
            // A bitfield bitmap keeps its three masks where a palette would start.
            let masks = if compression == 3 {
                if bits == 16 {
                    12
                } else {
                    16
                }
            } else {
                0
            };
            let palette_at = header + masks;
            let data_at = palette_at + entries * 4;
            (
                width,
                height,
                bits,
                compression,
                entries as u32,
                4usize,
                palette_at,
                data_at,
            )
        };
    let _ = colors_used;
    if width <= 0 || height <= 0 || width > 20_000 || height > 20_000 {
        return None;
    }
    let bottom_up = height > 0;
    let (width, height) = (width as u32, height as u32);
    // Only the uncompressed forms are taken apart: RLE would need a decoder of its own, and the
    // picture is left out rather than drawn wrong.
    if !matches!(compression, 0 | 3) {
        return None;
    }
    let row_bytes = match bits {
        32 => width as usize * 4,
        24 => (width as usize * 3 + 3) & !3,
        16 => (width as usize * 2 + 3) & !3,
        8 => (width as usize + 3) & !3,
        4 => ((width as usize).div_ceil(2) + 3) & !3,
        1 => ((width as usize).div_ceil(8) + 3) & !3,
        _ => return None,
    };
    let needed = data_at + row_bytes * height as usize;
    if dib.len() < needed {
        return None;
    }
    // The masks of a bitfield bitmap, in the byte order the header keeps them.
    let (mask_r, mask_g, mask_b) = if compression == 3 {
        (
            u32_at(dib, palette_at)?,
            u32_at(dib, palette_at + 4)?,
            u32_at(dib, palette_at + 8)?,
        )
    } else {
        (0, 0, 0)
    };
    let mut out = vec![255u8; width as usize * height as usize * 4];
    for row in 0..height as usize {
        let source = data_at + row * row_bytes;
        let target_row = if bottom_up {
            height as usize - 1 - row
        } else {
            row
        };
        for column in 0..width as usize {
            let pixel = match bits {
                32 => {
                    let at = source + column * 4;
                    let value = u32_at(dib, at)?;
                    let (r, g, b) = if compression == 3 {
                        (shifted(value, mask_r), shifted(value, mask_g), shifted(value, mask_b))
                    } else {
                        (
                            (value & 0xFF) as u8,
                            ((value >> 8) & 0xFF) as u8,
                            ((value >> 16) & 0xFF) as u8,
                        )
                    };
                    [r, g, b, 255]
                }
                24 => {
                    let at = source + column * 3;
                    [
                        *dib.get(at + 2)?,
                        *dib.get(at + 1)?,
                        *dib.get(at)?,
                        255,
                    ]
                }
                16 => {
                    let at = source + column * 2;
                    let value = u16_at(dib, at)? as u32;
                    let (r, g, b) = if compression == 3 {
                        (
                            shifted(value, mask_r),
                            shifted(value, mask_g),
                            shifted(value, mask_b),
                        )
                    } else {
                        // 5-5-5 when the file does not say, which is what a 16 bit GDI bitmap is.
                        (
                            ((value >> 10) & 0x1F) as u8 * 8,
                            ((value >> 5) & 0x1F) as u8 * 8,
                            (value & 0x1F) as u8 * 8,
                        )
                    };
                    [r, g, b, 255]
                }
                8 | 4 | 1 => {
                    let index = match bits {
                        8 => *dib.get(source + column)? as usize,
                        4 => {
                            let byte = *dib.get(source + column / 2)?;
                            if column % 2 == 0 {
                                (byte >> 4) as usize
                            } else {
                                (byte & 0xF) as usize
                            }
                        }
                        _ => {
                            let byte = *dib.get(source + column / 8)?;
                            ((byte >> (7 - column % 8)) & 1) as usize
                        }
                    };
                    let at = palette_at + index * palette_entry;
                    let (r, g, b) = (
                        *dib.get(at + 2)?,
                        *dib.get(at + 1)?,
                        *dib.get(at)?,
                    );
                    [r, g, b, 255]
                }
                _ => return None,
            };
            let at = (target_row * width as usize + column) * 4;
            out[at..at + 4].copy_from_slice(&pixel);
        }
    }
    Some((width, height, out))
}

/// One channel of a masked pixel, scaled from its mask's width to eight bits.
fn shifted(value: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = (mask >> shift).count_ones();
    let raw = (value & mask) >> shift;
    if bits == 0 {
        return 0;
    }
    let scaled = if bits >= 8 {
        raw >> (bits - 8)
    } else {
        raw << (8 - bits)
    };
    scaled.min(255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_metafile_is_told_from_a_picture_the_reader_already_knows() {
        assert!(!is_metafile(b"\x89PNG\r\n\x1a\n"));
        assert!(!is_metafile(b""));
        // A placeable WMF: the magic and the rest of its twenty two byte header, then a standard
        // header of eighteen.
        let mut placeable = Vec::new();
        placeable.extend_from_slice(&PLACEABLE_MAGIC.to_le_bytes());
        placeable.extend_from_slice(&[0u8; 18]);
        placeable.extend_from_slice(&1u16.to_le_bytes());
        placeable.extend_from_slice(&9u16.to_le_bytes());
        placeable.extend_from_slice(&0x0300u16.to_le_bytes());
        placeable.extend_from_slice(&0u32.to_le_bytes());
        placeable.extend_from_slice(&0u16.to_le_bytes());
        placeable.extend_from_slice(&0u32.to_le_bytes());
        placeable.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(kind(&placeable), Some(Kind::Wmf(22)));
    }

    #[test]
    fn a_wmf_draws_the_shapes_its_records_name() {
        let bytes = wmf(&[
            // A rectangle-shaped record states bottom, right, top, left - not the other way round.
            record(0x041B, &i16s(&[70, 130, 10, 10])),
            record(0x0418, &i16s(&[170, 90, 100, 10])),
            record(0x0325, &join(&[&i16s(&[3]), &i16s(&[0, 200, 50, 240, 100, 200])])),
        ]);
        let url = data_url(&bytes).expect("a WMF with shapes draws");
        let svg = decode_svg(&url);
        assert!(svg.contains("<rect x=\"10.00\" y=\"10.00\" width=\"120.00\" height=\"60.00\""), "{svg}");
        assert!(svg.contains("<ellipse cx=\"50.00\" cy=\"135.00\" rx=\"40.00\" ry=\"35.00\""), "{svg}");
        assert!(svg.contains("<polyline points=\"0.00,200.00 50.00,240.00 100.00,200.00\""), "{svg}");
    }

    #[test]
    fn the_drawing_is_sized_to_what_it_drew() {
        // The pane scales the picture to the size the document asks for, so the SVG only has to say
        // where the ink is: a 1px pen centred on the outline is half a pixel past each edge.
        let bytes = wmf(&[record(0x041B, &i16s(&[70, 130, 10, 10]))]);
        let svg = decode_svg(&data_url(&bytes).expect("a rectangle draws"));
        assert!(svg.contains("viewBox=\"9.50 9.50 121.00 61.00\""), "{svg}");
        assert!(svg.contains("width=\"121\" height=\"61\""), "{svg}");
    }

    #[test]
    fn a_wmf_paints_with_the_brush_and_pen_it_selected() {
        // Create a green brush, select it, draw; then a null brush, select it, draw: the second
        // shape is an outline with no fill, which is how a document draws an unfilled box.
        let bytes = wmf(&[
            // A colour is a `COLORREF`: red in the low byte, then green, then blue.
            record(0x02FC, &[0, 0, 0x00, 0xC8, 0x00, 0x00]), // style 0, colour 0x0000C800
            record(0x012D, &i16s(&[0])),
            record(0x041B, &i16s(&[0, 0, 100, 100])),
            record(0x02FC, &[5, 0, 0, 0, 0, 0]), // style 5: no brush
            record(0x012D, &i16s(&[1])),
            record(0x041B, &i16s(&[0, 0, 100, 100])),
        ]);
        let svg = decode_svg(&data_url(&bytes).expect("shapes draw"));
        assert_eq!(svg.matches("fill=\"#00c800\"").count(), 1, "{svg}");
        assert_eq!(svg.matches("fill=\"none\"").count(), 1, "{svg}");
    }

    #[test]
    fn a_wmf_draws_its_text_where_the_record_puts_it() {
        let bytes = wmf(&[
            record(0x0209, &0x0000C8u32.to_le_bytes()),
            record(
                0x02FB,
                &join(&[
                    // The sixteen bit `LOGFONT`: height, width, escapement, orientation, weight,
                    // then the four one byte flags, then the face name as UTF-16.
                    &i16s(&[-20, 0, 0, 0, 600]),
                    &[0u8; 8],
                    &utf16("Arial"),
                ]),
            ),
            record(0x012D, &i16s(&[0])),
            // TEXTOUT: the count, the string padded to a word, then the corner as y and x.
            record(0x0521, &join(&[&[9u8, 0], b"Hello 42!", &[0u8], &i16s(&[200, 10])])),
        ]);
        let svg = decode_svg(&data_url(&bytes).expect("text draws"));
        assert!(svg.contains(">Hello 42!</text>"), "{svg}");
        assert!(svg.contains("fill=\"#c80000\""), "{svg}");
        assert!(svg.contains("x=\"10.00\" y=\"200.00\""), "{svg}");
        assert!(svg.contains("font-size=\"15.00px\""), "{svg}");
        assert!(svg.contains("font-family=\"Arial, sans-serif\""), "{svg}");
    }

    #[test]
    fn an_emf_draws_the_records_a_windows_writer_emits() {
        let bytes = emf(&[
            (43, i32s(&[0, 0, 100, 60])),          // RECTANGLE
            (42, i32s(&[0, 80, 80, 160])),         // ELLIPSE
            (86, emf_points16(&[0, 0, 10, 10], &[(0, 0), (100, 0), (50, 60)])),
            (37, 0x80000004u32.to_le_bytes().to_vec()), // SELECTOBJECT: the black stock brush
            (43, i32s(&[0, 0, 20, 20])),
        ]);
        let svg = decode_svg(&data_url(&bytes).expect("an EMF with shapes draws"));
        assert!(svg.contains("<rect x=\"0.00\" y=\"0.00\" width=\"100.00\" height=\"60.00\""), "{svg}");
        assert!(svg.contains("<ellipse"), "{svg}");
        assert!(svg.contains("<polygon points=\"0.00,0.00 100.00,0.00 50.00,60.00\""), "{svg}");
        assert!(svg.contains("fill=\"#000000\""), "{svg}");
    }

    #[test]
    fn a_metafile_that_is_one_bitmap_is_that_bitmap() {
        // A pasted screenshot is a bitmap inside a metafile; wrapping it in an SVG would base64 it
        // twice over.
        let bytes = wmf(&[record(
            0x0F43,
            &join(&[
                // A raster op, the source size and corner, the destination size and corner - and
                // then the bitmap, twenty bytes in.
                &0x00CC0020u32.to_le_bytes(),
                &i16s(&[16, 24, 0, 0, 16, 24, 0, 0]),
                &dib(2, 2),
            ]),
        )]);
        let url = data_url(&bytes).expect("a bitmap draws");
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
    }

    #[test]
    fn a_metafile_with_a_bitmap_and_shapes_keeps_both() {
        let bytes = wmf(&[
            record(0x041B, &i16s(&[0, 0, 10, 10])),
            record(
                0x0F43,
                &join(&[
                    &0x00CC0020u32.to_le_bytes(),
                    &i16s(&[16, 24, 0, 0, 16, 24, 50, 50]),
                    &dib(2, 2),
                ]),
            ),
        ]);
        let svg = decode_svg(&data_url(&bytes).expect("both draw"));
        assert!(svg.contains("<rect"), "{svg}");
        assert!(svg.contains("<image x=\"50.00\" y=\"50.00\" width=\"24.00\" height=\"16.00\""), "{svg}");
        assert!(svg.contains("href=\"data:image/png;base64,"), "{svg}");
    }

    #[test]
    fn a_bitmap_is_taken_apart_whatever_its_depth() {
        // 1, 4 and 8 bits an entry are indices into a palette; 24 and 32 bits are the colours.
        let (width, height, pixels) = dib_rgba(&dib(1, 1)).expect("a 1 bit dib");
        assert_eq!((width, height), (1, 1));
        assert_eq!(&pixels[0..3], &[255, 255, 255]);

        let core = {
            // One bit an entry: two palette entries of three bytes, then one byte a row.
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&12u32.to_le_bytes());
            bytes.extend_from_slice(&1i16.to_le_bytes());
            bytes.extend_from_slice(&1i16.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&1u16.to_le_bytes());
            bytes.extend_from_slice(&[0, 0, 0, 255, 255, 0]); // black, yellow
            bytes.extend_from_slice(&[0, 0, 0, 0]); // one bit, padded to four bytes
            bytes
        };
        let (_, _, pixels) = dib_rgba(&core).expect("a core header dib");
        assert_eq!(&pixels[0..3], &[0, 0, 0]);
    }

    #[test]
    fn a_bitmap_this_reader_cannot_take_apart_is_left_out() {
        let mut uncompressed = dib(1, 1);
        uncompressed[16..20].copy_from_slice(&1u32.to_le_bytes()); // BI_RLE8
        assert!(dib_rgba(&uncompressed).is_none());
    }

    #[test]
    fn an_unknown_record_is_skipped_by_its_own_length() {
        // Nothing after a record this reader does not know may be lost: a stream that walks off the
        // end of one record reads the next record's bytes as its own.
        let bytes = emf(&[
            (43, i32s(&[0, 0, 10, 10])),
            (122, vec![0; 40]), // a record from a future Windows version
            (43, i32s(&[20, 20, 40, 40])),
        ]);
        let svg = decode_svg(&data_url(&bytes).expect("both rectangles draw"));
        // The two rectangles, and the sheet the SVG paints behind them.
        assert_eq!(svg.matches("<rect").count(), 3, "{svg}");
    }

    #[test]
    fn a_stream_that_stops_in_the_middle_draws_what_came_before() {
        let mut bytes = emf(&[(43, i32s(&[0, 0, 10, 10])), (43, i32s(&[20, 20, 40, 40]))]);
        // An eight byte header, a twenty four byte record, then four bytes of the next one: its
        // length says it is longer than what is left, so the stream ends there.
        bytes.truncate(88 + 24 + 12);
        let svg = decode_svg(&data_url(&bytes).expect("the first rectangle still draws"));
        // The one rectangle, and the sheet the SVG paints behind it.
        assert_eq!(svg.matches("<rect").count(), 2, "{svg}");
    }

    // ---- building records here, which is the only way to exercise a byte format ----

    /// One WMF record: its size in words, its function, then its parameters.
    fn record(function: u16, parameters: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; 6];
        let words = (parameters.len() + 6) / 2;
        out[0..4].copy_from_slice(&(words as u32).to_le_bytes());
        out[4..6].copy_from_slice(&function.to_le_bytes());
        out.extend_from_slice(parameters);
        if out.len() % 2 == 1 {
            out.push(0);
        }
        out
    }

    /// A whole WMF: a standard header, then the records, then `EOF`.
    fn wmf(records: &[Vec<u8>]) -> Vec<u8> {
        let mut body = Vec::new();
        for record in records {
            body.extend_from_slice(record);
        }
        body.extend_from_slice(&record(0x0000, &[]));
        let words = (body.len() + 18) / 2;
        let mut out = Vec::new();
        out.extend_from_slice(&1u16.to_le_bytes()); // a metafile in memory
        out.extend_from_slice(&9u16.to_le_bytes());
        out.extend_from_slice(&0x0300u16.to_le_bytes());
        out.extend_from_slice(&(words as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // objects
        out.extend_from_slice(&0u32.to_le_bytes()); // the largest record
        out.extend_from_slice(&0u16.to_le_bytes()); // members
        out.extend_from_slice(&body);
        out
    }

    /// Record parameters out of pieces that are not all the same type: a record mixes words, a
    /// colour, and a string, and Rust will not join an array of them without them being slices.
    fn join(pieces: &[&[u8]]) -> Vec<u8> {
        pieces.concat()
    }

    /// Some `i16`s, little endian, which is how a record's parameters are written.
    fn i16s(values: &[i32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| (*value as i16).to_le_bytes())
            .collect()
    }

    /// A face name as a `LOGFONTW` keeps it.
    fn utf16(text: &str) -> Vec<u8> {
        let mut out: Vec<u8> = text
            .encode_utf16()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        while out.len() < 64 {
            out.push(0);
        }
        out
    }

    fn i32s(values: &[i32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    /// A whole EMF: a header, the records, then `EOF`.
    fn emf(records: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0u8; 88];
        out[0..4].copy_from_slice(&1u32.to_le_bytes());
        out[4..8].copy_from_slice(&88u32.to_le_bytes());
        out[40..44].copy_from_slice(&EMF_SIGNATURE.to_le_bytes());
        for (kind, parameters) in records {
            let size = parameters.len() + 8;
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(&(size as u32).to_le_bytes());
            out.extend_from_slice(parameters);
        }
        let size = 16usize;
        out.extend_from_slice(&14u32.to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out
    }

    /// The parameters of `EMR_POLYGON16`: a bounds rectangle, then the count, then the points.
    fn emf_points16(bounds: &[i32], points: &[(i32, i32)]) -> Vec<u8> {
        let mut out = i32s(bounds);
        out.extend_from_slice(&(points.len() as u32).to_le_bytes());
        for (x, y) in points {
            out.extend_from_slice(&i16s(&[*x, *y]));
        }
        out
    }

    /// A small uncompressed `DIB` of one colour, 24 bits a pixel, with every row padded the way a
    /// bitmap's rows are.
    fn dib(width: i32, height: i32) -> Vec<u8> {
        let mut out = vec![0u8; 40];
        out[0..4].copy_from_slice(&40u32.to_le_bytes());
        out[4..8].copy_from_slice(&width.to_le_bytes());
        out[8..12].copy_from_slice(&height.to_le_bytes());
        out[12..14].copy_from_slice(&1u16.to_le_bytes());
        out[14..16].copy_from_slice(&24u16.to_le_bytes());
        let row = (width as usize * 3 + 3) & !3;
        for _ in 0..height {
            out.extend(std::iter::repeat_n(0xFFu8, row));
        }
        out
    }

    /// A `data:` URL's SVG, for the assertions above.
    fn decode_svg(url: &str) -> String {
        let encoded = url
            .strip_prefix("data:image/svg+xml;base64,")
            .unwrap_or_else(|| panic!("not an SVG: {}", &url[..40.min(url.len())]));
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("base64"),
        )
        .expect("utf-8")
    }
}
