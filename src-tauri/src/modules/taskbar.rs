//! Taskbar behaviour of the main window.
//!
//! Two things the OS, not the page, decides:
//!
//! - **Whether the window has a taskbar button at all.** Windows only puts one
//!   there for a window it considers a main window; `WS_EX_TOOLWINDOW` (which
//!   Tauri sets for some window kinds) hides it. A setting lets the user keep it
//!   pinned into the taskbar as a permanent entry, which is what people who use
//!   the app all day expect from a desktop tool.
//! - **Alerting the user while they are looking elsewhere.** When an agent asks
//!   for input or finishes, the taskbar button flashes. `FlashWindowEx` is the
//!   only supported way to do that: drawing a badge or colouring the button needs
//!   private shell APIs.

/// What the taskbar button should do to get attention.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskbarAttention {
    /// Flash until the window is brought to the front by the user.
    Ask,
    /// Flash a few times and stop: a finished job is not urgent.
    Done,
    /// Stop flashing.
    Stop,
}

#[cfg(windows)]
mod imp {
    use super::TaskbarAttention;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FLASHW_ALL, FLASHWINFO, FLASHW_TIMERNOFG, FlashWindowEx, GetWindowLongPtrW, GWL_EXSTYLE,
        SetWindowLongPtrW, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    /// How many times "done" flashes. Enough to notice, few enough to ignore.
    const DONE_FLASH_COUNT: u32 = 5;
    const DONE_FLASH_MS: u32 = 400;

    pub fn set_taskbar_visible(window: &tauri::WebviewWindow, visible: bool) -> Result<(), String> {
        let hwnd = hwnd_of(window)?;
        // The button is the shell's call, and the style bits are what it reads:
        // a tool window gets none, an app window keeps one. Tauri's
        // `set_skip_taskbar` then tells the already-open taskbar to add or
        // delete the tab, so the change shows up without restarting the window.
        if visible {
            set_style(hwnd, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW)?;
        } else {
            set_style(hwnd, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW)?;
        }
        window
            .set_skip_taskbar(!visible)
            .map_err(|e| format!("set_skip_taskbar failed: {e}"))
    }

    pub fn flash(window: &tauri::WebviewWindow, attention: TaskbarAttention) -> Result<(), String> {
        let hwnd = hwnd_of(window)?;
        let mut info = FLASHWINFO {
            cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
            hwnd,
            dwFlags: FLASHW_ALL,
            uCount: DONE_FLASH_COUNT,
            dwTimeout: DONE_FLASH_MS,
        };
        match attention {
            // TIMERNOFG keeps flashing until the window comes to the foreground,
            // which is what "the agent is waiting for you" should do.
            TaskbarAttention::Ask => info.dwFlags |= FLASHW_TIMERNOFG,
            TaskbarAttention::Done => info.uCount = DONE_FLASH_COUNT,
            TaskbarAttention::Stop => {
                info.dwFlags = windows_sys::Win32::UI::WindowsAndMessaging::FLASHW_STOP;
                info.uCount = 0;
            }
        }
        unsafe { FlashWindowEx(&info) };
        Ok(())
    }

    fn hwnd_of(window: &tauri::WebviewWindow) -> Result<HWND, String> {
        // Same accessor `vibrancy.rs` uses: Tauri hands back the raw HWND.
        let hwnd = window.hwnd().map_err(|e| format!("no window handle: {e}"))?;
        Ok(hwnd.0 as HWND)
    }

    fn set_style(hwnd: HWND, set: u32, clear: u32) -> Result<(), String> {
        let current = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
        let next = (current | set) & !clear;
        if next == current {
            return Ok(());
        }
        unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize) };
        Ok(())
    }
}

/// On other platforms the taskbar is the platform's own business; both calls
/// succeed as no-ops so the settings toggle still stores cleanly there.
#[cfg(not(windows))]
mod imp {
    use super::TaskbarAttention;

    pub fn set_taskbar_visible(_window: &tauri::WebviewWindow, _visible: bool) -> Result<(), String> {
        Ok(())
    }

    pub fn flash(_window: &tauri::WebviewWindow, _attention: TaskbarAttention) -> Result<(), String> {
        Ok(())
    }
}

/// Keep the main window in the taskbar (or let it be a background window).
#[tauri::command]
pub fn window_set_taskbar_visible(
    window: tauri::WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    imp::set_taskbar_visible(&window, visible)
}

/// Flash the window's taskbar button.
#[tauri::command]
pub fn window_flash_taskbar(
    window: tauri::WebviewWindow,
    attention: TaskbarAttention,
) -> Result<(), String> {
    imp::flash(&window, attention)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_is_parsed_from_the_lowercase_names_the_frontend_sends() {
        let ask: TaskbarAttention = serde_json::from_str("\"ask\"").expect("ask");
        let done: TaskbarAttention = serde_json::from_str("\"done\"").expect("done");
        let stop: TaskbarAttention = serde_json::from_str("\"stop\"").expect("stop");
        assert_eq!(ask, TaskbarAttention::Ask);
        assert_eq!(done, TaskbarAttention::Done);
        assert_eq!(stop, TaskbarAttention::Stop);
    }

    #[test]
    fn unknown_attention_is_rejected_rather_than_defaulting() {
        let parsed = serde_json::from_str::<TaskbarAttention>("\"shrug\"");
        assert!(parsed.is_err());
    }
}
