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
//! The cache is also written to the user's directory on every tick that found something new, and
//! read back before the first read of the next launch: without that, every launch paid the whole
//! read again (20-45 s) even though almost nothing had changed while the app was closed.
//!
//! Measured here after the change: a tick that nothing happened in is **377-402 ms** (claude 14 ms,
//! pi 8 ms, dsh 14 ms, opencode 258 ms). The first read of a launch is the full store - 19.6-28.9 s
//! on this machine, depending on its load - and it is paid once: the next launch restored 70 files
//! and 36k opencode rows in **627-649 ms** and answered its first tick in **355-832 ms**.

use std::path::{Path, PathBuf};
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

/// How often at most the cache is written, on top of "only when a tick found something new".
///
/// What a save that is a few minutes behind costs is one appended tail parsed on the next launch -
/// milliseconds. What writing costs is serializing 16 MiB of events and putting 2.2 MiB on the disk,
/// on a tick that already has work to do: measured 1639 ms in this (debug) build. So the file is
/// kept behind on purpose rather than rewritten every minute. The first changed tick always writes,
/// because that is the one holding the whole cold read.
const STORE_EVERY: Duration = Duration::from_secs(300);

/// The one cache the whole app reads through.
///
/// `None` until the first read, so a build that never opens a usage window never pays for one.
static CACHE: Mutex<Option<UsageReadCache>> = Mutex::new(None);

/// One read at a time, whoever asked: the background tick, a window, or a probe beside both.
static READING: Mutex<()> = Mutex::new(());

/// The last read the background tick finished, kept so a window can answer without reading again.
///
/// The read is the expensive half of opening the usage window: 2.0 s on this machine (98k events,
/// and the opencode store alone scans 40k message rows for their id and time_updated before it can
/// tell that none of them moved). The fold that follows is 240-400 ms. A tick already pays both once
/// a minute, so a window that opens between two ticks has nothing to learn by paying them again -
/// measured end to end, the command took 3.1-3.9 s and returned a 75 KiB payload, which is the
/// "打开用量还要等个几秒" this exists to remove.
///
/// What it is not is a second source of truth: it carries the instant it was read and is only used
/// while it is younger than [`SNAPSHOT_MAX_AGE_MS`]. Past that the window reads, which is also what
/// happens when the tick has never run.
static SNAPSHOT: Mutex<Option<Snapshot>> = Mutex::new(None);

struct Snapshot {
    read: std::sync::Arc<UsageRead>,
    taken_at: Instant,
}

/// How old a snapshot may be and still answer a window.
///
/// A tick and a half: a window that opens up to ninety seconds after the last tick gets an answer at
/// most one tick and a half old, which is the cadence the window already promises (it re-reads on
/// every change event). Beyond that the answer would be older than what the user was told to expect,
/// and a read is the honest one.
const SNAPSHOT_MAX_AGE_MS: Duration = Duration::from_secs(TICK.as_secs() * 3 / 2);

/// Whether a snapshot taken this long ago still answers a window. See [`SNAPSHOT_MAX_AGE_MS`].
fn snapshot_is_usable(age: Duration) -> bool {
    age <= SNAPSHOT_MAX_AGE_MS
}

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

/// The last finished read, when it is young enough to answer with, and without reading anything.
///
/// This is the path a window opening takes. It never blocks on the background tick's own read: it
/// only looks at what that tick already published, so a window that opens while a tick is running
/// answers from the previous one instead of queueing behind it - which is the other half of the wait
/// (the tick itself takes 1.4-8.3 s here).
pub fn snapshot() -> Option<std::sync::Arc<UsageRead>> {
    let snapshot = SNAPSHOT
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let snapshot = snapshot.as_ref()?;
    if !snapshot_is_usable(snapshot.taken_at.elapsed()) {
        return None;
    }
    Some(std::sync::Arc::clone(&snapshot.read))
}

/// Publishes a finished read for the next window to open. Called by the tick, never by a window.
fn publish(read: std::sync::Arc<UsageRead>) {
    let mut slot = SNAPSHOT
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    *slot = Some(Snapshot {
        read,
        taken_at: Instant::now(),
    });
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
    let store = store_path();
    std::thread::Builder::new()
        .name("usage-refresh".to_string())
        .spawn(move || {
            // Before the first read, so a launch that follows a warm one parses only what moved while
            // the app was closed instead of the whole store again.
            if let Some(store) = &store {
                restore(store);
            }
            let mut last: Option<u64> = None;
            // When the file was last written. `None` is "never in this launch", which is also what
            // makes the first write the announced one.
            let mut last_store: Option<Instant> = None;
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
                    // Written before the minute is slept away, and the timing above stays the read's
                    // own: a tick that found nothing new cannot have moved the file, and one a few
                    // minutes behind is still almost all of the work saved.
                    if let Some(store) = &store {
                        let due = last_store.is_none_or(|at| at.elapsed() >= STORE_EVERY);
                        if due {
                            persist(store, last_store.is_none());
                            last_store = Some(Instant::now());
                        }
                    }
                    let _ = app.emit(CHANGED_EVENT, ());
                } else {
                    log::debug!("usage refresh: nothing changed, {} ms", spent.as_millis());
                }
                // Published on every tick, changed or not: a window that opens wants the newest
                // answer, and "nothing moved since the last tick" is itself the newest answer. After
                // the log lines above, which read the report this hands over.
                publish(std::sync::Arc::new(read));
                // What is left of the minute, measured from when the read *started*: a slow tick must
                // not push the next one a whole minute further out.
                std::thread::sleep(TICK.saturating_sub(spent));
            }
        })
        .map(|_| ())
        .unwrap_or_else(|error| log::warn!("usage refresh not started: {error}"));
}

/// Where the cache is kept between launches: the per-user directory the control descriptor uses too.
///
/// A cache, not a document: it can be deleted at any time and the only cost is the next read.
fn store_path() -> Option<PathBuf> {
    Some(
        dirs::cache_dir()?
            .join("verta")
            .join(super::usage_cache::STORE_FILE),
    )
}

/// Puts the cache read back from disk in place, unless a read has already filled the slot.
fn restore(path: &Path) {
    let started = Instant::now();
    let Some(loaded) = UsageReadCache::load(path) else {
        return;
    };
    let files = loaded.files.len();
    let rows = loaded.opencode.rows.len();
    let mut slot = CACHE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // A window that opened first and already did the cold read answered from a cache of its own;
    // replacing that would only throw the work away.
    if slot.is_some() {
        return;
    }
    *slot = Some(loaded);
    log::info!(
        "usage cache restored: {files} files, {rows} opencode rows, {} ms",
        started.elapsed().as_millis()
    );
}

/// Writes the cache out for the next launch.
///
/// `announce` is the first write of a launch: it is logged at info, so a real run leaves one line
/// saying what the next launch will find, and the writes after it stay at debug.
fn persist(path: &Path, announce: bool) {
    let started = Instant::now();
    let cache = CACHE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let Some(cache) = cache.as_ref() else {
        return;
    };
    match cache.save(path) {
        Ok(bytes) => {
            let kib = bytes / 1024;
            let millis = started.elapsed().as_millis();
            if announce {
                log::info!("usage cache written: {kib} KiB in {millis} ms");
            } else {
                log::debug!("usage cache written: {kib} KiB in {millis} ms");
            }
        }
        Err(error) => log::warn!("usage cache not written: {error}"),
    }
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
    fn a_snapshot_is_reused_while_it_is_younger_than_the_tick() {
        // The background tick reads every 60 s. A window that opens between two ticks must answer
        // from what the last one produced: the read itself costs 2 s on this machine (98k events,
        // 40k opencode message rows scanned for their id and time_updated), and paying it again to
        // learn what a tick learned seconds ago is the "打开用量还要等个几秒" the reader reported.
        assert!(snapshot_is_usable(Duration::ZERO));
        assert!(snapshot_is_usable(TICK));
        assert!(snapshot_is_usable(TICK + Duration::from_secs(5)));
    }

    #[test]
    fn a_snapshot_older_than_a_tick_and_a_half_is_not_reused() {
        // Past that, the answer would be older than the cadence the window promises, and a fresh
        // read is the honest one.
        assert!(!snapshot_is_usable(TICK * 2));
        assert!(!snapshot_is_usable(Duration::from_secs(600)));
    }

    #[test]
    fn a_failure_moves_the_fingerprint() {
        let mut changed = report();
        changed.failures.push("unreadable".to_string());
        assert_ne!(fingerprint_of(&report(), TOOLS), fingerprint_of(&changed, TOOLS));
    }
}
