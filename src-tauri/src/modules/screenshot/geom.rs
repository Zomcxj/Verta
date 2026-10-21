//! 截图里那些纯算数：选区收边、抠图、文件名、时间戳。
//!
//! 单独放出来是为了能单测——像素搬来搬去、坐标换来换去，正是最容易错又最难肉眼发现的地方。

/// 一块矩形，物理像素，相对整张截图左上角。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 选区最小边长：手指抖一下不该产生一张 1×1 的图。
pub const MIN_SIDE: u32 = 8;

/// 把前端给的选区收进整屏范围，顺带把方向理正。
///
/// 前端给的是「按下点 + 拖动量」，往回拖时宽高会是负的；这里统一成左上角 + 正宽高。
/// 小于 [`MIN_SIDE`] 或整个落在画面外，都当没选（None）——由调用方决定怎么跟用户说。
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

/// 从整屏像素里抠出选区那一块。
///
/// 像素是自上而下的行序（抓屏时就把 DIB 读成自上而下了），所以行序不用翻。
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

/// 本地时间戳，给文件名用：`2026-10-21-183012`。
pub fn stamp(year: u16, month: u16, day: u16, hour: u16, minute: u16, second: u16) -> String {
    format!("{year:04}-{month:02}-{day:02}-{hour:02}{minute:02}{second:02}")
}

/// 把四角抠圆：圆角外的像素变透明。
///
/// 半径按物理像素给（界面上是按 CSS 像素调的，调用方已经折算过）。半径超过短边一半就没有意义了
/// （再大也只是个圆角），这里夹一下；半径为 0 就原样不动。
///
/// 只动 alpha：PNG 支持透明，所以「圆角」这件事不损失任何像素内容，抠掉的只是角上那几块。
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
            // 四个角各自的圆心：哪个角都不是就跳过（边上中间那几列/行本来就不该被抠）。
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

/// `Screenshot-<戳>.png`；同一秒里再截一张就 `-2`、`-3`，绝不把上一张盖掉。
///
/// `taken` 由调用方给（真的去问文件系统），这样这一段能单测。
pub fn screenshot_file_name(stamp: &str, taken: impl Fn(&str) -> bool) -> String {
    let first = format!("Screenshot-{stamp}.png");
    if !taken(&first) {
        return first;
    }
    for n in 2..1000 {
        let name = format!("Screenshot-{stamp}-{n}.png");
        if !taken(&name) {
            return name;
        }
    }
    // 一千张同一秒的截图：那就不挑了，让写入去报错。
    format!("Screenshot-{stamp}-overflow.png")
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
        // 从 (110,70) 往回拖到 (10,20)：宽高是负的，结果该和正向那块一样。
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
        // 3×2 的图，每个像素编上号：R 通道是列、G 通道是行。
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
        // 第 1 行、第 1 列起两个像素：(1,1) 与 (2,1)。
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
        // 四角抠掉，边中与正中留着。
        assert_eq!(alpha(&pixels, 0, 0), 0);
        assert_eq!(alpha(&pixels, 7, 0), 0);
        assert_eq!(alpha(&pixels, 0, 7), 0);
        assert_eq!(alpha(&pixels, 7, 7), 0);
        assert_eq!(alpha(&pixels, 4, 0), 255);
        assert_eq!(alpha(&pixels, 0, 4), 255);
        assert_eq!(alpha(&pixels, 4, 4), 255);
        // 颜色一个字节都不该动，只动 alpha。
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
        // 8×4 的图上给 100：短边一半是 2，所以跟给 2 一样，不该把整张图抠没。
        let mut pixels = vec![255u8; 8 * 4 * 4];
        apply_corner_radius(&mut pixels, 8, 4, 100);
        let alpha = |x: usize, y: usize| pixels[(y * 8 + x) * 4 + 3];
        assert_eq!(alpha(0, 0), 0, "角上该被抠掉");
        assert_eq!(alpha(4, 2), 255, "正中间必须留着");
        assert_eq!(alpha(4, 0), 255, "上边中点留着");
    }

    #[test]
    fn a_second_shot_in_the_same_second_does_not_overwrite_the_first() {
        // 第一次没有，第二次「已有」，第三次又没有 —— 该拿到 -2。
        let taken = |name: &str| name == "Screenshot-2026-10-21-183012.png";
        assert_eq!(
            screenshot_file_name("2026-10-21-183012", taken),
            "Screenshot-2026-10-21-183012-2.png"
        );
        let none = |_: &str| false;
        assert_eq!(
            screenshot_file_name("2026-10-21-183012", none),
            "Screenshot-2026-10-21-183012.png"
        );
    }
}
