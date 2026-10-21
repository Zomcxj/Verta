//! PNG 编码。
//!
//! 用 `image`（本来就在依赖树里），只开 `png` 一个 feature：截图的产物就是要一张 PNG 文件，
//! 别的格式用不上，也不值得为此多拉一堆解码器。

/// RGBA 像素编码成 PNG 字节。存盘就是这一份（覆盖窗口显示走 IPC，不经编码）。
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(format!(
            "像素数量不匹配：收到 {} 字节，按 {width}×{height} 应为 {expected}",
            rgba.len()
        ));
    }
    let image = image::RgbaImage::from_raw(width, height, rgba.to_vec())
        .ok_or_else(|| format!("无法创建 {width}×{height} 的图像"))?;
    let mut out = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("编码 PNG 失败：{e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_encoded_bytes_are_a_png_that_reads_back() {
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 255, // 两个像素：红、绿
        ];
        let png = encode_png(&rgba, 2, 1).expect("该编出来");
        // PNG 的幻数：89 50 4E 47 0D 0A 1A 0A。
        assert_eq!(&png[..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let back = image::load_from_memory(&png)
            .expect("该能读回去")
            .to_rgba8();
        assert_eq!(back.dimensions(), (2, 1));
        assert_eq!(back.into_raw(), rgba);
    }

    #[test]
    fn a_size_that_does_not_match_the_pixels_is_an_error() {
        let err = encode_png(&[0, 0, 0, 255], 10, 10).expect_err("该报错");
        assert!(err.contains("像素数量不匹配"), "实际是：{err}");
    }
}
