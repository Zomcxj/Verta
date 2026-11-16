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
//! The rule is "a cell only grows": the larger of the stored cell and the read cell wins. A session that
//! is deleted makes the read smaller and the archive keeps what it had; a session that is re-read at the
//! same size changes nothing, so reading twice is reading once.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::modules::agent_sessions::usage::{CellUsage, DayUsage, UsageTokens, UsageTotals};

/// The archive's file name, inside the app's data directory (next to `verta-settings.json`).
pub const ARCHIVE_FILE: &str = "verta-usage-archive.json";

/// Bumped only when the shape on disk changes in a way an older file cannot be read as.
const VERSION: u32 = 1;

/// Every cell this machine has ever reported, by day.
///
/// `offset_minutes` is the day boundary the keys were bucketed with, kept for the reader rather than
/// used by it: a later read under another offset writes its own days and leaves the old keys alone, so
/// an older day keeps the calendar day it was counted on (the alternative - re-bucketing history from
/// instants the archive does not keep - is not available).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Archive {
    pub version: u32,
    pub offset_minutes: i32,
    /// Keyed by `usage::day_of`, so `BTreeMap` is already the order a report wants (oldest first).
    ///
    /// This half is what the reads saw, and a read recounts a cell from scratch, so it merges by "the
    /// larger cell wins".
    pub days: BTreeMap<i64, Vec<ArchiveCell>>,
    /// The imported half: usage another tool archived for sessions this machine no longer has.
    ///
    /// Kept apart from `days` because the two are different kinds of statement - a read says "this is
    /// what that cell holds", an import says "this much more happened" - and merging a contribution with
    /// a recount by size would silently drop one of them. `#[serde(default)]` so a file written before
    /// the seed existed still loads.
    #[serde(default)]
    pub seeded: BTreeMap<i64, Vec<ArchiveCell>>,
}

impl Default for Archive {
    fn default() -> Self {
        Self {
            version: VERSION,
            offset_minutes: 0,
            days: BTreeMap::new(),
            seeded: BTreeMap::new(),
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

/// Whether two cells are the same cell (the same day is the map key).
fn same_cell(left: &ArchiveCell, right: &ArchiveCell) -> bool {
    left.tool == right.tool && left.provider == right.provider && left.model == right.model
}

impl Archive {
    /// Fold a report's days in, keeping whichever cell is larger.
    ///
    /// Whole cells, not fields: a cell's parts and its total have to describe the same amount, and a
    /// per-field maximum would assemble a cell that no read ever produced.
    pub fn merge_days(&mut self, days: &[DayUsage]) {
        for day in days {
            let stored = self.days.entry(day.day).or_default();
            for cell in &day.cells {
                let incoming = ArchiveCell {
                    tool: cell.tool.clone(),
                    provider: cell.provider.clone(),
                    model: cell.model.clone(),
                    parts: cell.totals.tokens,
                    events: cell.totals.events,
                };
                match stored.iter_mut().find(|held| same_cell(held, &incoming)) {
                    Some(held) => {
                        if incoming.parts.total() > held.parts.total() {
                            *held = incoming;
                        }
                    }
                    None => stored.push(incoming),
                }
            }
        }
    }

    /// Replace the imported half: usage another tool archived for sessions this machine no longer has.
    ///
    /// Replaced, not added to, so running the import twice leaves the same archive. Two seeded cells of
    /// one day, tool, provider and model are two sessions' worth of usage and are summed: a seed is a
    /// contribution, and it never recounts the cell it lands in.
    pub fn seed(&mut self, days: &[DayUsage]) {
        let mut seeded: BTreeMap<i64, Vec<ArchiveCell>> = BTreeMap::new();
        for day in days {
            let bucket = seeded.entry(day.day).or_default();
            for cell in &day.cells {
                let incoming = ArchiveCell {
                    tool: cell.tool.clone(),
                    provider: cell.provider.clone(),
                    model: cell.model.clone(),
                    parts: cell.totals.tokens,
                    events: cell.totals.events,
                };
                match bucket.iter_mut().find(|held| same_cell(held, &incoming)) {
                    Some(held) => {
                        held.parts += incoming.parts;
                        held.events = held.events.saturating_add(incoming.events);
                    }
                    None => bucket.push(incoming),
                }
            }
        }
        self.seeded = seeded;
    }

    /// The archive as report days, oldest first, each day's totals summed from its cells.
    ///
    /// The imported half is added onto the read half cell by cell: a day only the import knows keeps its
    /// seeded cells, and a day both know adds them together.
    pub fn days(&self) -> Vec<DayUsage> {
        let mut by_day: BTreeMap<i64, Vec<ArchiveCell>> = BTreeMap::new();
        for (day, cells) in &self.days {
            by_day.entry(*day).or_default().extend(cells.iter().cloned());
        }
        for (day, cells) in &self.seeded {
            let bucket = by_day.entry(*day).or_default();
            for cell in cells {
                match bucket.iter_mut().find(|held| same_cell(held, cell)) {
                    Some(held) => {
                        held.parts += cell.parts;
                        held.events = held.events.saturating_add(cell.events);
                    }
                    None => bucket.push(cell.clone()),
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
                    totals,
                    cells,
                }
            })
            .collect()
    }

    /// Write the archive, atomically: a half-written file must never be the one a later read finds.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|why| format!("{why}"))?;
        }
        let json = serde_json::to_vec(self).map_err(|why| format!("{why}"))?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, json).map_err(|why| format!("{why}"))?;
        std::fs::rename(&temp, path).map_err(|why| format!("{why}"))
    }
}

/// Read the archive, and say why when it could not be read.
///
/// A missing file is not a failure: it is the first run. A file that cannot be parsed is reported and
/// treated as empty - the live read is still worth showing, and a window that refused to open because a
/// cache file was truncated would be worse than a window with yesterday's numbers missing.
pub fn load(path: &Path) -> (Archive, Vec<String>) {
    match std::fs::read(path) {
        Err(why) if why.kind() == std::io::ErrorKind::NotFound => (Archive::default(), Vec::new()),
        Err(why) => (
            Archive::default(),
            vec![format!(
                "the usage archive could not be read ({}): {why}",
                path.display()
            )],
        ),
        Ok(bytes) => match serde_json::from_slice::<Archive>(&bytes) {
            Ok(mut archive) => {
                archive.version = VERSION;
                (archive, Vec::new())
            }
            Err(why) => (
                Archive::default(),
                vec![format!(
                    "the usage archive could not be read ({}): {why}",
                    path.display()
                )],
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_day_keeps_the_larger_of_two_reads() {
        let mut archive = Archive::default();
        archive.merge_days(&[day(0, "opencode", "m", 100)]);
        archive.merge_days(&[day(0, "opencode", "m", 60)]); // a session was deleted
        assert_eq!(archive.days()[0].totals.tokens.total(), 100);
        archive.merge_days(&[day(0, "opencode", "m", 160)]);
        assert_eq!(archive.days()[0].totals.tokens.total(), 160);
    }

    #[test]
    fn cells_are_apart_by_tool_provider_and_model() {
        let mut archive = Archive::default();
        archive.merge_days(&[day(0, "opencode", "m", 100)]);
        archive.merge_days(&[day(0, "claude", "m", 100)]);
        archive.merge_days(&[day(0, "opencode", "m2", 100)]);
        assert_eq!(archive.days()[0].cells.len(), 3);
        assert_eq!(archive.days()[0].totals.tokens.total(), 300);
    }

    #[test]
    fn a_corrupt_file_reads_as_empty_and_says_why() {
        let dir = std::env::temp_dir().join("verta-archive-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("corrupt.json");
        std::fs::write(&path, b"{not json").unwrap();
        let (archive, failures) = load(&path);
        assert!(archive.days.is_empty());
        assert_eq!(failures.len(), 1);
        assert!(failures[0].contains("archive"));
    }

    #[test]
    fn saving_and_loading_round_trips() {
        let mut archive = Archive::default();
        archive.merge_days(&[day(20691, "pi", "gpt", 42)]);
        let path = std::env::temp_dir().join("verta-archive-test/round-trip.json");
        archive.save(&path).unwrap();
        let (loaded, failures) = load(&path);
        assert!(failures.is_empty());
        assert_eq!(loaded.days(), archive.days());
    }

    #[test]
    fn a_seeded_cell_adds_to_the_read_cell_on_the_same_day() {
        // A seed is a contribution, not a recount: a read counts the sessions still on disk, and a seed
        // counts the ones that are gone (`scripts/dev/import-token-monitor-archive.py`). Two cells of the
        // same day and model therefore add up - the one place "a cell only grows" does not apply.
        let mut archive = Archive::default();
        archive.merge_days(&[day(0, "opencode", "m", 100)]);
        archive.seed(&[day(0, "opencode", "m", 40)]);
        assert_eq!(archive.days()[0].totals.tokens.total(), 140);
        // Seeding again replaces the seeded half instead of adding to it, so a second run of the import
        // is the same archive as the first.
        archive.seed(&[day(0, "opencode", "m", 40)]);
        assert_eq!(archive.days()[0].totals.tokens.total(), 140);
    }

    #[test]
    fn a_seed_keeps_its_own_cells_together() {
        // Two sessions seeded into the same day and model are two contributions to that cell.
        let mut archive = Archive::default();
        archive.seed(&[day(7, "opencode", "m", 30), day(7, "opencode", "m", 12)]);
        assert_eq!(archive.days()[0].totals.tokens.total(), 42);
        assert_eq!(archive.days()[0].cells.len(), 1);
    }
}
