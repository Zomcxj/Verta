# Usage window

The usage window answers one question: what did the agents on this machine spend, and on what. It is
its own webview (`usage.html`) so that reading a year of history never touches the window you are
working in.

Everything here is derived from the agents' own files. Nothing is written, nothing is cached to disk,
and a store that cannot be read is reported rather than shown as empty.

## Where the numbers come from

Six readers, one report. Each one owns the shape of one tool's data:

| Reader | Store | Notes |
|---|---|---|
| `claude.rs` | `~/.claude/projects/**/*.jsonl` | one event per assistant message that carries `usage` |
| `pi.rs` | the pi transcript directory | jsonl; walks backwards from the end of a file for the session name |
| `opencode.rs` | opencode's sqlite `session_v2` (falling back to `session`) | read-only, capped at 200 rows |
| `zcode.rs` | zcode's store | usage only |
| `workbuddy.rs` | workbuddy's jsonl tree | usage only |
| `dsh.rs` | dsh's jsonl tree | usage only |

`usage_events_at` merges them in a fixed order and sorts the whole report by time once, at the end:
a day bucket built from a half-ordered report would be wrong in a way no reader could see.

A cell is `(tool, provider, model, day)` with the token classes split. `events` is the number of
messages, and it is what the request column in both tables shows: one usage event is one answer the
agent paid for.

## One scope, no switch

Cache reads and cache writes are part of every total. There is no control to take them out:
a share of the total that silently drops most of what an agent spent answers a different question
from the one the numbers claim to answer, and on this machine cache reads are 76% of the total.

`TokenScope` still exists in the data layer, because `buildView`, `buildTrend` and `countTokens` take
it, and a test or a probe can ask for one class on its own. The window passes one constant
(`USAGE_SCOPE`).

## The background tick, and the snapshot a window borrows

Reading every store takes seconds, and a window that opens has no business paying for it again when
the app already did a minute ago. `usage_refresh.rs` (Rust) ticks the stores once a minute on its own
thread, and publishes what it read:

- The tick owns the read. It runs `read(None)`, logs what it cost, writes the cache to disk at most
  every five minutes, emits `verta://usage-changed` when the report's fingerprint moved, and calls
  `publish()` on every tick whether anything changed or not - "nothing moved" is itself the newest
  answer.
- A window that opens between two ticks answers from that snapshot instead of reading: `snapshot()`
  hands back the last finished read as a borrowed `Arc` (98k events here; cloning them to fold would
  give back a good part of what skipping the read saved), and only while it is younger than
  `SNAPSHOT_MAX_AGE_MS`, which is one and a half ticks. Past that a read is the honest answer.
- Only a caller that wants everything can use it. The tick reads the whole store, so
  `agent_usage_events` takes the snapshot only when `since_ms` is `None`; a caller that asked for a
  range gets its own read.
- Measured on this machine: the command went from 3.1-3.9 s to 0.35-0.58 s (median 0.42 s over five
  consecutive reads) once a snapshot existed. The split is the read (2.0 s: 98k events, and the
  opencode store alone scans 40k message rows for their id and time_updated) against the fold
  (240-400 ms).
- The one case it does not cover: a window opened before a launch's first tick has finished has
  nothing to borrow, so it queues on `READING` behind that tick and then reads for itself. On the
  packaged build that window is about 2.4-5 s after a launch (cache restored in 265-1252 ms, first
  tick 1753-3783 ms), while the page cannot take a click until 1.7-2.8 s, so it is narrow. Asking at
  2.2 s measured 3.5 s to answer; asking after the first tick measured 226 ms.

## The window opens on the last read

Reading every store takes seconds - around 10 s warm and up to 26 s cold on this machine - so an
empty window with a reading label over it spends the wait hiding an answer the window already had a minute
earlier. The last payload is therefore kept in `verta-usage-cache.json` beside the other stores
(`src/usage/usageCache.ts`) and painted first; the live read replaces it when it lands.

What is on screen is dated rather than assumed fresh: the header always shows the time of the read
the numbers came from, and adds the reading label while a newer one is in flight. `data-usage-updated-at`
carries `cache` or `live`, which is how a probe tells the two paints apart.

The cache is not a source of truth. `usableCache` drops anything that does not look like a payload
this build understands (a `days` array, the offset, a token total), so a file written by an older
build costs one slow open instead of drawing a half-filled window over tables it cannot fill.

## A model is a model, not a provider and a model

The six agents do not agree on how to spell a model. The same id arrives as `glm-5.3-flash` from one
and `GLM-5.3-Flash` from another, and three of them prefix it with the provider it went through
(`custom-local:deepseek-v4.1-flash`, `global:deepseek-v4.1-flash`, `Qwen/Qwen3-8B`) or with a routing
tag (`[次]deepseek-v4-flash`).

`modelIdentity` strips the tag and the prefix, keys case-insensitively, and shows the spelling of
whichever variant carried the most tokens. Filed literally, one model becomes three rows whose numbers
cannot be added up in the reader's head.

## Folding the tail

A long history has a long tail of models used once. The model table can fold everything below a share
into one `other` row: 0.1 / 0.5 / 0.8 / 1 / 2 percent, default 1. The folded row keeps the token and
request sums of the rows it holds, so the table still adds up to the total, and it says how many rows
it holds.

## The trend chart

Steps are 7, 30, 90, 180 days and everything. A year of days in an 880px card is a bar 2.4px wide,
which reads as a texture rather than as a chart.

- **A day is at least 7px wide** (`MIN_PITCH`). When the days need more room than the card has, the
  plot inside a scroller grows and the card scrolls. The y scale sits outside the scroller, so it stays
  put while the days move under it, and the scroll position is pinned to the newest day.
- **The wheel moves it sideways.** A mouse sends a vertical delta and a trackpad sends a horizontal
  one; both are used. The listener is added by hand because React's wheel handler is passive and
  cannot prevent the page from scrolling, and the gesture is handed back to the page at either end so
  the chart never traps a scroll.
- **The y axis is the tallest day rounded up to two significant digits** (`axis.ts`). A scale with
  headroom draws every bar shorter than it is: the old 1/2/5 step times five could leave the tallest
  day at 52% of the plot. Two significant digits is what makes the bound reachable - five steps that
  cover 130 need a step between 26 and 28, and no round step sits in that window - and it keeps the
  tallest bar at or above 90% of the axis for every value (`axis.test.ts` sweeps 16 decades). The tick
  labels are derived from that maximum, so the top label and the tallest bar agree.
- **A series is a model.** The legend used to qualify a repeated label with the provider, which only
  papered over one model counted twice.

## The two tables

Agents and models, with the same columns: total, input, output, cache reads, requests, share. Both
sort by any column, numbers largest first on the first press, and the request column is the row's own
event count.

## Today is state, not a value read per render

`today` was `dayOf(Date.now(), offset)` computed in the render body, so it only moved when something
else re-rendered the window - and across midnight nothing does. The "today" range therefore kept
filtering to yesterday's day index, and everything written after 00:00 was drawn inside yesterday's
row. The aggregation was never wrong: every event carries its own timestamp and the day is derived
from that, on both sides (`day_of` in Rust, `dayOf` here).

It is state kept by a 30 second timer now, and the day it turns asks for a fresh read: the tick that
would bring the new day's events is up to a minute away, and until it lands the "today" range is empty
with nothing on screen saying why. A timer that finds the same day does one comparison and nothing
else.

## The activity heatmap

Below the trend chart, the last 53 weeks as one cell per day, graded by quantile rather than by a
fixed scale: an agent that was used heavily last month and not at all this one would otherwise be one
bright square and a year of nothing. The cells are the same day buckets the tables sum, so a square
cannot disagree with the number beside it.

## Verifying a change here

`scripts/dev/probes/usage-window.mjs` opens the window, reads the numbers off the DOM, calls
`agent_usage_events` directly and compares the two: the window may not claim more than the command
returns, and may not drift from it by more than half a percent (the machine is allowed to spend while
the probe runs). It also checks that the header holds no scope switch, that the two attributions sum
to the same total, that folding keeps the sum, that a tool filter narrows correctly, that every row
prints a request count, and that the rows' events do not exceed the summary's.

`src/usage/tokens.test.ts` and `src/usage/axis.test.ts` hold the pure parts: day bucketing, model
identity, folding, the axis bound.
