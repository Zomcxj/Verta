//! A global hotkey for the screenshot: the trigger that does not need the app to be in front.
//!
//! Everything else was already in place. `capture.rs` reads the screen through GDI, the main window
//! is excluded from captures, and the overlay takes the focus it needs when it appears - so
//! minimised, hidden in the tray, or behind another application, the grab itself was never the
//! problem. What was missing is a way to *ask*: `useGlobalShortcuts` is a window listener, and
//! Windows does not deliver keys to a window that does not have the focus. That is the operating
//! system's rule, not a bug in the page.
//!
//! `RegisterHotKey` is the answer the system provides: the shell delivers the chord to this process
//! wherever the keyboard is. With no window handle the message goes to the *thread* queue, so a
//! thread that does nothing but read its own queue is enough, and it keeps the main thread free -
//! the handler cannot touch windows from there and asks the main thread to run the capture.
//!
//! The two calls this needs are in `windows-sys`, which this crate already depends on for the rest
//! of its Windows work, so no plugin and no new crate for a hundred lines.
//!
//! One hotkey is held at a time, and it follows the preference: the page calls `set` whenever the
//! binding for `screenshot.capture` changes, including at startup and when it is cleared.

use serde::Deserialize;
use std::sync::Mutex;
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;

/// A `KeyBinding` as the page spells it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyChord {
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub meta: bool,
    pub key: String,
}

impl HotkeyChord {
    /// The chord in the form `RegisterHotKey` wants: modifiers and a virtual key.
    ///
    /// `None` for anything this cannot express - a key with no virtual-key equivalent, or a chord
    /// with no modifier at all. The last one is not a nicety: a global hotkey is taken from every
    /// application on the machine, so a bare `A` would be a letter nobody could type anywhere.
    #[cfg(windows)]
    fn parts(&self) -> Option<(u32, u32)> {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN,
        };

        let mut modifiers = MOD_NOREPEAT;
        if self.alt {
            modifiers |= MOD_ALT;
        }
        if self.ctrl {
            modifiers |= MOD_CONTROL;
        }
        if self.shift {
            modifiers |= MOD_SHIFT;
        }
        if self.meta {
            modifiers |= MOD_WIN;
        }
        if modifiers == MOD_NOREPEAT {
            return None;
        }
        Some((modifiers, virtual_key(&self.key)?))
    }
}

/// The virtual-key code for a key as the shortcut catalogue spells it.
///
/// Letters and digits are their own ASCII codes in the virtual-key space, which is why this does not
/// need a table for the common case. The rest is the set a binding can plausibly be written with.
#[cfg(windows)]
fn virtual_key(key: &str) -> Option<u32> {
    let upper = key.trim().to_ascii_uppercase();
    let bytes = upper.as_bytes();
    if bytes.len() == 1 && (bytes[0].is_ascii_uppercase() || bytes[0].is_ascii_digit()) {
        return Some(bytes[0] as u32);
    }
    if let Some(number) = upper.strip_prefix('F').and_then(|rest| rest.parse::<u32>().ok()) {
        if (1..=24).contains(&number) {
            // The function keys are contiguous from F1.
            return Some(0x70 + number - 1);
        }
    }
    let named = match upper.as_str() {
        "SPACE" => 0x20,
        "TAB" => 0x09,
        "ENTER" => 0x0D,
        "BACKSPACE" => 0x08,
        "INSERT" => 0x2D,
        "DELETE" => 0x2E,
        "HOME" => 0x24,
        "END" => 0x23,
        "PAGEUP" => 0x21,
        "PAGEDOWN" => 0x22,
        "ARROWLEFT" => 0x25,
        "ARROWUP" => 0x26,
        "ARROWRIGHT" => 0x27,
        "ARROWDOWN" => 0x28,
        // The punctuation keys live in the OEM range, and these are their codes.
        "," => 0xBC,
        "." => 0xBE,
        "/" => 0xBF,
        ";" => 0xBA,
        "'" => 0xDE,
        "[" => 0xDB,
        "]" => 0xDD,
        "\\" => 0xDC,
        "-" => 0xBD,
        "=" => 0xBB,
        "`" => 0xC0,
        _ => return None,
    };
    Some(named)
}

#[cfg(windows)]
mod worker {
    use super::{HotkeyChord, Request};
    use std::sync::mpsc::Receiver;
    use std::time::Duration;
    use tauri::AppHandle;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    use windows_sys::Win32::UI::WindowsAndMessaging::{MSG, PM_REMOVE, PeekMessageW, WM_HOTKEY};

    /// Which hotkey this process holds. Any value will do, as long as it is ours.
    const HOTKEY_ID: i32 = 0x5645;

    /// How long the loop sleeps when there is nothing to do.
    ///
    /// The queue is read with `PeekMessage`, so the loop has to come back for each message, and the
    /// sleep is what keeps an idle thread from spinning. Reading a queue twice per frame's worth of
    /// time costs nothing measurable next to what the capture does.
    const IDLE: Duration = Duration::from_millis(25);

    /// Register or clear the hotkey, and answer whether the system accepted it.
    fn apply(chord: Option<HotkeyChord>) -> Result<(), String> {
        unsafe {
            // Always released first: a rebind is "this one instead", and the previous chord has to
            // stop working before the new one is taken.
            UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID);
        }
        let Some(chord) = chord else {
            return Ok(());
        };
        let Some((modifiers, key)) = chord.parts() else {
            return Err(format!(
                "这个键位无法注册为全局快捷键：{}",
                chord.key
            ));
        };
        let registered = unsafe { RegisterHotKey(std::ptr::null_mut(), HOTKEY_ID, modifiers, key) };
        if registered == 0 {
            // Most often another application already owns the chord. The in-window shortcut still
            // works, so this is reported and not fatal.
            return Err(format!(
                "系统没有把这个全局快捷键给我们（可能已被别的程序占用）：{}",
                chord.key
            ));
        }
        Ok(())
    }

    /// Reads this thread's message queue for as long as the app lives.
    pub(super) fn run(app: AppHandle, requests: Receiver<Request>) {
        loop {
            // A rebind takes effect before the next key: the requests are drained first.
            while let Ok(request) = requests.try_recv() {
                match request {
                    Request::Set { chord, reply } => {
                        let _ = reply.send(apply(chord));
                    }
                }
            }
            let mut message: MSG = unsafe { std::mem::zeroed() };
            while unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) } != 0 {
                if message.message != WM_HOTKEY {
                    continue;
                }
                // The capture makes a window and shows it, which belongs to the main thread. The
                // clone is what the closure owns; borrowing the loop's own handle inside a closure
                // that also moves it is what the compiler refused.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Err(error) = crate::modules::screenshot::begin(&handle) {
                        log::warn!("global hotkey screenshot failed: {error}");
                    }
                });
            }
            std::thread::sleep(IDLE);
        }
    }
}

enum Request {
    Set {
        chord: Option<HotkeyChord>,
        reply: Sender<Result<(), String>>,
    },
}

/// The worker's side of the channel, started on the first call.
static WORKER: Mutex<Option<Sender<Request>>> = Mutex::new(None);

/// Hold this chord, or nothing.
///
/// Called with the binding for `screenshot.capture` on startup and whenever it changes. Answers the
/// system's own word: a chord another application already owns is a real failure, and the page says
/// so rather than pretending the hotkey is live.
#[cfg(windows)]
pub fn set(app: &tauri::AppHandle, chord: Option<HotkeyChord>) -> Result<(), String> {
    // The chord is checked here as well as on the worker: a value this cannot express should not
    // leave a thread running for it.
    if let Some(chord) = &chord {
        if chord.parts().is_none() {
            return Err(format!("这个键位无法注册为全局快捷键：{}", chord.key));
        }
    }
    let sender = {
        let mut worker = WORKER
            .lock()
            .map_err(|_| "全局快捷键的工作线程已经不可用".to_string())?;
        if worker.is_none() {
            let (requests, receiver) = channel::<Request>();
            let app = app.clone();
            std::thread::Builder::new()
                .name("verta-hotkey".to_string())
                .spawn(move || worker::run(app, receiver))
                .map_err(|e| format!("无法启动全局快捷键线程：{e}"))?;
            *worker = Some(requests);
        }
        worker.as_ref().cloned().ok_or_else(|| "全局快捷键线程没了".to_string())?
    };

    let (reply, answer) = channel();
    sender
        .send(Request::Set { chord, reply })
        .map_err(|_| "全局快捷键线程已经退出".to_string())?;
    // The worker is a sleeping loop, so the answer comes a tick later at worst; the timeout only
    // exists so a broken worker cannot hang the command.
    answer
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "全局快捷键没有应答".to_string())?
}

/// Platforms without a global hotkey yet: the in-window shortcut is all there is.
#[cfg(not(windows))]
pub fn set(_app: &tauri::AppHandle, _chord: Option<HotkeyChord>) -> Result<(), String> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn chord(key: &str) -> HotkeyChord {
        HotkeyChord {
            alt: true,
            ctrl: false,
            shift: false,
            meta: false,
            key: key.to_string(),
        }
    }

    #[test]
    fn a_chord_without_a_modifier_is_refused() {
        // A global hotkey is taken from the whole machine, so a bare key is not a shortcut, it is a
        // key nobody can type anywhere else.
        let bare = HotkeyChord {
            alt: false,
            ctrl: false,
            shift: false,
            meta: false,
            key: "a".to_string(),
        };
        assert_eq!(bare.parts(), None);
    }

    #[test]
    fn letters_digits_and_function_keys_get_their_virtual_codes() {
        // Letters and digits are their own ASCII codes in the virtual-key space; the function keys
        // run from 0x70.
        assert_eq!(virtual_key("a"), Some(0x41));
        assert_eq!(virtual_key("A"), Some(0x41));
        assert_eq!(virtual_key("7"), Some(0x37));
        assert_eq!(virtual_key("F1"), Some(0x70));
        assert_eq!(virtual_key("f12"), Some(0x7B));
        assert_eq!(virtual_key("F24"), Some(0x87));
        assert_eq!(virtual_key("F25"), None);
        assert_eq!(virtual_key("space"), Some(0x20));
        assert_eq!(virtual_key(","), Some(0xBC));
        assert_eq!(virtual_key("nah"), None);
        assert_eq!(virtual_key(""), None);
    }

    #[test]
    fn the_modifiers_are_the_ones_windows_defines() {
        // These are `MOD_ALT`/`MOD_CONTROL`/`MOD_SHIFT`/`MOD_WIN` in the Windows headers, spelled as
        // numbers here so the test says what it means: a wrong bit would register a different chord.
        let chord_with = |alt: bool, ctrl: bool, shift: bool, meta: bool| HotkeyChord {
            alt,
            ctrl,
            shift,
            meta,
            key: "a".to_string(),
        };
        let bits = |chord: HotkeyChord| chord.parts().map(|(modifiers, _)| modifiers & 0x0F);
        assert_eq!(bits(chord_with(true, false, false, false)), Some(0x1));
        assert_eq!(bits(chord_with(false, true, false, false)), Some(0x2));
        assert_eq!(bits(chord_with(false, false, true, false)), Some(0x4));
        assert_eq!(bits(chord_with(false, false, false, true)), Some(0x8));
        assert_eq!(bits(chord_with(true, true, false, false)), Some(0x3));
        // And the default binding, Alt+A, is a chord this can hold: `MOD_NOREPEAT` plus `MOD_ALT`.
        assert_eq!(chord("a").parts(), Some((0x4001, 0x41)));
    }
}
