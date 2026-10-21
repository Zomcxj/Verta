//! 抓屏本身。
//!
//! Windows 走 GDI，一次抓下整块虚拟桌面（所有显示器拼起来的那块）。别的平台先在这儿挡回去——
//! 覆盖窗口、裁剪、Screenshots 目录这条线是照着 Windows 做的，没在别的平台上设计过，不该假装能跑。

/// 抓下来的一整块画面。
pub struct RawShot {
    /// RGBA，行序自上而下。
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// 这块画面的左上角在屏幕坐标里的位置（副屏在左时会是负的）。
    pub origin: (i32, i32),
}

/// GDI 给的是 BGRA，而且屏幕上抓下来的 alpha 是垃圾值 —— 顺手补成不透明。
///
/// 不补的话，存成 PNG 是半透明的，进了剪贴板也一样。
pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for px in bgra.as_chunks::<4>().0 {
        out.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    out
}

#[cfg(windows)]
mod win {
    use super::{bgra_to_rgba, RawShot};
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HDC, SRCCOPY,
    };
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
        SM_YVIRTUALSCREEN,
    };

    /// 抓整块虚拟桌面。
    pub fn capture_virtual_screen() -> Result<RawShot, String> {
        let (x, y, w, h) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if w <= 0 || h <= 0 {
            return Err(format!("量不出屏幕尺寸（{w}×{h}）"));
        }
        unsafe { grab(x, y, w, h) }
    }

    /// 本地时间戳。文件名按本地时间排 —— 用户找图时看的就是本机时间。
    pub fn now_stamp() -> String {
        let mut now: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut now) };
        crate::modules::screenshot::geom::stamp(
            now.wYear,
            now.wMonth,
            now.wDay,
            now.wHour,
            now.wMinute,
            now.wSecond,
        )
    }

    /// 真正的抓屏。DC 与位图必须自己收干净，所以每一步失败都照着同一条路退出。
    unsafe fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<RawShot, String> {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("拿不到屏幕 DC".into());
        }
        let mem = CreateCompatibleDC(screen);
        if mem.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("建兼容 DC 失败".into());
        }
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        if bitmap.is_null() {
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("建兼容位图失败".into());
        }
        let previous = SelectObject(mem, bitmap);

        let pixels = read_pixels(mem, bitmap, screen, x, y, w, h);

        SelectObject(mem, previous);
        DeleteObject(bitmap);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);

        pixels.map(|rgba| RawShot {
            rgba,
            width: w as u32,
            height: h as u32,
            origin: (x, y),
        })
    }

    unsafe fn read_pixels(
        mem: HDC,
        bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
        screen: HDC,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
    ) -> Result<Vec<u8>, String> {
        if BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY) == 0 {
            return Err("BitBlt 没把画面拷过来".into());
        }
        // 负高度 = 自上而下的行序：省一次翻转，也跟后面裁剪假定的一致。
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        let mut bgra = vec![0u8; w as usize * h as usize * 4];
        let lines = GetDIBits(
            mem,
            bitmap,
            0,
            h as u32,
            bgra.as_mut_ptr() as *mut _,
            &mut info,
            DIB_RGB_COLORS,
        );
        if lines == 0 {
            return Err("GetDIBits 没读到像素".into());
        }
        Ok(bgra_to_rgba(&bgra))
    }
}

#[cfg(windows)]
pub use win::{capture_virtual_screen, now_stamp};

#[cfg(not(windows))]
pub fn capture_virtual_screen() -> Result<RawShot, String> {
    Err("区域截图目前只在 Windows 上做了（抓屏走 GDI）".into())
}

#[cfg(not(windows))]
pub fn now_stamp() -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_is_swapped_into_rgba_and_made_opaque() {
        // GDI 抓下来的 alpha 是垃圾值（这里给 0），出来必须是不透明的。
        assert_eq!(
            bgra_to_rgba(&[1, 2, 3, 0, 10, 20, 30, 0]),
            vec![3, 2, 1, 255, 30, 20, 10, 255]
        );
    }
}
