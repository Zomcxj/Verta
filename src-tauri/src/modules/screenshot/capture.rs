//! The screen grab itself.
//!
//! Windows goes through GDI and grabs the whole virtual desktop (all monitors stitched
//! together) in one go. Other platforms are turned away here: the overlay window,
//! cropping and the Screenshots directory were built for Windows and never designed
//! elsewhere, so they must not pretend to work.

/// One full grab of the screen.
pub struct RawShot {
    /// RGBA, rows stored top-down.
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The physical-pixel extent of the virtual desktop (all monitors stitched together) in
/// screen coordinates.
///
/// Both the grab and the overlay window read it from here so they share one extent, which
/// is what makes the selection coordinates line up. `x` is negative when a secondary
/// monitor sits left of the primary one.
pub struct ScreenBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// GDI hands back BGRA, and the alpha grabbed from the screen is junk; fill it in as
/// opaque.
///
/// Otherwise the PNG ends up semi-transparent, and so does the clipboard image.
pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for px in bgra.as_chunks::<4>().0 {
        out.extend_from_slice(&[px[2], px[1], px[0], 255]);
    }
    out
}

#[cfg(windows)]
mod win {
    use super::{bgra_to_rgba, RawShot, ScreenBounds};
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

    /// The physical-pixel extent of the virtual desktop.
    pub fn virtual_screen_bounds() -> Result<ScreenBounds, String> {
        let (x, y, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        if width <= 0 || height <= 0 {
            return Err(format!("无法获取屏幕尺寸（{width}×{height}）"));
        }
        Ok(ScreenBounds {
            x,
            y,
            width: width as u32,
            height: height as u32,
        })
    }

    /// Grab the whole virtual desktop.
    pub fn capture_virtual_screen() -> Result<RawShot, String> {
        let screen = virtual_screen_bounds()?;
        unsafe {
            grab(
                screen.x,
                screen.y,
                screen.width as i32,
                screen.height as i32,
            )
        }
    }

    /// A local timestamp. File names sort by local time, which is the time the user
    /// sees when looking for an image.
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

    /// The actual grab. The DC and bitmap must be cleaned up by us, so every failure exits
    /// along the same path.
    unsafe fn grab(x: i32, y: i32, w: i32, h: i32) -> Result<RawShot, String> {
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("无法获取屏幕 DC".into());
        }
        let mem = CreateCompatibleDC(screen);
        if mem.is_null() {
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("无法创建兼容 DC".into());
        }
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        if bitmap.is_null() {
            DeleteDC(mem);
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("无法创建兼容位图".into());
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
            return Err("BitBlt 拷贝屏幕失败".into());
        }
        // A negative height means top-down rows: saves a flip and matches what cropping
        // later assumes.
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
            return Err("GetDIBits 未读取到像素".into());
        }
        Ok(bgra_to_rgba(&bgra))
    }
}

#[cfg(windows)]
pub use win::{capture_virtual_screen, now_stamp, virtual_screen_bounds};

#[cfg(not(windows))]
pub fn virtual_screen_bounds() -> Result<ScreenBounds, String> {
    Err("区域截图目前仅支持 Windows（抓屏依赖 GDI）".into())
}

#[cfg(not(windows))]
pub fn capture_virtual_screen() -> Result<RawShot, String> {
    Err("区域截图目前仅支持 Windows（抓屏依赖 GDI）".into())
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
        // The alpha GDI grabs is junk (0 here); the result must be opaque.
        assert_eq!(
            bgra_to_rgba(&[1, 2, 3, 0, 10, 20, 30, 0]),
            vec![3, 2, 1, 255, 30, 20, 10, 255]
        );
    }
}
