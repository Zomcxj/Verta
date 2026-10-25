//! The pure arithmetic of screenshots: clamping the selection, cropping pixels, file
//! names, timestamps.
//!
//! Kept separate so it can be unit-tested: moving pixels around and converting
//! coordinates is exactly where mistakes are easiest to make and hardest to see.

/// A rectangle in physical pixels, relative to the top-left of the full screenshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Minimum side length of a selection: a shaky hand must not produce a 1×1 image.
pub const MIN_SIDE: u32 = 8;

/// Clamp the selection from the frontend to the screen and normalize its direction.
///
/// The frontend sends "anchor point + drag delta", so dragging backwards yields negative
/// width/height; this normalizes everything to a top-left corner plus positive extents.
/// Anything smaller than [`MIN_SIDE`] or entirely off-screen counts as no selection
/// (None); the caller decides how to tell the user.
pub fn clamp_selection(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    shot_width: u32,
    shot_height: u32,
) -> Option<Rect> {
    let right = x.saturating_add(width);
    let bottom = y.saturating_add(height);
    let left = x.min(right).max(0);
    let top = y.min(bottom).max(0);
    let right = x.max(right).min(shot_width as i32);
    let bottom = y.max(bottom).min(shot_height as i32);
    if right <= left || bottom <= top {
        return None;
    }
    let rect = Rect {
        x: left,
        y: top,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    };
    (rect.width >= MIN_SIDE && rect.height >= MIN_SIDE).then_some(rect)
}

/// Crop the selected block out of the full-screen pixels.
///
/// The rows are stored top-down (the DIB is already read top-down when capturing), so
/// the row order needs no flipping.
pub fn crop_rgba(rgba: &[u8], shot_width: u32, shot_height: u32, rect: Rect) -> Option<Vec<u8>> {
    if rect.x < 0 || rect.y < 0 {
        return None;
    }
    if rect.x as u32 + rect.width > shot_width || rect.y as u32 + rect.height > shot_height {
        return None;
    }
    let stride = shot_width as usize * 4;
    let row = rect.width as usize * 4;
    let mut out = Vec::with_capacity(row * rect.height as usize);
    for line in 0..rect.height as usize {
        let start = (rect.y as usize + line) * stride + rect.x as usize * 4;
        out.extend_from_slice(&rgba[start..start + row]);
    }
    Some(out)
}

/// A local timestamp for file names: `2026-10-21-183012`.
pub fn stamp(year: u16, month: u16, day: u16, hour: u16, minute: u16, second: u16) -> String {
    format!("{year:04}-{month:02}-{day:02}-{hour:02}{minute:02}{second:02}")
}

/// Round the four corners: pixels outside the arc become transparent.
///
/// The radius is in physical pixels (the UI adjusts it in CSS pixels and the caller has
/// already converted). A radius beyond half the short side means nothing (it is still
/// just a rounded corner), so it is clamped; a radius of 0 changes nothing.
///
/// Only alpha is touched: PNG supports transparency, so rounding loses no pixel content;
/// it just clears the corner blocks.
pub fn apply_corner_radius(rgba: &mut [u8], width: u32, height: u32, radius: u32) {
    if radius == 0 || width == 0 || height == 0 {
        return;
    }
    let radius = radius.min(width.min(height) / 2) as f32;
    if radius <= 0.0 {
        return;
    }
    let max_x = width as f32 - 0.5;
    let max_y = height as f32 - 0.5;
    for y in 0..height {
        for x in 0..width {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            // The center of each corner arc; skip pixels outside all four (the middle
            // rows/columns of the edges must not be cleared).
            let (cx, cy) = if px < radius && py < radius {
                (radius, radius)
            } else if px > max_x - radius && py < radius {
                (max_x - radius, radius)
            } else if px < radius && py > max_y - radius {
                (radius, max_y - radius)
            } else if px > max_x - radius && py > max_y - radius {
                (max_x - radius, max_y - radius)
            } else {
                continue;
            };
            let (dx, dy) = (px - cx, py - cy);
            if dx * dx + dy * dy > radius * radius {
                let index = (y as usize * width as usize + x as usize) * 4 + 3;
                rgba[index] = 0;
            }
        }
    }
}

/// `Verta-<stamp>.png`; a second shot in the same second becomes `-2`, `-3`, so
/// the previous one is never overwritten.
///
/// The prefix is the app's name rather than the word `Screenshot`, which is what
/// every other screenshot tool writes: the folder this lands in also collects
/// Windows' own shots, and the name should say which of them is Verta's.
///
/// `taken` is supplied by the caller (which asks the filesystem), so this stays
/// unit-testable.
pub fn screenshot_file_name(stamp: &str, taken: impl Fn(&str) -> bool) -> String {
    let first = format!("Verta-{stamp}.png");
    if !taken(&first) {
        return first;
    }
    for n in 2..1000 {
        let name = format!("Verta-{stamp}-{n}.png");
        if !taken(&name) {
            return name;
        }
    }
    // A thousand screenshots in one second: stop picking, let the write report the error.
    format!("Verta-{stamp}-overflow.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forward_drag_comes_back_as_is() {
        let rect = clamp_selection(10, 20, 100, 50, 2560, 1440).expect("该收下");
        assert_eq!(
            rect,
            Rect {
                x: 10,
                y: 20,
                width: 100,
                height: 50
            }
        );
    }

    #[test]
    fn a_backward_drag_gives_the_same_box() {
        // Dragging from (110,70) back to (10,20): negative extents, so the result should
        // equal the forward drag's box.
        let rect = clamp_selection(110, 70, -100, -50, 2560, 1440).expect("该收下");
        assert_eq!(
            rect,
            Rect {
                x: 10,
                y: 20,
                width: 100,
                height: 50
            }
        );
    }

    #[test]
    fn a_selection_dragged_past_the_edge_is_clamped() {
        let rect = clamp_selection(-30, -40, 200, 100, 2560, 1440).expect("该收下");
        assert_eq!(
            rect,
            Rect {
                x: 0,
                y: 0,
                width: 170,
                height: 60
            }
        );
        let rect = clamp_selection(2540, 1430, 100, 100, 2560, 1440).expect("该收下");
        assert_eq!(
            rect,
            Rect {
                x: 2540,
                y: 1430,
                width: 20,
                height: 10
            }
        );
    }

    #[test]
    fn a_tiny_or_far_away_selection_is_not_a_selection() {
        for (x, y, w, h) in [
            (-50, 0, 20, 200),
            (0, 0, 5, 200),
            (0, 0, 200, 5),
            (3000, 0, 100, 100),
        ] {
            assert!(
                clamp_selection(x, y, w, h, 2560, 1440).is_none(),
                "({x},{y},{w},{h}) 不该算选中"
            );
        }
    }

    #[test]
    fn the_crop_is_exactly_the_selected_block() {
        // A 3×2 image with each pixel numbered: R channel is the column, G the row.
        let mut src = Vec::new();
        for y in 0..2u8 {
            for x in 0..3u8 {
                src.extend_from_slice(&[x, y, 0, 255]);
            }
        }
        let out = crop_rgba(
            &src,
            3,
            2,
            Rect {
                x: 1,
                y: 1,
                width: 2,
                height: 1,
            },
        )
        .expect("该抠出来");
        // Two pixels starting at row 1, column 1: (1,1) and (2,1).
        assert_eq!(out, vec![1, 1, 0, 255, 2, 1, 0, 255]);
    }

    #[test]
    fn a_crop_that_leaves_the_image_is_none() {
        let src = vec![0u8; 3 * 2 * 4];
        let rect = Rect {
            x: 2,
            y: 1,
            width: 2,
            height: 1,
        };
        assert!(crop_rgba(&src, 3, 2, rect).is_none());
    }

    #[test]
    fn the_stamp_pads_every_field_to_a_fixed_width() {
        assert_eq!(stamp(2026, 10, 21, 9, 5, 7), "2026-10-21-090507");
        assert_eq!(stamp(2026, 1, 1, 0, 0, 0), "2026-01-01-000000");
    }

    #[test]
    fn a_corner_radius_only_eats_the_corners() {
        let (w, h) = (8u32, 8u32);
        let mut pixels = vec![255u8; w as usize * h as usize * 4];
        let alpha = |buf: &[u8], x: usize, y: usize| buf[(y * w as usize + x) * 4 + 3];

        apply_corner_radius(&mut pixels, w, h, 3);
        // The corners are cleared; edge midpoints and the center stay.
        assert_eq!(alpha(&pixels, 0, 0), 0);
        assert_eq!(alpha(&pixels, 7, 0), 0);
        assert_eq!(alpha(&pixels, 0, 7), 0);
        assert_eq!(alpha(&pixels, 7, 7), 0);
        assert_eq!(alpha(&pixels, 4, 0), 255);
        assert_eq!(alpha(&pixels, 0, 4), 255);
        assert_eq!(alpha(&pixels, 4, 4), 255);
        // Not one byte of colour may change; only alpha.
        assert_eq!(&pixels[0..3], &[255, 255, 255]);
    }

    #[test]
    fn a_zero_radius_changes_nothing() {
        let mut pixels = vec![7u8; 4 * 4 * 4];
        let before = pixels.clone();
        apply_corner_radius(&mut pixels, 4, 4, 0);
        assert_eq!(pixels, before);
    }

    #[test]
    fn a_radius_bigger_than_half_the_short_side_is_clamped() {
        // 100 on an 8×4 image: half the short side is 2, so it behaves like 2 and must not
        // clear the whole image.
        let mut pixels = vec![255u8; 8 * 4 * 4];
        apply_corner_radius(&mut pixels, 8, 4, 100);
        let alpha = |x: usize, y: usize| pixels[(y * 8 + x) * 4 + 3];
        assert_eq!(alpha(0, 0), 0, "角上该被抠掉");
        assert_eq!(alpha(4, 2), 255, "正中间必须留着");
        assert_eq!(alpha(4, 0), 255, "上边中点留着");
    }

    #[test]
    fn a_second_shot_in_the_same_second_does_not_overwrite_the_first() {
        // Absent first, then "already taken", then absent again; the result is -2.
        let taken = |name: &str| name == "Verta-2026-10-21-183012.png";
        assert_eq!(
            screenshot_file_name("2026-10-21-183012", taken),
            "Verta-2026-10-21-183012-2.png"
        );
        let none = |_: &str| false;
        assert_eq!(
            screenshot_file_name("2026-10-21-183012", none),
            "Verta-2026-10-21-183012.png"
        );
    }
}
