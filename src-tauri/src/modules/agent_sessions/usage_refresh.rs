//! The usage read, kept warm so the window never waits for it.
//!
//! A read is 45 s of parsing on this machine (142 files, 227 MB, measured 11-19), which is far too
//! slow to do while somebody is looking at a window - and far too slow to repeat every minute, which
//! is what was asked for ("用量在后台要每分钟更新一次 单独线程 不卡界面"). Two things fix that, and
//! they are separate:
//!
//! - **`usage_cache`** makes the second read of the same stores cost almost nothing, because only the
//!   file being appended to has to be parsed again.
//! - **This module owns the cache and ticks it**, so the work happens once a minute on a thread of
//!   its own and a window that opens in between reads an answer that is already folded. A window
//!   hears about a change through [`CHANGED_EVENT`] and re-reads, which is now cheap.
//!
//! Reading is serialized. A window opening while the background read is running would otherwise
//! start a second scan of the same bytes, and both would feel slow for the sake of one answer; the
//! second caller waits for the first and then reads the cache.
//!
//! Measured here after the change: the first read of a launch is the full 20 s, and a tick that
//! nothing happened in is **377-402 ms** (claude 14 ms, pi 8 ms, dsh 14 ms, opencode 258 ms).

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use super::usage_cache::UsageReadCache;
use super::{usage, UsageRead};

/// Emitted with no payload: a window that is open re-reads when it hears it.
pub const CHANGED_EVENT: &str = "verta://usage-changed";

/// How often the stores are read again.
///
/// Once a minute, which is the requirement and also what the cache makes affordable: one appended
/// session file is parsed, everything else is a `stat` and a 4 KiB sample.
const TICK: Duration = Duration::from_secs(60);

/// The one cache the whole app reads through.
///
/// `None` until the first read, so a build that never opens a usage window never pays for one.
static CACHE: Mutex<Option<UsageReadCache>> = Mutex::new(None);

/// One read at a time, whoever asked: the background tick, a window, or a probe beside both.
static READING: Mutex<()> = Mutex::new(());

/// The usage stores, read through the shared cache.
pub fn read(since_ms: Option<i64>) -> UsageRead {
    let _reading = READING
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let cache = cache.get_or_insert_with(UsageReadCache::default);
    super::usage_events(since_ms, cache)
}

/// How many files the cache remembers, for the "what did that tick cost" log line.
pub fn cached_files() -> usize {
    CACHE
        .lock()
        .map(|cache| cache.as_ref().map_or(0, |cache| cache.files.len()))
        .unwrap_or(0)
}

/// Starts the background read. Never fails: a machine where a tick cannot run still has the
/// synchronous read `agent_usage_events` does.
pub fn start(app: AppHandle) {
    std::thread::Builder::new()
        .name("usage-refresh".to_string())
        .spawn(move || {
            let mut last: Option<u64> = None;
            loop {
                let started = Instant::now();
                let read = read(None);
                let fingerprint = fingerprint_of(&read.report, &read.available);
                // The first read always counts as a change: it is the one that fills the cache, and a
                // window already open should hear that its numbers were replaced.
                let changed = last != Some(fingerprint);
                last = Some(fingerprint);
                let spent = started.elapsed();
                // A tick that found nothing is the common case, so it is a debug line: a minute-apart
                // "nothing changed" every minute would bury the one that did.
                if changed {
                    log::info!(
                        "usage refresh: {} events, {} tools, {} cached files, {} failures, {} ms, changed",
                        read.report.events.len(),
                        read.available.len(),
                        cached_files(),
                        read.report.failures.len(),
                        spent.as_millis(),
                    );
                    let _ = app.emit(CHANGED_EVENT, ());
                } else {
                    log::debug!("usage refresh: nothing changed, {} ms", spent.as_millis());
                }
                // What is left of the minute, measured from when the read *started*: a slow tick must
                // not push the next one a whole minute further out.
                std::thread::sleep(TICK.saturating_sub(spent));
            }
        })
        .map(|_| ())
        .unwrap_or_else(|error| log::warn!("usage refresh not started: {error}"));
}

/// What the events add up to, for "did anything change".
///
/// Every field that a window draws is folded in, so a changed model name or a moved day is a change
/// even when the totals are identical. 90k events hash in about a millisecond, which is nothing next
/// to the read the answer came from.
fn fingerprint_of(report: &usage::UsageReadReport, available: &[&'static str]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    let mut mix = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    };
    mix(report.events.len() as u64);
    mix(report.failures.len() as u64);
    // Which agents have a store is part of the answer a window draws (the filter greys out the rest),
    // and installing one changes it without changing an event.
    mix(available.len() as u64);
    for tool in available {
        mix(tool.len() as u64);
        for byte in tool.bytes() {
            mix(u64::from(byte));
        }
    }
    for event in &report.events {
        // The tool names are a closed set, so their length and bytes are enough.
        mix(event.tool.len() as u64);
        for byte in event.tool.bytes() {
            mix(u64::from(byte));
        }
        mix(event.at_ms as u64);
        for name in [&event.provider, &event.model] {
            match name {
                None => mix(u64::MAX),
                Some(name) => {
                    mix(name.len() as u64);
                    for byte in name.bytes() {
                        mix(u64::from(byte));
                    }
                }
            }
        }
        let tokens = &event.tokens;
        for part in [
            tokens.input,
            tokens.output,
            tokens.reasoning,
            tokens.cache_read,
            tokens.cache_write,
            tokens.unsplit,
        ] {
            mix(part);
        }
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::agent_sessions::usage::{OwnedUsageEvent, UsageTokens};

    const TOOLS: &[&str] = &["claude", "pi"];

    fn report() -> usage::UsageReadReport {
        usage::UsageReadReport {
            events: vec![OwnedUsageEvent {
                at_ms: 1_794_700_000_000,
                tool: "claude",
                provider: Some("anthropic".to_string()),
                model: Some("claude-sonnet-4-5".to_string()),
                tokens: UsageTokens {
                    input: 10,
                    output: 20,
                    ..UsageTokens::ZERO
                },
            }],
            failures: Vec::new(),
        }
    }

    #[test]
    fn the_same_events_hash_the_same() {
        assert_eq!(fingerprint_of(&report(), TOOLS), fingerprint_of(&report(), TOOLS));
    }

    #[test]
    fn a_changed_number_moves_the_fingerprint() {
        let mut changed = report();
        changed.events[0].tokens.output = 21;
        assert_ne!(fingerprint_of(&report(), TOOLS), fingerprint_of(&changed, TOOLS));
    }

    #[test]
    fn a_changed_name_moves_the_fingerprint() {
        let mut changed = report();
        changed.events[0].model = Some("claude-opus-4-5".to_string());
        assert_ne!(fingerprint_of(&report(), TOOLS), fingerprint_of(&changed, TOOLS));
    }

    #[test]
    fn an_agent_appearing_moves_the_fingerprint() {
        // Installing one changes the window's filter with no event to show for it.
        assert_ne!(
            fingerprint_of(&report(), TOOLS),
            fingerprint_of(&report(), &["claude", "pi", "dsh"])
        );
    }

    #[test]
    fn a_failure_moves_the_fingerprint() {
        let mut changed = report();
        changed.failures.push("unreadable".to_string());
        assert_ne!(fingerprint_of(&report(), TOOLS), fingerprint_of(&changed, TOOLS));
    }
}
