//! What one usage read can reuse from the last one.
//!
//! A read parses every byte of every transcript: measured on this machine, 142 files and 227 MB,
//! which is 45 s of line-by-line JSON. Almost none of it changes between two reads a minute apart -
//! one session file is being appended to and everything else is exactly as it was. So each file's
//! contribution is remembered, keyed by what the file looked like when it was read.
//!
//! Two layers, because one is not enough:
//!
//! - **A fingerprint**: an unchanged `(size, mtime, first 4 KiB)` means the file cannot have produced
//!   a new event, so its events come out of the cache and only that block is read. A directory walk
//!   plus a `stat` over the whole set measured 1 ms. The hash of the first block is there because
//!   Windows does not reliably raise `mtime` on a rewrite: measured here, two writes a millisecond
//!   apart kept one, so `(size, mtime)` alone missed a file truncated and written back to its length.
//! - **A consumed offset**: the session somebody is talking to right now is appended to every few
//!   seconds, so its fingerprint changes on every tick and would mean re-parsing the whole file (one
//!   session here is 67.8 MB, twelve seconds on its own). The offset says how many bytes were already
//!   turned into events, and a sample of the bytes just before it says the file was appended to rather
//!   than rewritten. Reading that sample costs one seek and 64 KiB.
//!
//! Neither layer changes the answer. A reused file contributes exactly the events a re-read would
//! produce, and the duplicate rule still runs once over all of them in the same order: a streamed
//! answer is persisted several times with one `message.id`, and the first copy counted is the one the
//! uncached read would have counted too.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::usage::{OwnedUsageEvent, UsageReadReport};

/// How many bytes before the consumed offset are kept as the proof that the prefix is unchanged.
///
/// One block-sized sample: a rewrite that keeps the size and also reproduces these 64 KiB is not
/// something a tool writing append-only transcripts does, and the cost of checking is a single read.
const TAIL_SAMPLE: u64 = 64 * 1024;

/// How many bytes from the start are hashed into a file's fingerprint.
///
/// Windows does not always raise a file's mtime on a rewrite, so `(size, mtime)` alone missed a file
/// truncated and written back to the same length; measured on this machine, two writes a millisecond
/// apart kept one mtime. The first block is what a rewrite of a transcript changes, and reading 4 KiB
/// per file is a millisecond over the whole store.
const HEAD_SAMPLE: u64 = 4 * 1024;

/// One record a reader recognized, with the tool's own identity for it when it has one.
pub(crate) struct FileEvent {
    /// The record's key in the tool's data (`claude`'s `message.id`). A later record with the same
    /// key is another copy of one answer, and is not counted twice.
    pub key: Option<String>,
    pub event: OwnedUsageEvent,
}

/// What one file contributed, kept between reads.
struct CachedFile {
    /// Which reader's file list this entry came from, so a file a tool has stopped listing can be
    /// dropped without touching another tool's entries.
    scope: &'static str,
    size: u64,
    mtime_ns: u64,
    /// Hash of the file's first `HEAD_SAMPLE` bytes: part of the fingerprint, because a file can be
    /// rewritten to the same length without its mtime moving.
    head: Option<u64>,
    /// Bytes already turned into events. Always the end of a complete line.
    consumed: u64,
    /// Sample of the bytes before `consumed`; `None` when nothing was consumed.
    tail: Option<u64>,
    events: Vec<FileEvent>,
    /// Why the last read of this file broke off, if it did. Kept so a file that cannot be read is
    /// reported on every read rather than only the one that first hit the error.
    failure: Option<String>,
}

/// Everything one read remembers between reads.
///
/// Two layers because the stores are two kinds of thing: transcripts are files that are appended to
/// (so a file can be resumed), and opencode's history is rows in a database that is rewritten
/// constantly (so a row can be resumed but the file cannot).
#[derive(Default)]
pub(crate) struct UsageReadCache {
    pub(crate) files: UsageFileCache,
    pub(crate) opencode: super::opencode::UsageRowCache,
}

/// The per-file memory of one usage read, reused by the next.
#[derive(Default)]
pub(crate) struct UsageFileCache {
    files: HashMap<PathBuf, CachedFile>,
}

impl UsageFileCache {
    /// Read every file's events, reusing what the last read produced for the unchanged ones.
    ///
    /// `parse` is handed one line at a time and returns the record it recognizes, or `None` for the
    /// lines that are not usage at all (most of them). A record with a key is deduplicated across the
    /// whole call, in file order, which is the rule the readers used to apply while parsing.
    pub(crate) fn read_jsonl(
        &mut self,
        scope: &'static str,
        files: &[PathBuf],
        since_ms: Option<i64>,
        parse: impl Fn(&str) -> Option<FileEvent>,
    ) -> UsageReadReport {
        let mut report = UsageReadReport::default();
        let mut seen: HashSet<String> = HashSet::new();
        for path in files {
            match self.jsonl_entry(scope, path, &parse) {
                Ok(entry) => {
                    if let Some(failure) = &entry.failure {
                        report.failures.push(failure.clone());
                    }
                    for found in &entry.events {
                        push_event(&mut report, &mut seen, found, since_ms);
                    }
                }
                Err(failure) => report.failures.push(failure),
            }
        }
        self.files.retain(|path, entry| {
            entry.scope != scope || files.iter().any(|listed| listed == path)
        });
        report.events.sort_by_key(|event| event.at_ms);
        report
    }

    /// The same for a file that cannot be read in pieces.
    ///
    /// dsh's logs are zstd-compressed and their parser carries state across lines (which model the
    /// session is running on, where an inherited prefix ends), so a file is parsed whole or not at
    /// all. Size 42 MB in total here, and a log is rewritten rather than appended to, so the
    /// fingerprint alone is the right key.
    ///
    /// The closure answers the events it found **and** what went wrong, because a log that breaks off
    /// half way still contributed everything above the break, and reporting one must not throw the
    /// other away.
    pub(crate) fn read_whole(
        &mut self,
        scope: &'static str,
        files: &[PathBuf],
        since_ms: Option<i64>,
        parse: impl Fn(&Path) -> (Vec<FileEvent>, Option<String>),
    ) -> UsageReadReport {
        let mut report = UsageReadReport::default();
        let mut seen: HashSet<String> = HashSet::new();
        for path in files {
            match self.whole_entry(scope, path, &parse) {
                Ok(entry) => {
                    if let Some(failure) = &entry.failure {
                        report.failures.push(failure.clone());
                    }
                    for found in &entry.events {
                        push_event(&mut report, &mut seen, found, since_ms);
                    }
                }
                Err(failure) => report.failures.push(failure),
            }
        }
        self.files.retain(|path, entry| {
            entry.scope != scope || files.iter().any(|listed| listed == path)
        });
        report.events.sort_by_key(|event| event.at_ms);
        report
    }

    /// How many files are remembered. For the log line that says what a warm read costs.
    pub(crate) fn len(&self) -> usize {
        self.files.len()
    }

    /// A jsonl file's entry, parsed from where the last read stopped.
    fn jsonl_entry<'a>(
        &'a mut self,
        scope: &'static str,
        path: &Path,
        parse: &impl Fn(&str) -> Option<FileEvent>,
    ) -> Result<&'a CachedFile, String> {
        let (size, mtime_ns) = fingerprint(path)?;
        let head = head_sample(path);
        let previous = self.files.get(path).map(|entry| {
            (
                entry.size,
                entry.mtime_ns,
                entry.head,
                entry.consumed,
                entry.tail,
            )
        });
        if let Some((cached_size, cached_mtime, cached_head, _, _)) = previous {
            if cached_size == size && cached_mtime == mtime_ns && cached_head == head {
                return Ok(self.files.get(path).expect("just looked it up"));
            }
        }

        // Appended to, or rewritten? A file that only grew, whose consumed prefix still hashes to
        // what it did, is the normal case for a session being talked to: parse the new tail only.
        let appended = match previous {
            Some((cached_size, _, _, consumed, Some(tail)))
                if consumed > 0 && size > consumed && cached_size <= size =>
            {
                tail_sample(path, consumed) == Some(tail)
            }
            _ => false,
        };
        let (start, mut events) = if appended {
            let consumed = previous.map_or(0, |(_, _, _, consumed, _)| consumed);
            let events = self
                .files
                .remove(path)
                .map(|entry| entry.events)
                .unwrap_or_default();
            (consumed, events)
        } else {
            (0, Vec::new())
        };

        let mut failure = None;
        let mut consumed = start;
        match std::fs::File::open(path) {
            Ok(mut file) => {
                if start > 0 {
                    if let Err(error) = file.seek(SeekFrom::Start(start)) {
                        failure = Some(format!(
                            "无法定位会话文件 {}：{error}",
                            path.display()
                        ));
                    }
                }
                if failure.is_none() {
                    let mut reader = BufReader::new(file);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Ok(read) => {
                                let complete = line.ends_with('\n');
                                // A last line whose newline is not there yet may be half written. It
                                // is only accepted when it already parses: a complete record that
                                // simply lacks the newline is counted now, a torn one waits.
                                if !complete && parse(&line).is_none() {
                                    break;
                                }
                                consumed += read as u64;
                                if let Some(found) = parse(&line) {
                                    events.push(found);
                                }
                                if !complete {
                                    break;
                                }
                            }
                            Err(error) => {
                                failure = Some(format!(
                                    "读取会话文件 {} 中断：{error}",
                                    path.display()
                                ));
                                break;
                            }
                        }
                    }
                }
            }
            Err(error) => {
                failure = Some(format!("无法打开会话文件 {}：{error}", path.display()));
            }
        }

        let entry = CachedFile {
            scope,
            size,
            mtime_ns,
            head,
            consumed,
            tail: (consumed > 0)
                .then(|| tail_sample(path, consumed))
                .flatten(),
            events,
            failure,
        };
        self.files.insert(path.to_path_buf(), entry);
        Ok(self.files.get(path).expect("just inserted"))
    }

    /// A whole-file parse, reused when the file has not changed at all.
    fn whole_entry<'a>(
        &'a mut self,
        scope: &'static str,
        path: &Path,
        parse: &impl Fn(&Path) -> (Vec<FileEvent>, Option<String>),
    ) -> Result<&'a CachedFile, String> {
        let (size, mtime_ns) = fingerprint(path)?;
        let head = head_sample(path);
        if let Some(entry) = self.files.get(path) {
            if entry.size == size
                && entry.mtime_ns == mtime_ns
                && entry.head == head
                && entry.failure.is_none()
            {
                return Ok(self.files.get(path).expect("just looked it up"));
            }
        }
        let (events, failure) = parse(path);
        let entry = CachedFile {
            scope,
            size,
            mtime_ns,
            head,
            consumed: size,
            tail: None,
            events,
            failure,
        };
        self.files.insert(path.to_path_buf(), entry);
        Ok(self.files.get(path).expect("just inserted"))
    }
}

/// One cached record, deduplicated and filtered into the report.
///
/// The order is the uncached readers' order on purpose: the duplicate rule comes first and the range
/// second, so "the first copy of a streamed answer wins" still decides which copy is counted, exactly
/// as when the two ran inside the parse loop.
fn push_event(
    report: &mut UsageReadReport,
    seen: &mut HashSet<String>,
    found: &FileEvent,
    since_ms: Option<i64>,
) {
    if let Some(key) = &found.key {
        if !seen.insert(key.clone()) {
            return;
        }
    }
    if since_ms.is_some_and(|since| found.event.at_ms < since) {
        return;
    }
    report.events.push(found.event.clone());
}

/// A file's `(size, mtime)` in the units the cache compares: bytes and nanoseconds since the epoch.
fn fingerprint(path: &Path) -> Result<(u64, u64), String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("无法打开会话文件 {}：{error}", path.display()))?;
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos() as u64);
    Ok((metadata.len(), mtime_ns))
}

/// A hash of the file's first `HEAD_SAMPLE` bytes, the part of the fingerprint that catches a
/// rewrite which kept both the length and the mtime.
fn head_sample(path: &Path) -> Option<u64> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0_u8; usize::try_from(HEAD_SAMPLE).ok()?];
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(_) => return None,
        }
    }
    buffer.truncate(filled);
    Some(fnv1a(&buffer))
}

/// A hash of the bytes just before `end`, used to tell "appended to" from "rewritten".
fn tail_sample(path: &Path, end: u64) -> Option<u64> {
    let mut file = std::fs::File::open(path).ok()?;
    let start = end.saturating_sub(TAIL_SAMPLE);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buffer = vec![0_u8; usize::try_from(end - start).ok()?];
    file.read_exact(&mut buffer).ok()?;
    Some(fnv1a(&buffer))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::agent_sessions::usage::UsageTokens;

    fn event(at_ms: i64, input: u64) -> OwnedUsageEvent {
        OwnedUsageEvent {
            at_ms,
            tool: "pi",
            provider: None,
            model: None,
            tokens: UsageTokens {
                input,
                ..UsageTokens::ZERO
            },
        }
    }

    /// One jsonl line per record: `<at> <input> [key]`.
    fn parse(line: &str) -> Option<FileEvent> {
        let mut parts = line.split_whitespace();
        let at_ms = parts.next()?.parse().ok()?;
        let input = parts.next()?.parse().ok()?;
        Some(FileEvent {
            key: parts.next().map(str::to_string),
            event: event(at_ms, input),
        })
    }

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, body).expect("write");
    }

    fn append(path: &Path, body: &str) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open");
        file.write_all(body.as_bytes()).expect("append");
    }

    fn inputs(report: &UsageReadReport) -> Vec<u64> {
        report.events.iter().map(|event| event.tokens.input).collect()
    }

    #[test]
    fn an_untouched_file_is_not_read_again() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a.jsonl");
        write(&file, "1 10\n2 20\n");
        let mut cache = UsageFileCache::default();
        let files = vec![file.clone()];
        let calls = std::cell::Cell::new(0_u32);
        let counting = |line: &str| {
            calls.set(calls.get() + 1);
            parse(line)
        };
        assert_eq!(
            inputs(&cache.read_jsonl("t", &files, None, counting)),
            [10, 20]
        );
        let first = calls.get();
        assert_eq!(first, 2, "the first read parses every line");

        // Same size, same mtime: the second read answers out of the cache and parses nothing.
        assert_eq!(
            inputs(&cache.read_jsonl("t", &files, None, counting)),
            [10, 20]
        );
        assert_eq!(calls.get(), first);
    }

    #[test]
    fn an_appended_file_adds_only_its_tail() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a.jsonl");
        write(&file, "1 10\n2 20\n");
        let mut cache = UsageFileCache::default();
        let files = vec![file.clone()];
        cache.read_jsonl("t", &files, None, parse);

        append(&file, "3 30\n");
        assert_eq!(
            inputs(&cache.read_jsonl("t", &files, None, parse)),
            [10, 20, 30]
        );
        // The evidence that the tail was resumed rather than re-read: the entry consumed the whole
        // file and did not keep the old events twice.
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn a_rewritten_file_is_read_from_the_start() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a.jsonl");
        write(&file, "1 10\n2 20\n");
        let mut cache = UsageFileCache::default();
        let files = vec![file.clone()];
        cache.read_jsonl("t", &files, None, parse);

        // Same length, different content: the size still matches but the bytes do not.
        write(&file, "1 11\n2 21\n");
        assert_eq!(
            inputs(&cache.read_jsonl("t", &files, None, parse)),
            [11, 21]
        );

        // Shorter than before: no prefix can be trusted, so the whole file is read again.
        write(&file, "9 90\n");
        assert_eq!(inputs(&cache.read_jsonl("t", &files, None, parse)), [90]);
    }

    #[test]
    fn a_duplicate_key_is_counted_once_whichever_file_holds_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let one = dir.path().join("a.jsonl");
        let two = dir.path().join("b.jsonl");
        write(&one, "1 10 msg-1\n");
        write(&two, "2 20 msg-1\n3 30 msg-2\n");
        let mut cache = UsageFileCache::default();
        let files = vec![one, two];
        // The first copy wins and the later one is dropped, which is what the readers did while
        // parsing. Add-them-up instead would count one streamed answer twice.
        assert_eq!(inputs(&cache.read_jsonl("t", &files, None, parse)), [10, 30]);
    }

    #[test]
    fn a_half_written_last_line_waits_for_its_newline() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a.jsonl");
        write(&file, "1 10\n2");
        let mut cache = UsageFileCache::default();
        let files = vec![file.clone()];
        assert_eq!(inputs(&cache.read_jsonl("t", &files, None, parse)), [10]);

        append(&file, " 20\n");
        assert_eq!(
            inputs(&cache.read_jsonl("t", &files, None, parse)),
            [10, 20]
        );
    }

    #[test]
    fn a_range_is_answered_from_the_same_events() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a.jsonl");
        write(&file, "1 10\n5 50\n9 90\n");
        let mut cache = UsageFileCache::default();
        let files = vec![file.clone()];
        assert_eq!(inputs(&cache.read_jsonl("t", &files, None, parse)), [10, 50, 90]);
        // The cache holds every event, so narrowing the range afterwards is a filter and not a read.
        assert_eq!(
            inputs(&cache.read_jsonl("t", &files, Some(5), parse)),
            [50, 90]
        );
    }

    #[test]
    fn a_file_that_stopped_being_listed_is_forgotten() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("a.jsonl");
        write(&file, "1 10\n");
        let mut cache = UsageFileCache::default();
        cache.read_jsonl("t", std::slice::from_ref(&file), None, parse);
        assert_eq!(cache.len(), 1);

        cache.read_jsonl("t", &[], None, parse);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn one_readers_files_are_not_forgotten_by_another() {
        let dir = tempfile::tempdir().expect("temp dir");
        let first = dir.path().join("a.jsonl");
        let second = dir.path().join("b.jsonl");
        write(&first, "1 10\n");
        write(&second, "2 20\n");
        let mut cache = UsageFileCache::default();
        cache.read_jsonl("claude", &[first], None, parse);
        cache.read_jsonl("pi", &[second], None, parse);
        assert_eq!(cache.len(), 2);

        // Only `pi`'s list is refilled empty; `claude`'s entry must survive.
        cache.read_jsonl("pi", &[], None, parse);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn a_whole_file_reader_reuses_an_unchanged_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let file = dir.path().join("session.v4.jsonl.zstd");
        write(&file, "1 10\n2 20\n");
        let mut cache = UsageFileCache::default();
        let files = vec![file.clone()];
        let read = |path: &Path| -> (Vec<FileEvent>, Option<String>) {
            match std::fs::read_to_string(path) {
                Ok(body) => (body.lines().filter_map(parse).collect(), None),
                Err(error) => (Vec::new(), Some(error.to_string())),
            }
        };
        assert_eq!(inputs(&cache.read_whole("dsh", &files, None, read)), [10, 20]);
        write(&file, "1 10\n2 20\n3 30\n");
        assert_eq!(
            inputs(&cache.read_whole("dsh", &files, None, read)),
            [10, 20, 30]
        );
    }
}
