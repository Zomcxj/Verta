//! The usage archive: what this machine has already been billed for, kept across reads.
//!
//! A usage window re-reads every store from scratch (`sinceMs: null`), so its numbers are a picture of
//! what the sources hold *now* - and a session somebody deleted takes its tokens out of the picture. That
//! is what a user reported as "有些删除的会话 tokenmonitor 有记录 你这没有": another tool kept an archive,
//! this one had only a snapshot (`usageCache.ts` is one key, overwritten by the next read).
//!
//! So each read is folded into a file and the report is built from the fold. What is stored is the same
//! cells the window draws with - one day, one tool, one provider, one model - because raw events carry no
//! identity: the next scan reads the same messages again, and a list of events would count them twice.
//!
//! Two halves, because the two are different kinds of statement:
//!
//! - `days` is what the reads saw. A read recounts a cell from scratch, so a cell only grows: the larger
//!   of the stored cell and the read cell wins. A deleted session makes the read smaller and the archive
//!   keeps what it had; a session re-read at the same size changes nothing.
//! - `seeded` is what another tool archived for sessions that are gone. It is a contribution, so it is
//!   added onto the read half rather than compared with it - merging a contribution into a recount by size
//!   silently drops one of them.
//!
//! Both halves are kept **per offset**: a day index is only a day together with the boundary it was
//! counted on, and a file that folded two boundaries into one map would count the same usage twice the
//! first time somebody's time zone moved. Each offset's days stay on disk under their own key, so changing
//! back finds them again.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::modules::agent_sessions::usage::{CellUsage, DayUsage, UsageTokens, UsageTotals};

/// The archive's file name, inside the app's data directory (next to `verta-settings.json`).
pub const ARCHIVE_FILE: &str = "verta-usage-archive.json";

/// Bumped when the shape on disk changes. Version 1 had one flat map of days and no offset partition; a
/// file of that shape is still read (`LegacyArchive`) and folded into the offset it was written with.
const VERSION: u32 = 2;

/// One offset's days: day index -> the cells of that day.
type Days = BTreeMap<i64, Vec<ArchiveCell>>;

/// The archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub version: u32,
    /// The offset the file was last written with. Informational: which days are read is decided per call.
    pub offset_minutes: i32,
    /// What the reads saw, per offset from UTC (minutes).
    pub days: BTreeMap<i32, Days>,
    /// What another tool archived for sessions this machine no longer has, per offset from UTC.
    #[serde(default)]
    pub seeded: BTreeMap<i32, Days>,
    /// Everything this type does not know about, written back untouched.
    ///
    /// The import script keeps its record of which sessions it left to the live reads in here, and a read
    /// that dropped it would make the next import count those sessions a second time.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

impl Default for Archive {
    fn default() -> Self {
        Self {
            version: VERSION,
            offset_minutes: 0,
            days: BTreeMap::new(),
            seeded: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

/// One tool/provider/model of one day, as the report had it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveCell {
    pub tool: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub parts: UsageTokens,
    pub events: u32,
}

impl ArchiveCell {
    fn of(cell: &CellUsage) -> Self {
        Self {
            tool: cell.tool.clone(),
            provider: cell.provider.clone(),
            model: cell.model.clone(),
            parts: cell.totals.tokens,
            events: cell.totals.events,
        }
    }
}

/// Whether two cells are the same cell (the same day is the map key).
fn same_cell(left: &ArchiveCell, right: &ArchiveCell) -> bool {
    left.tool == right.tool && left.provider == right.provider && left.model == right.model
}

/// How an incoming cell meets one already in the bucket.
#[derive(Clone, Copy)]
enum Fold {
    /// A recount: whichever cell is larger stands.
    KeepLarger,
    /// A contribution: the two add up.
    Add,
}

fn fold(bucket: &mut Vec<ArchiveCell>, incoming: ArchiveCell, how: Fold) {
    match bucket.iter_mut().find(|held| same_cell(held, &incoming)) {
        Some(held) => match how {
            Fold::KeepLarger => {
                if incoming.parts.total() > held.parts.total() {
                    *held = incoming;
                }
            }
            Fold::Add => {
                held.parts += incoming.parts;
                held.events = held.events.saturating_add(incoming.events);
            }
        },
        None => bucket.push(incoming),
    }
}

impl Archive {
    /// Fold a report's days into the read half for one offset, keeping whichever cell is larger.
    ///
    /// Whole cells, not fields: a cell's parts and its total have to describe the same amount, and a
    /// per-field maximum would assemble a cell that no read ever produced.
    pub fn merge_days(&mut self, days: &[DayUsage], offset_minutes: i32) {
        let section = self.days.entry(offset_minutes).or_default();
        for day in days {
            let bucket = section.entry(day.day).or_default();
            for cell in &day.cells {
                fold(bucket, ArchiveCell::of(cell), Fold::KeepLarger);
            }
        }
    }

    /// The archive as report days for one offset, oldest first, each day's totals summed from its cells.
    ///
    /// Only this offset's halves are read: days counted on another boundary are a different calendar, and
    /// adding the two would count every day whose boundary is crossed twice.
    pub fn days(&self, offset_minutes: i32) -> Vec<DayUsage> {
        let mut by_day: BTreeMap<i64, Vec<ArchiveCell>> = BTreeMap::new();
        if let Some(read) = self.days.get(&offset_minutes) {
            for (day, cells) in read {
                let bucket = by_day.entry(*day).or_default();
                for cell in cells {
                    fold(bucket, cell.clone(), Fold::KeepLarger);
                }
            }
        }
        if let Some(seeded) = self.seeded.get(&offset_minutes) {
            for (day, cells) in seeded {
                let bucket = by_day.entry(*day).or_default();
                for cell in cells {
                    fold(bucket, cell.clone(), Fold::Add);
                }
            }
        }
        by_day
            .iter()
            .map(|(day, cells)| {
                let mut totals = UsageTotals::default();
                let cells: Vec<CellUsage> = cells
                    .iter()
                    .map(|cell| {
                        totals.tokens += cell.parts;
                        totals.events = totals.events.saturating_add(cell.events);
                        CellUsage {
                            tool: cell.tool.clone(),
                            provider: cell.provider.clone(),
                            model: cell.model.clone(),
                            totals: UsageTotals {
                                tokens: cell.parts,
                                events: cell.events,
                            },
                        }
                    })
                    .collect();
                DayUsage {
                    day: *day,
                    cells,
                    totals,
                }
            })
            .collect()
    }

    /// Write the archive, atomically.
    ///
    /// The temporary file is unique per write: `fs::write` opens, truncates and writes, so two writes
    /// sharing one temporary name would interleave into a third thing and the rename would publish it -
    /// the "atomic" write would be the least atomic part of this.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|why| format!("{why}"))?;
        }
        let json = serde_json::to_vec(self).map_err(|why| format!("{why}"))?;
        let temp = path.with_extension(format!("json.tmp-{}-{}", std::process::id(), stamp()));
        std::fs::write(&temp, json).map_err(|why| format!("{why}"))?;
        // Two writers renaming onto one path at the same moment can collide on Windows instead of
        // queueing (a sharing violation, not a corruption), so this retries briefly. Nothing is ever
        // published half-written: the temporary file is the reason a retry is safe.
        let mut last = None;
        for attempt in 0..6 {
            match std::fs::rename(&temp, path) {
                Ok(()) => return Ok(()),
                Err(why) => {
                    last = Some(why);
                    if attempt < 5 {
                        std::thread::sleep(std::time::Duration::from_millis(4 * (attempt + 1)));
                    }
                }
            }
        }
        Err(format!("{}", last.expect("a rename was attempted")))
    }
}

/// A stamp no two calls share.
///
/// Milliseconds alone are not enough: two writes in the same millisecond would pick the same temporary
/// name, and the first rename would take the second one's file with it (`os error 2`). The counter makes
/// it unique within the process; the process id makes it unique across them.
fn stamp() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{millis}-{sequence}")
}

/// The version 1 shape: one flat map of days, no offset partition.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyArchive {
    offset_minutes: i32,
    #[serde(default)]
    days: Days,
    #[serde(default)]
    seeded: Days,
}

/// Read the archive, and say why when it could not be read.
///
/// A missing file is not a failure: it is the first run. A file that cannot be parsed is **moved aside**
/// and reported, then treated as empty - the live read is still worth showing, and that file is the only
/// copy of the tokens the deleted sessions were billed for, so a truncated read must not be the reason
/// they disappear. The next write starts a fresh file beside it.
pub fn load(path: &Path) -> (Archive, Vec<String>) {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => {
            return (Archive::default(), Vec::new())
        }
        Err(why) => {
            return (
                Archive::default(),
                vec![format!("用量归档读不出来（{}）：{why}", path.display())],
            )
        }
    };
    if let Ok(mut archive) = serde_json::from_slice::<Archive>(&bytes) {
        archive.version = VERSION;
        return (archive, Vec::new());
    }
    // A file from before the offset partition: read it as the single boundary it was written with.
    if let Ok(legacy) = serde_json::from_slice::<LegacyArchive>(&bytes) {
        let mut archive = Archive {
            version: VERSION,
            offset_minutes: legacy.offset_minutes,
            ..Default::default()
        };
        if !legacy.days.is_empty() {
            archive.days.insert(legacy.offset_minutes, legacy.days);
        }
        if !legacy.seeded.is_empty() {
            archive.seeded.insert(legacy.offset_minutes, legacy.seeded);
        }
        return (archive, Vec::new());
    }
    let aside = path.with_extension(format!("bad-{}.json", stamp()));
    let note = match std::fs::rename(path, &aside) {
        Ok(()) => format!(
            "用量归档读不出来（{}）；原文件已移到 {}",
            path.display(),
            aside.display()
        ),
        Err(move_why) => format!(
            "用量归档读不出来（{}），原文件也移不走：{move_why}",
            path.display()
        ),
    };
    (Archive::default(), vec![note])
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFSET: i32 = 480;

    /// One day with a single cell, the way `aggregate` hands them over.
    fn day(day: i64, tool: &str, model: &str, tokens: u64) -> DayUsage {
        let totals = UsageTotals {
            tokens: UsageTokens {
                input: tokens,
                ..Default::default()
            },
            events: 1,
        };
        DayUsage {
            day,
            totals,
            cells: vec![CellUsage {
                tool: tool.to_string(),
                provider: Some("p".to_string()),
                model: Some(model.to_string()),
                totals,
            }],
        }
    }

    /// Put cells into the imported half, the way `scripts/dev/import-token-monitor-archive.py` writes
    /// them into the file. Test-only: the import is the script's job, and the binary has no reason to
    /// carry a second writer for it.
    fn seed(archive: &mut Archive, days: &[DayUsage], offset_minutes: i32) {
        let section = archive.seeded.entry(offset_minutes).or_default();
        for day in days {
            let bucket = section.entry(day.day).or_default();
            for cell in &day.cells {
                bucket.push(ArchiveCell::of(cell));
            }
        }
    }

    /// A directory of this run's own: the tests write real files, and a shared one left the last run's
    /// `.bad-` copies behind for the next assertion to count.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "verta-archive-test-{}-{name}-{}",
            std::process::id(),
            stamp()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn total(archive: &Archive, offset_minutes: i32) -> u64 {
        archive
            .days(offset_minutes)
            .iter()
            .map(|day| day.totals.tokens.total())
            .sum()
    }

    #[test]
    fn a_day_keeps_the_larger_of_two_reads() {
        let mut archive = Archive::default();
        archive.merge_days(&[day(0, "opencode", "m", 100)], OFFSET);
        archive.merge_days(&[day(0, "opencode", "m", 60)], OFFSET); // a session was deleted
        assert_eq!(total(&archive, OFFSET), 100);
        archive.merge_days(&[day(0, "opencode", "m", 160)], OFFSET);
        assert_eq!(total(&archive, OFFSET), 160);
    }

    #[test]
    fn cells_are_apart_by_tool_provider_and_model() {
        let mut archive = Archive::default();
        archive.merge_days(&[day(0, "opencode", "m", 100)], OFFSET);
        archive.merge_days(&[day(0, "claude", "m", 100)], OFFSET);
        archive.merge_days(&[day(0, "opencode", "m2", 100)], OFFSET);
        assert_eq!(archive.days(OFFSET)[0].cells.len(), 3);
        assert_eq!(total(&archive, OFFSET), 300);
    }

    #[test]
    fn a_seeded_cell_adds_to_the_read_cell_on_the_same_day() {
        // A seed is a contribution, not a recount: a read counts the sessions still on disk, and a seed
        // counts the ones that are gone. Two cells of the same day and model therefore add up - the one
        // place "a cell only grows" does not apply.
        let mut archive = Archive::default();
        archive.merge_days(&[day(0, "opencode", "m", 100)], OFFSET);
        seed(&mut archive, &[day(0, "opencode", "m", 40)], OFFSET);
        assert_eq!(total(&archive, OFFSET), 140);
        // A second import replaces the half instead of adding to it, which is why running the script
        // twice writes the same archive.
        archive.seeded.clear();
        seed(&mut archive, &[day(0, "opencode", "m", 40)], OFFSET);
        assert_eq!(total(&archive, OFFSET), 140);
    }

    #[test]
    fn every_seeded_cell_of_a_day_is_counted() {
        // Two sessions' worth of usage on one day and model are two contributions to that day.
        let mut archive = Archive::default();
        seed(&mut archive, &[day(7, "opencode", "m", 30), day(7, "opencode", "m", 12)], OFFSET);
        assert_eq!(total(&archive, OFFSET), 42);
    }

    #[test]
    fn a_changed_offset_does_not_count_the_same_usage_twice() {
        // The same days arriving under another boundary are another calendar, not more usage. Folding
        // them into one map is what made a time-zone change inflate the total for good.
        let mut archive = Archive::default();
        archive.merge_days(&[day(100, "opencode", "m", 100)], OFFSET);
        archive.merge_days(&[day(100, "opencode", "m", 100)], 0);
        assert_eq!(total(&archive, OFFSET), 100);
        assert_eq!(total(&archive, 0), 100);
        // And going back to the first boundary finds its own days, unchanged.
        assert_eq!(total(&archive, OFFSET), 100);
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_instead_of_overwritten() {
        let dir = scratch("corrupt");
        let path = dir.join("archive.json");
        std::fs::write(&path, b"{not json").unwrap();
        let (archive, failures) = load(&path);
        assert!(archive.days.is_empty());
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("用量归档"), "{}", failures[0]);
        // The bytes are gone from where a later write would truncate them, and kept where a person can
        // find them: this file is the only copy of the tokens the deleted sessions were billed for.
        assert!(!path.exists());
        let kept: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("archive.bad-"))
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
    }

    #[test]
    fn a_file_from_before_the_offsets_existed_still_loads() {
        // The file this machine already had: one flat map of days plus a seeded half, with the offset it
        // was bucketed with. Losing it would mean re-importing 7.8e9 tokens by hand.
        let dir = scratch("legacy");
        let path = dir.join("archive.json");
        std::fs::write(
            &path,
            br#"{"version":1,"offsetMinutes":480,
                 "days":{"100":[{"tool":"opencode","provider":"p","model":"m","parts":{"input":70},"events":1}]},
                 "seeded":{"200":[{"tool":"opencode","provider":"p","model":"m","parts":{"input":30},"events":1}]}}"#,
        )
        .unwrap();
        let (archive, failures) = load(&path);
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(total(&archive, OFFSET), 100);
        // Not under another boundary: the file was counted on 480 and says so.
        assert_eq!(total(&archive, 0), 0);
    }

    #[test]
    fn saving_and_loading_round_trips() {
        let mut archive = Archive::default();
        archive.merge_days(&[day(20691, "pi", "gpt", 42)], OFFSET);
        archive
            .extra
            .insert("skipped".to_string(), serde_json::json!({"opencode": ["ses_1"]}));
        let path = scratch("round-trip").join("archive.json");
        archive.save(&path).unwrap();
        let (loaded, failures) = load(&path);
        assert!(failures.is_empty());
        assert_eq!(loaded.days(OFFSET), archive.days(OFFSET));
        // Fields this type does not know are written back: the import keeps its record in one.
        assert!(loaded.extra.contains_key("skipped"));
    }

    #[test]
    fn concurrent_saves_leave_one_readable_archive() {
        // The window can ask twice at once, and each ask writes the same path from the blocking pool.
        let path = scratch("concurrent").join("archive.json");
        let mut archive = Archive::default();
        archive.merge_days(&[day(1, "opencode", "m", 5)], OFFSET);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let archive = archive.clone();
                let path = path.clone();
                std::thread::spawn(move || archive.save(&path))
            })
            .collect();
        for thread in threads {
            let result = thread.join().unwrap();
            assert!(result.is_ok(), "{:?}", result.err());
        }
        let (loaded, failures) = load(&path);
        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(total(&loaded, OFFSET), 5);
    }
}
