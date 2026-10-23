//! Taskbar behaviour of the main window.
//!
//! One thing the OS, not the page, decides: **alerting the user while they are
//! looking elsewhere.** When an agent asks for input or finishes, the taskbar
//! button flashes. `FlashWindowEx` is the only supported way to do that: drawing a
//! badge or colouring the button needs private shell APIs.
//!
//! Whether the window has a taskbar button at all used to live here too, as a
//! setting that forced `WS_EX_APPWINDOW` on. It is gone: the tray icon
//! (`modules::tray`) is what keeps the app reachable, and a setting that claimed
//! to be about "staying resident" while only adding a taskbar button was the wrong
//! idea to begin with.

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
        FLASHW_ALL, FLASHWINFO, FLASHW_TIMERNOFG, FlashWindowEx,
    };

    /// How many times "done" flashes. Enough to notice, few enough to ignore.
    const DONE_FLASH_COUNT: u32 = 5;
    const DONE_FLASH_MS: u32 = 400;

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
}

/// On other platforms the taskbar is the platform's own business; the call
/// succeeds as a no-op so the settings toggle still stores cleanly there.
#[cfg(not(windows))]
mod imp {
    use super::TaskbarAttention;

    pub fn flash(_window: &tauri::WebviewWindow, _attention: TaskbarAttention) -> Result<(), String> {
        Ok(())
    }
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
