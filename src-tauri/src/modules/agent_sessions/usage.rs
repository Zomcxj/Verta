//! Usage over time and per model: the layer a usage window is built on.
//!
//! `stats.rs` answers one session at a time - turns, tokens, when it was last talked to. This answers
//! the two questions a window asks and a session list cannot: how much was used **per day**, and how
//! much **per model**. It is pure logic, like `stats.rs`: the readers (transcripts, the opencode
//! database) produce events, and this folds them.
//!
//! Three things are deliberately *not* decided here, because they are questions about the user's
//! accounting rather than about the data:
//!
//! - **which tokens count**: the parts are kept separately (input, output, cache read, cache write,
//!   and whatever a tool only reports as a total), and `TokenScope` decides afterwards. Reading is
//!   the expensive part; a window that lets the user switch cache reads in and out must not have to
//!   read the transcripts again.
//! - **where a day begins**: `offset_minutes` is the caller's time zone, and the same events answer
//!   differently under different offsets. Local days and UTC days are both one call away.
//! - **what a provider is**: `provider` and `model` are the caller's strings. The tool that wrote
//!   the record decides how to name them ("anthropic", "opencode"); this module only groups.

use serde::Serialize;

use super::stats::{as_u64, days_from_civil};

/// Tokens one event used, in the classes the tools themselves separate.
///
/// `unsplit` is for a tool that reports only a total for some events (pi writes `totalTokens` on its
/// own, without the four parts): those tokens are counted, and there is nothing to attribute them
/// to. `reasoning` is its own class because opencode counts thinking tokens separately and putting
/// them in `output` would invent a different number from the one the tool shows its own user.
/// Adding every field is the event's total.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub unsplit: u64,
}

impl UsageTokens {
    pub const ZERO: Self = Self {
        input: 0,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
        unsplit: 0,
    };

    /// Everything this event used, whatever class it is in.
    pub fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.reasoning)
            .saturating_add(self.cache_read)
            .saturating_add(self.cache_write)
            .saturating_add(self.unsplit)
    }
}

impl std::ops::AddAssign for UsageTokens {
    fn add_assign(&mut self, other: Self) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.reasoning = self.reasoning.saturating_add(other.reasoning);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.unsplit = self.unsplit.saturating_add(other.unsplit);
    }
}

/// Which token classes a report counts.
///
/// Cache reads and writes are the two that tools bill differently and people argue about: a cache
/// read is a prompt served from the provider's cache, and whether it belongs in "how much did I use"
/// is a matter of taste. Keeping both switches here means the answer is one call, not a re-read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenScope {
    pub cache_read: bool,
    pub cache_write: bool,
}

impl TokenScope {
    /// Everything the tool reported.
    pub const ALL: Self = Self {
        cache_read: true,
        cache_write: true,
    };
    /// Input and output only, plus tokens a tool did not split.
    pub const WITHOUT_CACHE: Self = Self {
        cache_read: false,
        cache_write: false,
    };

    /// How many tokens these events are worth under this scope.
    pub fn counted(&self, tokens: &UsageTokens) -> u64 {
        let mut total = tokens.input.saturating_add(tokens.output);
        total = total.saturating_add(tokens.reasoning);
        total = total.saturating_add(tokens.unsplit);
        if self.cache_read {
            total = total.saturating_add(tokens.cache_read);
        }
        if self.cache_write {
            total = total.saturating_add(tokens.cache_write);
        }
        total
    }
}

/// One thing that happened and cost tokens.
///
/// `at_ms` is when the tool says it happened; `tool` is which agent wrote the record (`claude`,
/// `pi` or `opencode`), the one attribution every reader always knows; `provider`/`model` are the
/// names the record itself gives for what answered (`None` when it does not say one).
#[derive(Debug, Clone, Copy)]
pub struct UsageEvent<'a> {
    pub at_ms: i64,
    pub tool: &'a str,
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub tokens: UsageTokens,
}

/// A sum of events: the raw parts, and how many events went into them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub tokens: UsageTokens,
    /// Events counted (one per assistant message or session row, depending on the reader).
    pub events: u32,
}

impl UsageTotals {
    pub fn counted(&self, scope: TokenScope) -> u64 {
        scope.counted(&self.tokens)
    }

    fn add(&mut self, event: &UsageEvent<'_>) {
        self.tokens += event.tokens;
        self.events = self.events.saturating_add(1);
    }
}

/// One tool/provider/model triple inside one day: the finest split a window draws with.
///
/// A day is the only bucket that has to be stable over time (its label is a calendar date); this is
/// that bucket broken down, and every view a window offers is a slice of it: the trend chart stacks
/// cells by model within the day, the heatmap uses the day's total, the tool and model tables are
/// sums over the days in the range, and the composition bar is the sum of every cell's parts. So one
/// read answers all of them and changing the range is a sum over a slice, not another scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellUsage {
    pub tool: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub totals: UsageTotals,
}

/// One day (`day` is a day index: days since 1970-01-01 in the caller's offset).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: i64,
    pub totals: UsageTotals,
    /// Biggest first, so a chart that draws the first few and folds the rest does not have to sort
    /// what was already ordered.
    pub cells: Vec<CellUsage>,
}

/// One tool's totals over the whole report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    pub tool: String,
    pub totals: UsageTotals,
}

/// One provider/model pair. Both are `None` for what a record did not name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub totals: UsageTotals,
}

/// The three answers a window draws: the total, the same split by day, and by model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub totals: UsageTotals,
    /// Oldest first, one entry per day that had any event.
    pub days: Vec<DayUsage>,
    /// Biggest first (by raw total), the unnamed bucket last when it ties.
    pub models: Vec<ModelUsage>,
    /// The same rule, keyed by the tool that wrote the record.
    pub tools: Vec<ToolUsage>,
}

/// Which day an instant falls in, for the given offset from UTC in minutes.
///
/// `offset_minutes` is the caller's call, not a guess: 0 is a UTC day, 480 is UTC+8, -300 is UTC-5.
/// Days are counted from 1970-01-01 and floor towards the past, so an instant before the epoch lands
/// in the day it really belongs to rather than in day zero.
pub fn day_of(at_ms: i64, offset_minutes: i32) -> i64 {
    let shifted = at_ms.saturating_add(i64::from(offset_minutes) * 60_000);
    shifted.div_euclid(86_400_000)
}

/// `YYYY-MM-DD` for a day index, the inverse of `day_of`'s counting.
///
/// Kept here because an export or a chart axis needs a date string and the conversion is easy to get
/// wrong (it is the reverse of the civil-days arithmetic `stats.rs` uses).
pub fn day_label(day: i64) -> String {
    let (year, month, date) = civil_from_days(day);
    format!("{year:04}-{month:02}-{date:02}")
}

/// Days since 1970-01-01 to a calendar date. The inverse of `stats::days_from_civil`.
fn civil_from_days(day: i64) -> (i64, i64, i64) {
    let z = day + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let date = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, date)
}

/// Fold events into a total, a per-day split and a per-model split.
///
/// Scope is not applied here on purpose: `UsageTotals::counted` does that, so one read answers every
/// accounting question the window offers.
pub fn aggregate<'a, I>(events: I, offset_minutes: i32) -> UsageReport
where
    I: IntoIterator<Item = UsageEvent<'a>>,
{
    let mut report = UsageReport {
        totals: UsageTotals::default(),
        days: Vec::new(),
        models: Vec::new(),
        tools: Vec::new(),
    };
    // Day -> (tool, provider, model) -> totals, a `BTreeMap` at every level: two reads of the same
    // events then answer in the same order, so nothing a window draws moves on its own.
    type CellKey = (String, Option<String>, Option<String>);
    let mut days: std::collections::BTreeMap<i64, std::collections::BTreeMap<CellKey, UsageTotals>> =
        Default::default();
    let mut models: std::collections::BTreeMap<(Option<String>, Option<String>), UsageTotals> =
        Default::default();
    let mut tools: std::collections::BTreeMap<String, UsageTotals> = Default::default();
    for event in events {
        report.totals.add(&event);
        let model_key = (
            event.provider.map(str::to_string),
            event.model.map(str::to_string),
        );
        days.entry(day_of(event.at_ms, offset_minutes))
            .or_default()
            .entry((
                event.tool.to_string(),
                model_key.0.clone(),
                model_key.1.clone(),
            ))
            .or_default()
            .add(&event);
        models.entry(model_key).or_default().add(&event);
        tools.entry(event.tool.to_string()).or_default().add(&event);
    }
    report.days = days
        .into_iter()
        .map(|(day, cells)| {
            // The day's own total is the sum of its cells, never a separate number: a day total that
            // disagrees with the bars drawn from it is the one bug this shape rules out.
            let mut totals = UsageTotals::default();
            let mut rows: Vec<CellUsage> = cells
                .into_iter()
                .map(|((tool, provider, model), totals)| CellUsage {
                    tool,
                    provider,
                    model,
                    totals,
                })
                .collect();
            for row in &rows {
                totals.tokens += row.totals.tokens;
                totals.events = totals.events.saturating_add(row.totals.events);
            }
            sort_cells(&mut rows);
            DayUsage {
                day,
                totals,
                cells: rows,
            }
        })
        .collect();
    report.models = models
        .into_iter()
        .map(|((provider, model), totals)| ModelUsage {
            provider,
            model,
            totals,
        })
        .collect();
    report.tools = tools
        .into_iter()
        .map(|(tool, totals)| ToolUsage { tool, totals })
        .collect();
    // Biggest first, and a stable order among equals: the window draws these as bars, and bars that
    // move between two reads of the same data are a bug the eye reads as change.
    report.models.sort_by(|left, right| {
        right
            .totals
            .tokens
            .total()
            .cmp(&left.totals.tokens.total())
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.model.cmp(&right.model))
    });
    report.tools.sort_by(|left, right| {
        right
            .totals
            .tokens
            .total()
            .cmp(&left.totals.tokens.total())
            .then_with(|| left.tool.cmp(&right.tool))
    });
    report
}

/// Biggest first, with a stable order among equals: a chart draws the first few cells and folds the
/// rest, so a cell that swapped places between two reads would move a bar's colour.
fn sort_cells(cells: &mut [CellUsage]) {
    cells.sort_by(|left, right| {
        right
            .totals
            .tokens
            .total()
            .cmp(&left.totals.tokens.total())
            .then_with(|| left.tool.cmp(&right.tool))
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.model.cmp(&right.model))
    });
}

/// What one transcript line says about a single answer: its cost and who gave it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LineUsage {
    pub tokens: UsageTokens,
    /// The provider the record names, when it names one. Claude Code's transcripts do not; pi's
    /// messages do (`openai_agentrouter`); opencode's messages do (`workbuddy`).
    pub provider: Option<String>,
    pub model: Option<String>,
}

/// A usage event that owns its names, which is what a reader returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedUsageEvent {
    pub at_ms: i64,
    /// Which agent wrote the record. Static because there are three tools and their names are in
    /// the code, not in the data.
    pub tool: &'static str,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tokens: UsageTokens,
}

impl OwnedUsageEvent {
    /// The borrowed shape `aggregate` takes.
    pub fn as_event(&self) -> UsageEvent<'_> {
        UsageEvent {
            at_ms: self.at_ms,
            tool: self.tool,
            provider: self.provider.as_deref(),
            model: self.model.as_deref(),
            tokens: self.tokens,
        }
    }
}

/// Reads a tool's records: the events it can see, oldest first, and what could not be read.
///
/// One tool failing must not hide another's numbers, so failures are collected rather than returned
/// (the same rule the session list follows), and an unreadable file is a failure only when *nothing*
/// in its store could be read.
#[derive(Debug, Default)]
pub struct UsageReadReport {
    pub events: Vec<OwnedUsageEvent>,
    pub failures: Vec<String>,
}

impl UsageReadReport {
    /// Fold what was read into the report shape a window draws.
    pub fn aggregate(&self, offset_minutes: i32) -> UsageReport {
        aggregate(self.events.iter().map(OwnedUsageEvent::as_event), offset_minutes)
    }
}

/// A Claude Code transcript line's cost, when it is an assistant message with usage.
///
/// Anthropic's own names, one usage per assistant message, none on user messages: measured on a real
/// transcript. `message.model` is the model that answered, and it is what the provider names in its
/// API (`claude-sonnet-4-5-20250929`), or whatever the user pointed Claude Code at (a real one here
/// read `deepseek-v4.1-flash`, which is why nothing assumes the vendor from the tool).
pub fn claude_usage_of_line(value: &serde_json::Value) -> Option<LineUsage> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let mut tokens = UsageTokens::ZERO;
    let mut found = false;
    for (key, slot) in [
        ("input_tokens", &mut tokens.input),
        ("output_tokens", &mut tokens.output),
        ("cache_read_input_tokens", &mut tokens.cache_read),
        ("cache_creation_input_tokens", &mut tokens.cache_write),
    ] {
        if let Some(part) = as_u64(usage.get(key)) {
            *slot = part;
            found = true;
        }
    }
    if !found {
        return None;
    }
    Some(LineUsage {
        tokens,
        provider: text_of(message.get("provider")),
        model: text_of(message.get("model")),
    })
}

/// A pi message line's cost, when it is an assistant message with usage.
///
/// pi sometimes writes the four parts, sometimes only `totalTokens`. When the total is there and the
/// parts add up to it, the parts are used (they are the breakdown); when they disagree, the tool's
/// own total wins and the tokens go in `unsplit`, so this never reports a number the session list
/// would contradict (`stats::pi_tokens_of_message` sums `totalTokens` first, and the two must agree).
/// `message.provider` and `message.model` are pi's own names for what answered.
pub fn pi_usage_of_line(value: &serde_json::Value) -> Option<LineUsage> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("message") {
        return None;
    }
    let message = value.get("message")?;
    let usage = message.get("usage")?;
    let mut parts = UsageTokens::ZERO;
    let mut found = false;
    for (key, slot) in [
        ("input", &mut parts.input),
        ("output", &mut parts.output),
        ("cacheRead", &mut parts.cache_read),
        ("cacheWrite", &mut parts.cache_write),
    ] {
        if let Some(part) = as_u64(usage.get(key)) {
            *slot = part;
            found = true;
        }
    }
    let total = as_u64(usage.get("totalTokens"));
    let tokens = match (found, total) {
        (true, Some(total)) if parts.total() == total => parts,
        (true, None) => parts,
        (_, Some(total)) => UsageTokens {
            unsplit: total,
            ..UsageTokens::ZERO
        },
        (false, None) => return None,
    };
    Some(LineUsage {
        tokens,
        provider: text_of(message.get("provider")),
        model: text_of(message.get("model")),
    })
}

/// An opencode message row's cost, when it is an assistant message (the older schema).
///
/// The row is the `data` JSON of the `message` table: `{"role":"assistant","tokens":{"total":…,
/// "input":…,"output":…,"reasoning":…,"cache":{"read":…,"write":…}},"modelID":…,"providerID":…}`.
/// Current opencode keeps the tokens on the message's `step-finish` parts instead; see
/// `opencode_usage_of_step`.
pub fn opencode_usage_of_message(data: &serde_json::Value) -> Option<LineUsage> {
    if data.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
        return None;
    }
    opencode_usage_of_row(data)
}

/// The same, for a row whose assistant-ness is already known.
///
/// Current opencode stores the role in a column (`session_message.type`) rather than in the JSON, and
/// the model as `model:{id, providerID}`; the older `message` rows keep both inside the JSON, flat.
/// A reader that knows which table it is looking at therefore cannot go through the role check that
/// `opencode_usage_of_message` does.
pub fn opencode_usage_of_row(data: &serde_json::Value) -> Option<LineUsage> {
    let tokens = opencode_tokens(data.get("tokens")?)?;
    let (provider, model) = match data.get("model") {
        Some(model) => (
            text_of(model.get("providerID")),
            text_of(model.get("id")),
        ),
        None => (text_of(data.get("providerID")), text_of(data.get("modelID"))),
    };
    Some(LineUsage {
        tokens,
        provider,
        model,
    })
}

/// An opencode step's cost: the current schema keeps tokens on a `step-finish` part, and the model on
/// the message that part belongs to.
///
/// `part` is the part row's `data` (`{"type":"step-finish","tokens":{…},"cost":…}`) and `message` is
/// the `session_message` row it belongs to (`{"model":{"providerID":…,"id":…}}`), or `None` when the
/// join found no message: the tokens are then still counted, with no attribution invented for them.
///
/// Measured on this machine (2026-11-13): summing these parts over a session reproduces exactly the
/// `tokens_input`/`tokens_output`/`tokens_cache_read` the session row carries, so a step is counted
/// once and nothing is double-counted by reading parts instead of the message.
pub fn opencode_usage_of_step(
    part: &serde_json::Value,
    message: Option<&serde_json::Value>,
) -> Option<LineUsage> {
    let tokens = opencode_tokens(part.get("tokens")?)?;
    let model = message.and_then(|message| message.get("model"));
    Some(LineUsage {
        tokens,
        provider: text_of(model.and_then(|model| model.get("providerID"))),
        model: text_of(model.and_then(|model| model.get("id"))),
    })
}

/// opencode's token object, in either schema's spelling, with the same rule as pi's: the parts are
/// used when they add up to the tool's own `total`, and the total wins (as `unsplit`) when they do
/// not, so a report can never contradict what opencode shows its own user.
fn opencode_tokens(tokens: &serde_json::Value) -> Option<UsageTokens> {
    let mut parts = UsageTokens {
        input: as_u64(tokens.get("input")).unwrap_or(0),
        output: as_u64(tokens.get("output")).unwrap_or(0),
        reasoning: as_u64(tokens.get("reasoning")).unwrap_or(0),
        ..UsageTokens::ZERO
    };
    let cache = tokens.get("cache");
    parts.cache_read = as_u64(cache.and_then(|cache| cache.get("read"))).unwrap_or(0);
    parts.cache_write = as_u64(cache.and_then(|cache| cache.get("write"))).unwrap_or(0);
    let total = as_u64(tokens.get("total"));
    match (parts.total() > 0, total) {
        (true, Some(total)) if parts.total() == total => Some(parts),
        (true, None) => Some(parts),
        (_, Some(total)) => Some(UsageTokens {
            unsplit: total,
            ..UsageTokens::ZERO
        }),
        (false, None) => None,
    }
}

/// A zcode answer's cost, from its `message` table.
///
/// zcode keeps opencode's old `message` shape - `{role, time, modelId, providerId, tokens:{total,
/// input, output, reasoning, cache:{read, write}}}` in `~/.zcode/cli/db/db.sqlite` - but its
/// accounting is OpenAI's rather than opencode's: **`input` already contains the cached part**.
/// Measured on a real row: 477,824 input + 3,113 output = 480,937 total, with 477,056 of that input
/// served from cache. Adding the classes as they stand would count those tokens twice, so the cache
/// is moved into its own class first (`reclassify`), exactly as for workbuddy.
pub fn zcode_usage_of_message(data: &serde_json::Value) -> Option<LineUsage> {
    if data.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
        return None;
    }
    let tokens = data.get("tokens")?;
    let raw_input = as_u64(tokens.get("input"))?;
    let output = as_u64(tokens.get("output")).unwrap_or(0);
    let cache = tokens.get("cache");
    let cache_read = as_u64(cache.and_then(|cache| cache.get("read"))).unwrap_or(0);
    let cache_write = as_u64(cache.and_then(|cache| cache.get("write"))).unwrap_or(0);
    Some(LineUsage {
        tokens: reclassify(raw_input, output, cache_read, cache_write, tokens),
        provider: text_of(data.get("providerId")),
        model: text_of(data.get("modelId")),
    })
}

/// A dsh answer's cost.
///
/// dsh's log is `{type, seq, time, data}`, one record per line, and the record of a call carries that
/// call's `data.usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`.
/// Two kinds are model calls and are counted: `assistant/message` (the answer, whose routing is in
/// `data.message.source.{provider, model}`) and `compaction/summary` (the summarisation dsh runs when
/// a conversation is compacted, which has no source of its own - the reader attributes it to the
/// session's selected model). More kinds are listed as they are found rather than accepting any
/// record with a `usage` object: a record that ever reports a turn's running total would otherwise be
/// counted once per turn.
///
/// The classes are exclusive - measured on a real record: 306 input + 265 output + 9,088 cache read =
/// 9,659 = `totalTokens` - so `inputTokens` is the uncached prompt, unlike zcode's and workbuddy's
/// OpenAI-shaped counts, and nothing is moved here. `reasoningTokens`, when present, is inside
/// `outputTokens` and is not added on top.
pub fn dsh_usage_of_line(value: &serde_json::Value) -> Option<LineUsage> {
    if !matches!(
        value.get("type").and_then(serde_json::Value::as_str),
        Some("assistant/message" | "compaction/summary")
    ) {
        return None;
    }
    let data = value.get("data")?;
    let usage = data.get("usage")?;
    let mut parts = UsageTokens::ZERO;
    let mut found = false;
    for (key, slot) in [
        ("inputTokens", &mut parts.input),
        ("outputTokens", &mut parts.output),
        ("cacheReadTokens", &mut parts.cache_read),
        ("cacheWriteTokens", &mut parts.cache_write),
    ] {
        if let Some(part) = as_u64(usage.get(key)) {
            *slot = part;
            found = true;
        }
    }
    let tokens = match (found, as_u64(usage.get("totalTokens"))) {
        (true, Some(total)) if parts.total() == total => parts,
        (true, None) => parts,
        (_, Some(total)) => UsageTokens {
            unsplit: total,
            ..UsageTokens::ZERO
        },
        (false, None) => return None,
    };
    let source = data.get("message").and_then(|message| message.get("source"));
    Some(LineUsage {
        tokens,
        provider: text_of(source.and_then(|source| source.get("provider"))),
        model: text_of(source.and_then(|source| source.get("model"))),
    })
}

/// A workbuddy answer's cost.
///
/// One JSONL line per event under `~/.workbuddy/projects/<project>/<session>.jsonl`; the assistant's
/// lines carry `providerData.usage` with the same OpenAI-style counts as zcode's
/// (`inputTokensDetails[0].cached_tokens` is the cached part of the prompt, `outputTokensDetails[0]
/// .reasoning_tokens` is already inside `outputTokens`). The model is `providerData.requestModelId`.
pub fn workbuddy_usage_of_line(value: &serde_json::Value) -> Option<LineUsage> {
    let provider = value.get("providerData")?;
    let usage = provider.get("usage")?;
    let raw_input = as_u64(usage.get("inputTokens"))?;
    let output = as_u64(usage.get("outputTokens")).unwrap_or(0);
    let cache_read = usage
        .get("inputTokensDetails")
        .and_then(serde_json::Value::as_array)
        .and_then(|details| details.first())
        .and_then(|detail| as_u64(detail.get("cached_tokens")))
        .unwrap_or(0);
    let cache_write = 0;
    let tokens = reclassify(raw_input, output, cache_read, cache_write, usage);
    Some(LineUsage {
        tokens,
        provider: text_of(provider.get("providerId")),
        model: text_of(provider.get("requestModelId"))
            .or_else(|| text_of(provider.get("requestModelName"))),
    })
}

/// OpenAI-style counts into the classes the report keeps: the prompt total already contains the
/// cached part, so it is taken out of `input` and given its own class. The tool's own `totalTokens`
/// wins when the classes do not add up to it, the same rule every other extractor follows.
fn reclassify(
    raw_input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    usage: &serde_json::Value,
) -> UsageTokens {
    let parts = UsageTokens {
        input: raw_input.saturating_sub(cache_read),
        output,
        reasoning: 0,
        cache_read,
        cache_write,
        unsplit: 0,
    };
    match as_u64(usage.get("totalTokens")) {
        Some(total) if parts.total() == total => parts,
        Some(total) => UsageTokens {
            unsplit: total,
            ..UsageTokens::ZERO
        },
        None => parts,
    }
}

fn text_of(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// The day index for a `YYYY-MM-DD` date, for readers that only have the date (an export file).
pub fn day_from_label(label: &str) -> Option<i64> {
    let mut parts = label.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<i64>().ok()?;
    let date = parts.next()?.parse::<i64>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&date) {
        return None;
    }
    Some(days_from_civil(year, month, date))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn at(text: &str) -> i64 {
        super::super::stats::iso_ms(text).expect("timestamp")
    }

    fn event<'a>(at_ms: i64, model: Option<&'a str>, tokens: UsageTokens) -> UsageEvent<'a> {
        UsageEvent {
            at_ms,
            tool: "test",
            provider: Some("test"),
            model,
            tokens,
        }
    }

    fn plain(input: u64, output: u64) -> UsageTokens {
        UsageTokens {
            input,
            output,
            ..UsageTokens::ZERO
        }
    }

    #[test]
    fn a_day_is_the_callers_day_not_utcs() {
        // 2026-11-13T23:30Z is still the 13th in UTC and already the 14th in UTC+8. Both answers are
        // one call away, which is the point: the accounting question is the caller's.
        let late = at("2026-11-13T23:30:00.000Z");
        assert_eq!(day_label(day_of(late, 0)), "2026-11-13");
        assert_eq!(day_label(day_of(late, 480)), "2026-11-14");
        // And the other way: 00:30Z is the 13th in UTC, still the 12th in UTC-5.
        let early = at("2026-11-13T00:30:00.000Z");
        assert_eq!(day_label(day_of(early, 0)), "2026-11-13");
        assert_eq!(day_label(day_of(early, -300)), "2026-11-12");
    }

    #[test]
    fn an_instant_before_the_epoch_lands_in_its_own_day() {
        // Floor, not truncate: -1 ms is still 1969-12-31, not 1970-01-01.
        assert_eq!(day_of(-1, 0), -1);
        assert_eq!(day_label(day_of(-1, 0)), "1969-12-31");
        assert_eq!(day_of(0, 0), 0);
        assert_eq!(day_label(0), "1970-01-01");
    }

    #[test]
    fn day_labels_and_indices_round_trip_across_leap_years() {
        for label in [
            "2024-02-29",
            "2025-01-01",
            "2025-12-31",
            "2026-11-13",
            "2000-02-29",
        ] {
            let day = day_from_label(label).expect("day");
            assert_eq!(day_label(day), label);
        }
        assert_eq!(day_from_label("2026-13-01"), None);
        assert_eq!(day_from_label("2026-11-13-01"), None);
        assert_eq!(day_from_label("nope"), None);
    }

    #[test]
    fn events_are_split_by_day_and_by_model_at_once() {
        let report = aggregate(
            [
                event(
                    at("2026-11-12T10:00:00.000Z"),
                    Some("claude-sonnet-4-5"),
                    plain(100, 20),
                ),
                event(
                    at("2026-11-12T23:00:00.000Z"),
                    Some("claude-sonnet-4-5"),
                    plain(50, 5),
                ),
                event(
                    at("2026-11-13T01:00:00.000Z"),
                    Some("deepseek-v4.1-flash"),
                    plain(10, 1),
                ),
            ],
            0,
        );
        assert_eq!(report.totals.tokens.input, 160);
        assert_eq!(report.totals.tokens.output, 26);
        assert_eq!(report.totals.events, 3);
        assert_eq!(
            report
                .days
                .iter()
                .map(|day| (day_label(day.day), day.totals.events))
                .collect::<Vec<_>>(),
            vec![("2026-11-12".to_string(), 2), ("2026-11-13".to_string(), 1)]
        );
        // Biggest first.
        assert_eq!(
            report
                .models
                .iter()
                .map(|model| model.model.clone().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["claude-sonnet-4-5", "deepseek-v4.1-flash"]
        );
        // The two groupings agree with the total, which is the invariant a window's two views rest
        // on: if they ever disagree, one of the three is lying to the user.
        let by_days: u64 = report.days.iter().map(|day| day.totals.tokens.total()).sum();
        let by_models: u64 = report
            .models
            .iter()
            .map(|model| model.totals.tokens.total())
            .sum();
        assert_eq!(by_days, report.totals.tokens.total());
        assert_eq!(by_models, report.totals.tokens.total());
    }

    #[test]
    fn a_record_that_names_no_model_is_its_own_bucket_rather_than_dropped() {
        // Dropping it would make the total unreachable from the bars; the window needs a row that
        // says "unnamed", and the sum has to stay complete.
        let report = aggregate(
            [
                event(at("2026-11-13T02:00:00.000Z"), None, plain(7, 3)),
                event(
                    at("2026-11-13T03:00:00.000Z"),
                    Some("gpt-5"),
                    plain(50, 5),
                ),
            ],
            0,
        );
        assert_eq!(report.models.len(), 2);
        assert_eq!(report.models[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(report.models[1].model, None);
        assert_eq!(
            report
                .models
                .iter()
                .map(|model| model.totals.tokens.total())
                .sum::<u64>(),
            65
        );
    }

    #[test]
    fn the_same_events_answer_differently_under_different_scopes() {
        let tokens = UsageTokens {
            input: 100,
            output: 20,
            cache_read: 900,
            cache_write: 80,
            ..UsageTokens::ZERO
        };
        let report = aggregate([event(at("2026-11-13T00:00:00.000Z"), None, tokens)], 0);
        assert_eq!(report.totals.counted(TokenScope::ALL), 1_100);
        assert_eq!(report.totals.counted(TokenScope::WITHOUT_CACHE), 120);
        // The raw parts survive, which is what lets a window switch scope without reading again.
        assert_eq!(report.totals.tokens.cache_read, 900);
        assert_eq!(report.totals.tokens.cache_write, 80);
    }

    #[test]
    fn tokens_a_tool_did_not_split_are_still_counted() {
        // pi's `totalTokens` with no parts: it belongs in the total under every scope, and there is
        // nothing to attribute to cache.
        let tokens = UsageTokens {
            unsplit: 250,
            ..UsageTokens::ZERO
        };
        let report = aggregate([event(at("2026-11-13T00:00:00.000Z"), None, tokens)], 0);
        assert_eq!(report.totals.counted(TokenScope::ALL), 250);
        assert_eq!(report.totals.counted(TokenScope::WITHOUT_CACHE), 250);
    }

    #[test]
    fn no_events_is_an_empty_report_not_a_missing_one() {
        let report = aggregate(Vec::new(), 0);
        assert_eq!(report.totals.events, 0);
        assert!(report.days.is_empty());
        assert!(report.models.is_empty());
        assert_eq!(report.totals.counted(TokenScope::ALL), 0);
    }

    #[test]
    fn claude_lines_give_the_four_parts_and_the_model() {
        let line = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "model": "claude-sonnet-4-5-20250929",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 7,
                    "cache_read_input_tokens": 3,
                    "cache_creation_input_tokens": 1
                }
            }
        });
        let usage = claude_usage_of_line(&line).expect("usage");
        let tokens = usage.tokens;
        assert_eq!(tokens, UsageTokens { input: 100, output: 7, reasoning: 0, cache_read: 3, cache_write: 1, unsplit: 0 });
        assert_eq!(usage.model.as_deref(), Some("claude-sonnet-4-5-20250929"));
        // Claude Code's transcripts name no provider: the model is the only attribution there is.
        assert_eq!(usage.provider, None);
        // The same total the session list already shows for this line.
        assert_eq!(tokens.total(), 111);
        assert_eq!(
            super::super::stats::claude_tokens_of_message(&line),
            Some(tokens.total())
        );
    }

    #[test]
    fn claude_user_lines_and_usage_less_replies_are_not_events() {
        assert_eq!(
            claude_usage_of_line(&json!({
                "type": "user",
                "message": { "role": "user", "content": "hi" }
            })),
            None
        );
        assert_eq!(
            claude_usage_of_line(&json!({ "type": "assistant", "message": { "role": "assistant" } })),
            None
        );
    }

    #[test]
    fn pi_parts_are_used_when_they_add_up_to_the_tool_total() {
        let line = json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "model": "deepseek-v4.1-flash",
                "usage": { "input": 100, "output": 20, "cacheRead": 5, "cacheWrite": 1, "totalTokens": 126 }
            }
        });
        let usage = pi_usage_of_line(&line).expect("usage");
        let tokens = usage.tokens;
        assert_eq!(tokens, UsageTokens { input: 100, output: 20, reasoning: 0, cache_read: 5, cache_write: 1, unsplit: 0 });
        assert_eq!(usage.model.as_deref(), Some("deepseek-v4.1-flash"));
        assert_eq!(
            super::super::stats::pi_tokens_of_message(&line),
            Some(tokens.total())
        );
    }

    #[test]
    fn a_pi_total_that_disagrees_with_its_parts_wins_and_goes_unsplit() {
        // The session list sums the tool's own total; this must not report a different number for the
        // same line, so the breakdown is given up rather than trusted.
        let line = json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "usage": { "input": 1, "output": 1, "totalTokens": 120 }
            }
        });
        let tokens = pi_usage_of_line(&line).expect("usage").tokens;
        assert_eq!(tokens.unsplit, 120);
        assert_eq!(tokens.input, 0);
        assert_eq!(tokens.total(), 120);
        assert_eq!(
            super::super::stats::pi_tokens_of_message(&line),
            Some(tokens.total())
        );
    }

    #[test]
    fn a_pi_line_with_only_a_total_is_an_event_with_no_breakdown() {
        let line = json!({
            "type": "message",
            "message": { "role": "assistant", "usage": { "totalTokens": 120 } }
        });
        let usage = pi_usage_of_line(&line).expect("usage");
        assert_eq!(usage.tokens.unsplit, 120);
        assert_eq!(usage.model, None);
        assert_eq!(pi_usage_of_line(&json!({ "type": "session_info" })), None);
        assert_eq!(
            pi_usage_of_line(&json!({ "type": "message", "message": { "role": "user", "content": "hi" } })),
            None
        );
    }

    /// The shape a reader will have: transcript text in, events out, one report.
    ///
    /// The readers do not exist yet (this layer is what they fold into), so the fold is written out
    /// here as the contract they have to meet: a line the extractor rejects is not an event, a line
    /// whose timestamp cannot be parsed is not an event either, and neither is allowed to cost the
    /// total a token.
    #[test]
    fn a_transcript_folds_into_days_and_models_through_the_same_path_a_reader_will_use() {
        let transcript = [
            r#"{"type":"mode","sessionId":"s1"}"#,
            r#"{"type":"assistant","timestamp":"2026-11-12T23:59:00.000Z","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":2}}}"#,
            r#"{"type":"user","timestamp":"2026-11-13T00:00:30.000Z","message":{"role":"user","content":"hi"}}"#,
            r#"{"type":"assistant","timestamp":"2026-11-13T00:01:00.000Z","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":20,"output_tokens":4,"cache_read_input_tokens":100}}}"#,
            r#"{"type":"assistant","timestamp":"not a time","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":5}}}"#,
        ]
        .join("\n");

        let events: Vec<(i64, UsageTokens)> = transcript
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|value| {
                let usage = claude_usage_of_line(&value)?;
                let at = value
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .and_then(super::super::stats::iso_ms)?;
                Some((at, usage.tokens))
            })
            .collect();
        assert_eq!(events.len(), 2, "the untimed line is not an event");

        let report = aggregate(
            events.iter().map(|(at_ms, tokens)| UsageEvent {
                at_ms: *at_ms,
                tool: "claude",
                provider: Some("anthropic"),
                model: Some("claude-sonnet-4-5"),
                tokens: *tokens,
            }),
            // Local days at UTC+8: the 23:59Z event is already the 13th there, so both events land
            // on one day and the report does not depend on where the reader ran.
            480,
        );
        assert_eq!(report.totals.tokens.total(), 136);
        assert_eq!(report.totals.counted(TokenScope::WITHOUT_CACHE), 36);
        assert_eq!(report.days.len(), 1);
        assert_eq!(day_label(report.days[0].day), "2026-11-13");
        assert_eq!(report.models.len(), 1);
        assert_eq!(report.models[0].provider.as_deref(), Some("anthropic"));
        assert_eq!(report.models[0].model.as_deref(), Some("claude-sonnet-4-5"));
    }

    #[test]
    fn opencode_step_parts_carry_the_cost_and_the_message_carries_the_model() {
        // The current schema: tokens on the `step-finish` part, `model` on the message row.
        let part = json!({
            "type": "step-finish",
            "tokens": { "total": 201938, "input": 1086, "output": 148, "reasoning": 0, "cache": { "write": 0, "read": 200704 } }
        });
        let message = json!({ "model": { "providerID": "workbuddy", "id": "deepseek-v4.1-flash", "variant": "max" } });
        let usage = opencode_usage_of_step(&part, Some(&message)).expect("usage");
        assert_eq!(usage.provider.as_deref(), Some("workbuddy"));
        assert_eq!(usage.model.as_deref(), Some("deepseek-v4.1-flash"));
        assert_eq!(usage.tokens.total(), 201_938);
        assert_eq!(usage.tokens.cache_read, 200_704);

        // A part whose message could not be joined still counts; nothing is invented for it.
        let alone = opencode_usage_of_step(&part, None).expect("usage");
        assert_eq!(alone.provider, None);
        assert_eq!(alone.model, None);
        assert_eq!(alone.tokens.total(), 201_938);

        // A part without tokens is not an event (open messages, text, tool calls).
        assert_eq!(
            opencode_usage_of_step(&json!({ "type": "text", "text": "hi" }), Some(&message)),
            None
        );
    }

    #[test]
    fn opencode_totals_that_disagree_with_their_parts_go_unsplit() {
        let part = json!({ "type": "step-finish", "tokens": { "total": 900, "input": 1 } });
        let usage = opencode_usage_of_step(&part, None).expect("usage");
        assert_eq!(usage.tokens.unsplit, 900);
        assert_eq!(usage.tokens.input, 0);
    }

    /// A day's cells, the day, and the report all have to agree: a window draws all three.
    #[test]
    fn a_days_cells_add_up_to_the_day_and_the_days_add_up_to_the_report() {
        let events = [
            UsageEvent {
                at_ms: at("2026-11-13T01:00:00.000Z"),
                tool: "claude",
                provider: None,
                model: Some("claude-sonnet-4-5"),
                tokens: plain(100, 10),
            },
            UsageEvent {
                at_ms: at("2026-11-13T02:00:00.000Z"),
                tool: "opencode",
                provider: Some("workbuddy"),
                model: Some("glm-5.3-flash"),
                tokens: plain(300, 30),
            },
            UsageEvent {
                at_ms: at("2026-11-14T02:00:00.000Z"),
                tool: "pi",
                provider: Some("openai_agentrouter"),
                model: Some("gpt-5.6-sol"),
                tokens: plain(7, 3),
            },
        ];
        let report = aggregate(events, 0);

        // Cells are biggest first inside the day, so a chart drawing the first few keeps the
        // important ones and folds a tail that is small by construction.
        let first = &report.days[0];
        assert_eq!(first.cells.len(), 2);
        assert_eq!(first.cells[0].tool, "opencode");
        assert_eq!(first.cells[1].tool, "claude");
        assert_eq!(first.cells[0].model.as_deref(), Some("glm-5.3-flash"));

        for day in &report.days {
            let cells: u64 = day.cells.iter().map(|cell| cell.totals.tokens.total()).sum();
            assert_eq!(cells, day.totals.tokens.total(), "day {}", day.day);
            let events: u32 = day.cells.iter().map(|cell| cell.totals.events).sum();
            assert_eq!(events, day.totals.events, "day {}", day.day);
        }
        let by_days: u64 = report.days.iter().map(|day| day.totals.tokens.total()).sum();
        assert_eq!(by_days, report.totals.tokens.total());

        // Tools come out biggest first, and they are the three the readers write.
        let tools: Vec<&str> = report.tools.iter().map(|row| row.tool.as_str()).collect();
        assert_eq!(tools, vec!["opencode", "claude", "pi"]);
        assert_eq!(report.tools[0].totals.tokens.total(), 330);
    }

    /// The same events answer "which model" and "which tool" without overlapping: a cell belongs to
    /// exactly one of each, so summing the model list and summing the tool list both reach the total.
    #[test]
    fn both_attributions_reach_the_total() {
        let report = aggregate(
            [
                UsageEvent {
                    at_ms: at("2026-11-13T01:00:00.000Z"),
                    tool: "claude",
                    provider: None,
                    model: Some("claude-sonnet-4-5"),
                    tokens: plain(5, 5),
                },
                UsageEvent {
                    at_ms: at("2026-11-13T03:00:00.000Z"),
                    tool: "opencode",
                    provider: Some("workbuddy"),
                    model: Some("glm-5.3-flash"),
                    tokens: plain(20, 0),
                },
            ],
            0,
        );
        let by_model: u64 = report.models.iter().map(|row| row.totals.tokens.total()).sum();
        let by_tool: u64 = report.tools.iter().map(|row| row.totals.tokens.total()).sum();
        assert_eq!(by_model, 30);
        assert_eq!(by_tool, 30);
        assert_eq!(report.totals.tokens.total(), 30);
    }

    #[test]
    fn dsh_answers_and_compactions_are_counted_and_its_bookkeeping_is_not() {
        let answer = json!({
            "type": "assistant/message",
            "seq": 4,
            "time": 1_791_083_553_999i64,
            "data": {
                "usage": { "inputTokens": 306, "outputTokens": 265, "cacheReadTokens": 9088,
                           "cacheWriteTokens": 0, "totalTokens": 9659 },
                "message": { "source": { "kind": "model", "provider": "deepseek-account",
                                         "model": "deepseek-flash" } }
            }
        });
        let usage = dsh_usage_of_line(&answer).expect("usage");
        assert_eq!(usage.tokens.total(), 9_659);
        assert_eq!(usage.tokens.input, 306);
        assert_eq!(usage.tokens.cache_read, 9_088);
        assert_eq!(usage.model.as_deref(), Some("deepseek-flash"));

        // A compaction is a model call too, and its record names no model.
        let compaction = json!({
            "type": "compaction/summary",
            "time": 1_791_083_600_000i64,
            "data": { "usage": { "inputTokens": 575, "outputTokens": 4003,
                                 "cacheReadTokens": 216576, "totalTokens": 221154 } }
        });
        let usage = dsh_usage_of_line(&compaction).expect("usage");
        assert_eq!(usage.tokens.total(), 221_154);
        assert_eq!(usage.model, None);

        // Everything else in the log is bookkeeping, even when it is shaped like a message.
        assert_eq!(
            dsh_usage_of_line(&json!({ "type": "turn/end", "data": { "usage": { "totalTokens": 5 } } })),
            None
        );
        assert_eq!(dsh_usage_of_line(&json!({ "type": "assistant/message" })), None);
    }

    #[test]
    fn zcode_counts_cache_reads_once_even_though_its_input_includes_them() {
        let line = json!({
            "role": "assistant",
            "modelId": "GLM-5.3-Flash",
            "providerId": "account:bigmodel-start-plan",
            "tokens": { "total": 480937, "input": 477824, "output": 3113, "reasoning": 0,
                        "cache": { "read": 477056, "write": 0 } }
        });
        let usage = zcode_usage_of_message(&line).expect("usage");
        // The prompt count already contains the cached part, so the cache moves out of `input`.
        assert_eq!(usage.tokens.input, 768);
        assert_eq!(usage.tokens.cache_read, 477_056);
        assert_eq!(usage.tokens.output, 3_113);
        assert_eq!(usage.tokens.total(), 480_937);
        assert_eq!(usage.model.as_deref(), Some("GLM-5.3-Flash"));
        assert_eq!(
            usage.provider.as_deref(),
            Some("account:bigmodel-start-plan")
        );
        assert_eq!(
            zcode_usage_of_message(&json!({ "role": "user", "content": "hi" })),
            None
        );
    }

    #[test]
    fn workbuddy_usage_is_openai_shaped_too() {
        let line = json!({
            "type": "function_call",
            "timestamp": 1_792_588_393_537i64,
            "providerData": {
                "requestModelId": "hy3",
                "usage": {
                    "requests": 1,
                    "inputTokens": 43847,
                    "outputTokens": 926,
                    "totalTokens": 44773,
                    "inputTokensDetails": [{ "cached_tokens": 6528 }],
                    "outputTokensDetails": [{ "reasoning_tokens": 719 }]
                }
            }
        });
        let usage = workbuddy_usage_of_line(&line).expect("usage");
        assert_eq!(usage.tokens.input, 37_319);
        assert_eq!(usage.tokens.cache_read, 6_528);
        assert_eq!(usage.tokens.output, 926);
        // Reasoning is inside `outputTokens`, so it must not be added on top of it.
        assert_eq!(usage.tokens.reasoning, 0);
        assert_eq!(usage.tokens.total(), 44_773);
        assert_eq!(usage.model.as_deref(), Some("hy3"));
        assert_eq!(
            workbuddy_usage_of_line(&json!({ "type": "reasoning" })),
            None
        );
    }
}
