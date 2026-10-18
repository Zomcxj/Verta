//! Dev tool: run a command inside a pty and dump its raw output to a file.
//!
//! Written to find out what a TUI actually emits. Reading a program's protocol
//! out of a compiled binary tells you the shapes it can produce; watching the
//! bytes tells you which shape it chose on this machine. A pty is required
//! because these programs change what they draw when stdout is not a terminal.
//!
//! Usage:
//!   cargo run --example pty_dump -- <out-file> <seconds> <cmd> [args...]
//!
//! The child inherits this process's environment, so callers set any extra
//! variables in their own shell first.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: pty_dump <out-file> <seconds> <cmd> [args...]");
        std::process::exit(2);
    }
    let out_path = args[0].clone();
    let seconds: f64 = args[1].parse().expect("seconds must be a number");
    let program = args[2].clone();
    let rest = &args[3..];

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty failed");

    let mut cmd = CommandBuilder::new(&program);
    for arg in rest {
        cmd.arg(arg);
    }
    // Inherit explicitly: the parent's environment is what the caller prepared.
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }

    let mut child = pair.slave.spawn_command(cmd).expect("spawn failed");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("reader failed");
    let mut writer = pair.master.take_writer().expect("writer failed");

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    // A TUI asks the terminal questions and waits for answers before drawing:
    // without replies it stops at the first cursor-position request and emits
    // nothing worth reading. These are the queries a modern TUI sends; the
    // answers are the ones a plain VT220-compatible terminal would give.
    fn reply_for(chunk: &[u8], all: &[u8]) -> Option<Vec<u8>> {
        let tail_start = all.len().saturating_sub(chunk.len() + 64);
        let window = &all[tail_start..];
        let text = String::from_utf8_lossy(window);

        // Cursor position report.
        if text.ends_with("\x1b[6n") {
            return Some(b"\x1b[1;1R".to_vec());
        }
        // Window size in pixels, then the cell size in pixels, then the text
        // area in characters. A TUI needs the first two to work out how many
        // cells an image occupies: without them it cannot place an image at
        // all and quietly falls back to text.
        if text.contains("\x1b[14t") {
            let pixels = std::env::var("PROBE_PIXELS").unwrap_or_else(|_| "600;800".to_string());
            return Some(format!("\x1b[4;{pixels}t").into_bytes());
        }
        if text.contains("\x1b[16t") {
            let cell = std::env::var("PROBE_CELL").unwrap_or_else(|_| "20;10".to_string());
            return Some(format!("\x1b[6;{cell}t").into_bytes());
        }
        if text.contains("\x1b[18t") {
            let chars = std::env::var("PROBE_CHARS").unwrap_or_else(|_| "30;100".to_string());
            return Some(format!("\x1b[8;{chars}t").into_bytes());
        }
        // Primary device attributes. The attribute list is where a terminal
        // declares pixel-image support, so PROBE_DA1 makes it configurable:
        // what a program believes it can draw is read from this reply.
        if text.contains("\x1b[c") || text.contains("\x1b[0c") {
            let attrs = std::env::var("PROBE_DA1").unwrap_or_else(|_| "62;22".to_string());
            return Some(format!("\x1b[?{attrs}c").into_bytes());
        }
        // Secondary device attributes and XTVERSION.
        if text.ends_with("\x1b[>c") {
            return Some(b"\x1b[>1;0;0c".to_vec());
        }
        if text.contains("\x1b[>q") {
            // XTVERSION. The identity a terminal claims here decides which
            // image protocol a TUI believes it can use, so it is worth making
            // this configurable: setting PROBE_XTVERSION shows what a program
            // does when it is told a different terminal is on the other end.
            let name = std::env::var("PROBE_XTVERSION")
                .unwrap_or_else(|_| "verta 0.0".to_string());
            return Some(format!("\x1bP>|{name}\x1b\\").into_bytes());
        }
        // DECRQM for synchronized output and for the alternate screen.
        if text.ends_with("\x1b[?2026$p") {
            return Some(b"\x1b[?2026;2$y".to_vec());
        }
        if text.ends_with("\x1b[?1049$p") {
            return Some(b"\x1b[?1049;2$y".to_vec());
        }
        // Default foreground and background, as OSC 10 and 11.
        if text.ends_with("\x1b]10;?\x07") || text.ends_with("\x1b]10;?\x1b\\") {
            return Some(b"\x1b]10;rgb:ffff/ffff/ffff\x07".to_vec());
        }
        if text.ends_with("\x1b]11;?\x07") || text.ends_with("\x1b]11;?\x1b\\") {
            return Some(b"\x1b]11;rgb:0000/0000/0000\x07".to_vec());
        }
        // Kitty graphics query: answer that the command was applied.
        if text.ends_with("\x1b\\") && text.contains("\x1b_G") {
            let id = text
                .rsplit("\x1b_G")
                .next()
                .and_then(|rest| rest.split(';').next())
                .unwrap_or("");
            let answer = format!("\x1b_G{id};OK\x1b\\");
            return Some(answer.into_bytes());
        }
        None
    }

    // A TUI may want a size report before it draws anything.
    let deadline = Instant::now() + Duration::from_secs_f64(seconds);
    let mut all: Vec<u8> = Vec::new();
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                all.extend_from_slice(&chunk);
                if let Some(answer) = reply_for(&chunk, &all) {
                    let _ = writer.write_all(&answer);
                    let _ = writer.flush();
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Ask the child to stop, then collect whatever it writes on the way out.
    let _ = writer.write_all(b"\x03");
    let _ = writer.flush();
    let quit_deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < quit_deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => all.extend_from_slice(&chunk),
            Err(_) => break,
        }
    }
    let _ = child.kill();

    std::fs::write(&out_path, &all).expect("write failed");
    println!(
        "captured {} bytes to {} ({} kitty APC starts)",
        all.len(),
        out_path,
        all.windows(3).filter(|w| w == b"\x1b_G").count()
    );
}