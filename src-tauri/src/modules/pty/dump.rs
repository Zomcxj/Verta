//! Development aid: mirror raw PTY reads to disk.
//!
//! Reading a program's protocol out of its binary tells you the shapes it can
//! produce. Watching the bytes tells you which shape it chose here, in this
//! terminal, with this environment. That difference is the whole reason this
//! exists: a TUI changes what it draws based on what it believes the terminal
//! supports, and a guess about that belief is worth nothing.
//!
//! Enabled only by setting `VERTA_PTY_DUMP_DIR`: with the variable absent the
//! struct holds no file and every write is a no-op, so shipping this costs one
//! branch per read.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

pub struct PtyDump {
    file: Option<File>,
}

impl PtyDump {
    pub fn new(session_id: u32) -> Self {
        Self::with_suffix(session_id, "")
    }

    /// Bytes the app sends to the program. Kept separate from the read
    /// direction so a capture shows which side said what.
    pub fn writes(session_id: u32) -> Self {
        Self::with_suffix(session_id, ".in")
    }

    fn with_suffix(session_id: u32, suffix: &str) -> Self {
        let file = std::env::var_os("VERTA_PTY_DUMP_DIR").and_then(|dir| {
            let path = PathBuf::from(dir).join(format!("pty-{session_id}{suffix}.bin"));
            match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(file) => {
                    log::warn!("PTY dump enabled: {}", path.display());
                    Some(file)
                }
                Err(error) => {
                    log::warn!("PTY dump could not open {}: {error}", path.display());
                    None
                }
            }
        });
        Self { file }
    }

    pub fn write(&mut self, bytes: &[u8]) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.write_all(bytes);
        }
    }
}