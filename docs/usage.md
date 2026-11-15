# Usage window

The usage window answers one question: what did the agents on this machine spend, and on what. It is
its own webview (`usage.html`) so that reading a year of history never touches the window you are
working in.

Everything here is derived from the agents' own files. Nothing is written, nothing is cached to disk,
and a store that cannot be read is reported rather than shown as empty.

## Where the numbers come from

Seven readers, one report. Each one owns the shape of one tool's data:

| Reader | Store | Notes |
|---|---|---|
| `claude.rs` | `~/.claude/projects/**/*.jsonl` | one event per assistant message that carries `usage` |
| `pi.rs` | the pi transcript directory | jsonl; walks backwards from the end of a file for the session name |
| `opencode.rs` | opencode's sqlite `session_v2` (falling back to `session`) | read-only, capped at 200 rows |
| `zcode.rs` | zcode's store | usage only |
| `workbuddy.rs` | workbuddy's jsonl tree | usage only |
| `dsh.rs` | dsh's jsonl tree | usage only |
| `ccswitch.rs` | `~/.cc-switch/cc-switch.db`, `usage_daily_rollups` | a second-hand ledger; see below |

`usage_events_at` merges them in a fixed order and sorts the whole report by time once, at the end:
a day bucket built from a half-ordered report would be wrong in a way no reader could see.

A cell is `(tool, provider, model, day)` with the token classes split. `events` is the number of
messages, and it is what the request column in both tables shows: one usage event is one answer the
agent paid for.

## cc-switch fills holes, and only holes

The rollup is built from the same transcripts the direct readers see, so a day it covers is already
counted. Importing a covered day would count those tokens twice, and no arithmetic on two daily
totals can tell which part overlaps.

So a day is filled whole or not filled at all: `usage_events_at` collects every `(tool, day)` the
direct readers answered, hands that set to the cc-switch reader, and the reader skips a row whose day
is in it. This is why cc-switch is merged last rather than beside the others.

On this machine that is what keeps 78 days of Claude Code history (2026-04-06 to 2026-08-30) from
reading as a gap: the transcripts are gone, the rollup remembers them.

A tool the rollup covers but this app does not read (codex) is left out. Inventing a seventh agent
from a foreign ledger would be worse than not showing it.

## One scope, no switch

Cache reads and cache writes are part of every total. There is no control to take them out:
a share of the total that silently drops most of what an agent spent answers a different question
from the one the numbers claim to answer, and on this machine cache reads are 76% of the total.

`TokenScope` still exists in the data layer, because `buildView`, `buildTrend` and `countTokens` take
it, and a test or a probe can ask for one class on its own. The window passes one constant
(`USAGE_SCOPE`).

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

## Verifying a change here

`scripts/dev/probes/usage-window.mjs` opens the window, reads the numbers off the DOM, calls
`agent_usage_events` directly and compares the two: the window may not claim more than the command
returns, and may not drift from it by more than half a percent (the machine is allowed to spend while
the probe runs). It also checks that the header holds no scope switch, that the two attributions sum
to the same total, that folding keeps the sum, that a tool filter narrows correctly, that every row
prints a request count, and that the rows' events do not exceed the summary's.

`src/usage/tokens.test.ts` and `src/usage/axis.test.ts` hold the pure parts: day bucketing, model
identity, folding, the axis bound.
