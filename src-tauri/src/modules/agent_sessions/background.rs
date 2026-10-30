//! Which sessions have a live `opencode.exe` behind them.
//!
//! The session list can tell a lot about a session that is open in a tab: the pty's output says
//! whether the agent is working, waiting for an answer, or resting. It says nothing about a session
//! that has no tab at all - a `opencode` left running in somebody's terminal, or one started before
//! this window existed - which is why those sessions used to show no dot while an agent was plainly
//! at work on them.
//!
//! The process table answers only the weaker question "is there a process for this session", and
//! that is what the dot claims: an agent is there. Whether it is generating cannot be read this way,
//! so the colour is the one for "an agent is here", never the one for "work in flight".
//!
//! `PROCESSENTRY32` carries no command line, so the id is read out of the target process: ask the
//! kernel for the process's command line (`ProcessCommandLineInformation`, Windows 8.1 and later)
//! and copy the string out of the other process's memory. No extra process is started, which is the
//! reason this route was chosen over `wmic`/`powershell`.

/// The session id in an `opencode` command line, if it names one.
///
/// Covers `--session <id>`, `--session=<id>`, surrounding quotes, and a flag anywhere among other
/// arguments. A missing value, or a flag that merely starts with the same letters (`--session-id`),
/// is not a match: a wrong id would light the wrong row.
pub fn session_id_from_command_line(line: &str) -> Option<String> {
    let mut words = line.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let bare = word.trim_matches('"').trim_matches('\'');
        let value = if let Some(rest) = bare.strip_prefix("--session=") {
            Some(rest.to_string())
        } else if bare == "--session" {
            words
                .peek()
                .map(|next| next.trim_matches('"').trim_matches('\'').to_string())
        } else {
            None
        };

        if let Some(value) = value {
            let cleaned = value.trim_matches('"').trim_matches('\'').trim();
            // A value that itself looks like a flag is a missing value, not an id.
            if !cleaned.is_empty() && !cleaned.starts_with('-') {
                return Some(cleaned.to_string());
            }
        }
    }
    None
}

/// Every session id with a live `opencode.exe` process on this machine.
///
/// Sorted and de-duplicated: several processes can name one session (a resumed one, a title
/// generator), and the caller only asks "is this session live".
///
/// Anything unreadable - a process that exited between the snapshot and the read, or one whose
/// owner is not us - contributes nothing. Silence is the only honest answer there: a dot drawn on a
/// guess would be worse than a dot missing.
pub fn live_session_ids() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        windows::live_session_ids()
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Nothing is claimed on other systems. The session list simply shows no background dots,
        // rather than pretending the question was answered.
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use std::ffi::c_void;
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::Debug::ReadProcessMemory;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };

    use super::session_id_from_command_line;
    use crate::modules::pty::foreground::process_list;

    /// `UNICODE_STRING`: a byte length, a capacity, and a pointer. Here the pointer is ours, which
    /// is what makes the kernel copy the string into this process instead of pointing elsewhere.
    /// The longest command line copied out, in UTF-16 code units.
    const MAX_COMMAND_LINE_CHARS: usize = 16 * 1024;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    /// The command line of one process, or None when it cannot be read.
    ///
    /// `ProcessCommandLineInformation` copies the command line into a buffer the caller supplies:
    /// the `UNICODE_STRING` handed in carries the destination pointer and its capacity, and comes
    /// back with `Length` filled in. (Asking with an empty description fails with
    /// `STATUS_INFO_LENGTH_MISMATCH`, which is how this shape was found.)
    /// The command line of one process, or None when it cannot be read.
    ///
    /// `ProcessCommandLineInformation` takes one block from the caller: the `UNICODE_STRING`
    /// descriptor at the front, the string's room right behind it. Asking with a bare descriptor
    /// fails with `STATUS_INFO_LENGTH_MISMATCH` and reports the total it wants, which is how this
    /// shape was found on this machine. Some Windows builds instead fill the descriptor with a
    /// pointer into the target process; that case is copied out, because a build where this
    /// silently returned nothing would show no dots at all and look like "no agents".
    ///
    /// Only `PROCESS_QUERY_LIMITED_INFORMATION` is asked for, and nothing is written anywhere.
    pub(super) fn command_line(pid: u32) -> Option<String> {
        let handle: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return None;
        }

        let mut raw = vec![0u8; size_of::<UnicodeString>() + MAX_COMMAND_LINE_CHARS * 2];
        let mut returned: u32 = 0;
        let status = unsafe {
            NtQueryInformationProcess(
                handle,
                ProcessCommandLineInformation,
                raw.as_mut_ptr().cast::<c_void>(),
                raw.len() as u32,
                &mut returned,
            )
        };
        if status < 0 {
            unsafe { CloseHandle(handle) };
            return None;
        }

        let descriptor = unsafe { &*(raw.as_ptr().cast::<UnicodeString>()) };
        let chars = (descriptor.length as usize) / size_of::<u16>();
        // A command line longer than the room we gave it is a misread descriptor, not a real one.
        if chars == 0 || chars > MAX_COMMAND_LINE_CHARS || descriptor.buffer.is_null() {
            unsafe { CloseHandle(handle) };
            return None;
        }

        let base = raw.as_ptr() as usize;
        let target = descriptor.buffer as usize;
        let inside = target >= base && target + chars * 2 <= base + raw.len();
        let text = if inside {
            // The usual case: the kernel copied the string into our own block.
            let slice = unsafe { std::slice::from_raw_parts(descriptor.buffer, chars) };
            Some(String::from_utf16_lossy(slice))
        } else {
            // The other documented shape: the descriptor points into the target process.
            let mut wide = vec![0u16; chars];
            let mut read: usize = 0;
            let copied = unsafe {
                ReadProcessMemory(
                    handle,
                    descriptor.buffer.cast::<c_void>(),
                    wide.as_mut_ptr().cast::<c_void>(),
                    chars * 2,
                    &mut read,
                )
            };
            if copied == 0 || read < chars * 2 {
                None
            } else {
                Some(String::from_utf16_lossy(&wide))
            }
        };
        unsafe { CloseHandle(handle) };
        text
    }

    pub(super) fn live_session_ids() -> Vec<String> {
        let mut ids = std::collections::BTreeSet::new();
        for entry in process_list() {
            if !entry.name.eq_ignore_ascii_case("opencode.exe") {
                continue;
            }
            if let Some(line) = command_line(entry.pid) {
                if let Some(id) = session_id_from_command_line(&line) {
                    ids.insert(id);
                }
            }
        }
        ids.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::session_id_from_command_line;

    #[test]
    fn reads_a_session_id_from_the_shapes_opencode_uses() {
        assert_eq!(
            session_id_from_command_line("opencode --session ses_abc123").as_deref(),
            Some("ses_abc123")
        );
        assert_eq!(
            session_id_from_command_line("opencode --session=ses_abc123").as_deref(),
            Some("ses_abc123")
        );
        // The real thing carries a path and a quoted program name.
        assert_eq!(
            session_id_from_command_line(
                "\"C:\\Users\\x\\AppData\\Local\\opencode\\opencode.exe\" --session \"ses_abc123\""
            )
            .as_deref(),
            Some("ses_abc123")
        );
        // Among other flags, and with the flag last but one.
        assert_eq!(
            session_id_from_command_line(
                "opencode --log-level info --session ses_abc123 --print-logs"
            )
            .as_deref(),
            Some("ses_abc123")
        );
    }

    #[test]
    fn a_missing_or_unrelated_value_is_not_an_id() {
        // No id at all: a service process, or a plain `opencode run`.
        assert_eq!(session_id_from_command_line("opencode serve --service"), None);
        // Flag present, value missing.
        assert_eq!(session_id_from_command_line("opencode --session"), None);
        // Next word is another flag, so the value is missing too.
        assert_eq!(session_id_from_command_line("opencode --session --print-logs"), None);
        // A different flag that merely starts with the same letters.
        assert_eq!(
            session_id_from_command_line("opencode --session-id ses_abc123"),
            None
        );
        // Empty value.
        assert_eq!(session_id_from_command_line("opencode --session=   "), None);
    }

    #[test]
    fn empty_input_is_no_session() {
        assert_eq!(session_id_from_command_line(""), None);
        assert_eq!(session_id_from_command_line("   "), None);
    }
}
