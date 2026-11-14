# Changes vs Upstream (Terax AI)

This project is a derivative of [crynta/terax-ai](https://github.com/crynta/terax-ai) (Apache-2.0), and that
license requires a modified project to state what was changed. This file is that statement. Newest first,
ordered by date descending.

One change per line: a **new module / new feature that upstream does not have** needs one line; a **change to a
file upstream already had** must name that file (which file, what changed). No line numbers, no function names.

Details are collapsed by date: the date itself is the summary of the collapsed block (`<details>` +
`<summary>`), which GitHub renders as an expand/collapse arrow to the left of the date and which still reads
fine as plain text. **The newest day is `open` by default**; when a new day starts, copy the previous block,
swap in the new date, and drop the `open` from the day before.

<details open>
<summary><strong>2026-11-14</strong></summary>

**dsh's usage, out of logs compressed a frame at a time**

- `src-tauri/Cargo.toml`: adds `zstd`. dsh writes each session log as `session[.vN].jsonl.zstd`, and a log is not one zstd frame but one frame per append - 8,599 of them in this machine's largest file, 9.8 MB for 636 records. Only the streaming decoder walks all of them; the pure-Rust alternative was passed over because the frame walk is the one path here that has to be right.
- `src-tauri/src/modules/agent_sessions/dsh.rs` (new): dsh is an IDE agent here - usage only, no sessions, no delete, no rename. Its logs live at `~/.dsh/sessions/<project>/<session>/session[.vN].jsonl[.zstd]` (`$DSH_HOME/sessions` when that is set). One log is read per session: the numbered `session.v4.jsonl.zstd` is the newer record of the same session and the unnumbered copy beside it is stale, so the highest number wins and a session is not read twice. A range start is applied while reading, and a log that cannot be opened or decoded is reported rather than skimmed over.
- Two of dsh's record kinds are model calls and are counted: `assistant/message` (an answer, with the routing in `data.message.source`) and `compaction/summary` (the summarisation run when a conversation is compacted, which carries no routing and takes the session's `model/selection`). The first version of this reader only knew the first kind and came out 2,783,515 tokens - twelve records - short of an independent frame-by-frame count of the same files. Every other kind is bookkeeping and is stepped over, including any future one that reports a running total instead of one call: the two kinds are listed rather than "anything with a `usage` object".
- `src-tauri/src/modules/agent_sessions/usage.rs`: `dsh_usage_of_line`. Its classes are exclusive - measured on a real record, 306 input + 265 output + 9,088 cache read = 9,659 = `totalTokens` - so `inputTokens` is the uncached prompt and nothing is moved between classes, unlike zcode's and workbuddy's OpenAI-shaped counts.
- Read back: 35 logs, 8,853 model calls, 1,542,015,436 tokens, which is exactly the figure an independent read of the same 35 files gives.

**Days whose transcripts are gone, taken from cc-switch's ledger**

- `src-tauri/src/modules/agent_sessions/ccswitch.rs` (new): cc-switch keeps `~/.cc-switch/cc-switch.db`, whose `usage_daily_rollups` table is one row per day, agent, provider and model - the same four dimensions the report already uses, and the reason it can be read at all. Its 68 Claude Code days for `_session` are the case that matters: this machine's `~/.claude/projects` holds three recent sessions, while the rollup still has 2026-04-06 to 2026-08-30 from transcripts that no longer exist.
- The ledger only fills **days the direct readers have no events for**, and a day is filled whole or not at all. It is built from the same transcripts (`provider_id` is `_session` for all of the local rows), so importing a covered day would count those tokens twice, and two daily totals cannot be told apart afterwards. What that adds here: 1,036,265,651 tokens of Claude Code over its missing months, plus 24 opencode days and 8 pi days whose session files are gone from the local databases.
- Rows are attributed only to the six agents this app reads; the rollup's `codex` rows are left out, and a row with no tokens is dropped. Its `input_token_semantics` (0 or 2) turns out to make no difference to the arithmetic: both shapes keep the cache separate (a real row: 122,342 input beside 7,638,348 cache reads), so nothing is reclassified. A provider id that is a UUID or cc-switch's `_session` marker is dropped rather than printed under every model.
- `src-tauri/src/modules/agent_sessions/mod.rs`: the ledger is merged last, because "which days are covered" is a question only the other readers can answer; `usage_events` and `usage_events_at` take the window's `offset_minutes`, since a dated row becomes an instant only through a time zone (each day lands at its own local midnight).

**Each agent drawn with its own mark**

- `public/agents/*.png` (new): the agents' own icons - the tiles opencode, pi, zcode, workbuddy and dsh ship for themselves, in their own colours - as five small PNGs. They are copied in rather than drawn: a launcher full of look-alike glyphs cannot be read at a glance, and `pi`, `opencode` and `zcode` had a hand-drawn stand-in before this.
- `src/modules/launcher/lib/agentIcon.tsx`: `AgentIcon` draws a shipped mark when there is one (`agentMark`), and otherwise the drawn mark in the agent's own colour (`agentColor`; Claude Code's clay, Gemini's blue). `pi` is matched by name, not as a substring, so `copilot` and `api` are not pi. The colour is now set as an inline style rather than as the svg's `color` attribute, which is what made the drawn marks grey in the session list: call sites pass `text-muted-foreground`, and a class outranks an attribute. Claude Code was clay in the usage window and grey in the session list precisely because of that difference.
- `src/modules/launcher/lib/agentIcon.test.ts` (new): pins that the five shipped marks resolve (and by which spelling), that `pi` is not matched inside another name, and that the drawn marks' colours differ from each other.
- `src/usage/UsageApp.tsx`, `src/usage/main.tsx`: the agent filter is six marks and no names - six names are most of an 880px header, and the mark is what a glance reads. Each chip keeps its name as its accessible name and shows it in a tooltip on hover, which is why the window now mounts a tooltip provider. The range and chart chips are unchanged: they have no mark to stand in for the word.

**A window that fits, a tail that folds, and the opener beside search**

- `src/modules/header/Header.tsx`: the usage opener moved out of the right-hand cluster (where it sat among the panels and settings icons) into the left-hand one, beside the sidebar and command-palette buttons.
- `src/usage/Heatmap.tsx`: the 53-week grid took its cell size from the card's width and then added the gap on top of every column, so 53 x 16 px was drawn inside an 820 px card and the last weeks ran past its right edge. The pitch (cell plus gap) is what gets divided now, and the cell is what is left.
- `src/usage/tokens.ts`: `foldTail` sums every row below a share of the range into one row marked `other`; `buildView` takes `foldBelow` (a fraction, 0 keeps everything). The favourite model is chosen before the fold, because a narrow range can make the folded row the biggest one and "your favourite model is other" is not an answer.
- `src/usage/UsageApp.tsx`: the model card offers 0.5, 0.8, 1, 2 and 5 percent, defaulting to 1. The folded row is named "其他" and says how many models it holds, since the number of models is no longer the number of rows. Each of the two cards puts its table and its donut side by side, and the tool filter lists terminal agents first and IDE agents after, each group alphabetically, so the row reads as the two families the product talks about.
- `src/usage/SharePie.tsx` (new): one donut per table, drawn beside it, of the whole split the table lists - which is the question a table cannot answer (how many rows matter, whether one agent owns the total). It is fed the same folded rows the table draws, so "other" means the same thing in both, and it wears the same colours: an agent's own, a model's from the chart's series palette.
- `src/usage/UsageTable.tsx`: the share column keeps its number; a 14px wedge beside a number is decoration, not a chart.
- `src/modules/i18n/messages.ts`: `usage.foldBelow` and `usage.foldedModels`, both languages.
- `scripts/dev/probes/usage-window.mjs`: folds the tail at the widest step and checks that the rows get fewer while their sum still equals the total, then puts the default back so the rest of the run measures the window as it opens. The tables now carry `data-usage-table`, because the probe used to tell model rows from agent rows by the slash in a `provider/model` key - which the folded row does not have - and both of its totals were reading one table's rows as the other's.
- The probe's window-vs-command check compares a read the window took when it opened against a fresh read taken later, and this machine keeps spending in between (the run has watched its own agent write ~250k tokens between the two). It now asks that the fresh read is never smaller and that the two agree to within half a percent.

**The find box floats, and the summary's classes grow**

- `src/modules/header/Header.tsx`: the search field is gone from the header. It stood there on every tab, 192px of chrome spent on an empty box, labelled with a shortcut nobody needs told.
- `src/modules/header/SearchInline.tsx`: the same box is now drawn only while it is being used, as a card floating over the workspace's top-right corner - opened by the find shortcut (or the command palette), closed by Escape or by being left empty, and never pushing the terminal or the Git history down. A tab switch closes it, because it searches the pane that was there.
- `src/modules/editor/lib/chromeTheme.ts`: the editor's own find panel floats in the file's top-right corner too, with a border, a radius and a shadow instead of the full-width bar that used to slide in above the code. It is still `search({ top: true })`; the panel was already at the top, it was just laid out as a bar.
- `src/app/App.tsx`, `src/modules/header/index.ts`: the box is mounted inside the workspace box rather than the shell, so an open Git panel to the right is not underneath it.
- `src/usage/SummaryCard.tsx`: the four token classes under the headline are four blocks now - share at 15px, tokens under it - instead of a line of 9.5px footnotes, and the stat grid gained a request count (one event is one answer the agent paid for). The grid went from three columns to four to hold seven stats evenly.

**An agent that is not installed is a mark, not a button**

- `src-tauri/src/modules/agent_sessions/mod.rs`: `usage_events` now returns `UsageRead` - the report and the agents this machine has a store for (`available_tools`, judged by the store being on disk) - and the payload carries the list as `availableTools`. "Installed" is deliberately not "has usage": an installed agent with nothing in the range is a normal thing to filter to, and the report already says the range is empty.
- `src/usage/tokens.ts`: `isToolAvailable` holds that rule - a payload without the list reads as "everything is available", and the neutral chip is always offered - so the window's chip and the probe's check cannot drift apart.
- `src/usage/UsageApp.tsx`: a chip for an agent with no store is drawn as its mark rather than as a button - dimmed, `aria-disabled`, no click, no tab stop, with the reason in its tooltip. The row of marks does not change with what is installed; only what can be clicked does.
- `scripts/dev/probes/usage-window.mjs`: checks both halves of the rule against the payload - a chip is a `BUTTON` exactly when its agent is installed, and a mark that is not is `aria-disabled`.
- `src/modules/i18n/messages.ts`: `usage.notInstalled`, both languages.

**Six agents, read back together**

- 87,637 events and 18,150,564,187 tokens over 139 days (2026-04-06 to 2026-11-14): opencode 12.23B, zcode 2.22B, dsh 1.54B, Claude Code 1.04B, pi 871.4M, workbuddy 245.2M.

</details>

<details>
<summary><strong>2026-11-13</strong></summary>

**opencode's usage was four fifths missing, and the window showed it**

- `src-tauri/src/modules/agent_sessions/opencode.rs`: current opencode writes a message's usage on the message row (`session_message.data.tokens`, with `data.model`), and the `part` table it used to write stopped on 2026-10-14 on this machine. The reader only knew the parts, so it reported 3.36B tokens over 68 days for a history whose real figure is 12.65B over 82 days - every day after mid-October was missing from the chart, and the days before it were only partially counted.
- The reader now takes the message rows first and falls back to the step parts only when no message row carries tokens, then to the oldest `message` table. Exactly one of the three may be read, because the shapes overlap (parts exist for messages of the same era) and reading two of them would double every number. The message-row shape also retires the 1,788 orphaned parts this reader used to explain away.
- Cross-checked day by day against an independent ledger of the same stores: 2026-11-10 is 102,188,573 on both, 11-12 is 261,417,841 on both, and 11-13 is 313,826,731 there against 321,933,648 here, the difference being the tokens the machine spent while this was being written. What the ledger still has and this does not is six further agent clients it reads from their own directories (its 492,721,087 tokens on 11-11 belong to one of them); those are out of scope here, which is opencode, pi and Claude Code.

**Two IDE agents' usage, and Claude Code's counted once**

- `src-tauri/src/modules/agent_sessions/zcode.rs` (new): zcode is an IDE agent - usage only, no sessions, no delete, no rename. It keeps everything in `~/.zcode/cli/db/db.sqlite`, whose `message` table still has opencode's old shape (role, model and tokens inside the row's JSON). Its `model_usage` table is a cleaner per-request ledger but starts on 2026-10-04 while the transcripts go back to 2026-09-16, so the transcripts are the complete record and the ledger would silently lose the first three weeks.
- `src-tauri/src/modules/agent_sessions/workbuddy.rs` (new): workbuddy is an IDE agent too. Its transcripts live under `~/.workbuddy/projects` (and `.workbuddy-ai/projects`, where 5.5 moved them) as one JSONL page per session; only the lines carrying `providerData.usage` are read. Its `workbuddy.db` was left alone: `session_usage` there is the account's credit meter, not a per-answer count.
- `src-tauri/src/modules/agent_sessions/usage.rs`: zcode and workbuddy both use OpenAI's accounting, where `inputTokens` **already contains** the cached part, so the cache is moved into its own class before anything is summed - otherwise those tokens are counted twice. Measured: zcode's 477,824 input with 477,056 cached is a 480,937 total, and workbuddy's 43,847 input with 6,528 cached is 44,773. workbuddy's `reasoning_tokens` sits inside `outputTokens`, so it is not added on top.
- `src-tauri/src/modules/agent_sessions/claude.rs`: Claude Code's transcripts are now read from `CLAUDE_CONFIG_DIR` when it is set (otherwise `~/.claude`), from `projects/` and `transcripts/` both, and recursively - so a session's own `subagents/agent-*.jsonl` is counted instead of skipped. Lines are deduplicated by `message.id`, because a streamed answer is written to the transcript several times: without that, this machine's Claude Code total read 69,234 tokens instead of 46,100.
- `src-tauri/src/modules/agent_sessions/mod.rs`: `usage_events_at` takes a `UsageStores` struct now (five stores, two of them lists) rather than a run of positional options.
- Read back with all five: 78,569 events and 15,147,822,549 tokens over 90 days - opencode 11.81B, zcode 2.22B, pi 866.5M, workbuddy 245.2M, Claude Code 46.1K (this machine runs Claude Code mostly elsewhere, so its history here is three sessions).
- Not read: dsh. Its sessions are `session.v4.jsonl.zstd` and this build has no zstd decoder; its `storages/session_projcache.json` only describes the session that is currently open (one entry, 243K tokens against 35 transcripts on disk), so reading that would be worse than reading nothing. (Read from the next day on: see 2026-11-14.)

**The usage window: one read, and every view is a sum over it**

- `src-tauri/src/modules/agent_sessions/usage.rs`: a day is now kept as its cells - one per tool, provider and model - and the day's total is computed as the sum of those cells rather than kept beside them, so a day and the bars drawn from it cannot disagree. `UsageEvent` and `OwnedUsageEvent` carry the tool that wrote the record (`claude`, `pi`, `opencode`), the one attribution every reader always knows, and `UsageReport` gained the per-tool totals beside the per-model ones.
- `src-tauri/src/modules/agent_sessions/mod.rs`: `agent_usage_events(since_ms, offset_minutes, cache_read, cache_write)` returns the totals plus every day with its cells, each cell carrying both the raw token parts and the number counted for the requested scope. The scan runs on the blocking pool. The window asks for everything once and slices locally, which is why it passes `sinceMs: null`: the ranges it offers are a sum over days, not a fresh scan each.
- `src-tauri/src/lib.rs`: `open_usage_window`, a `usage` window label, hidden when closed (as settings is) and destroyed with the main window. `capabilities/default.json` and `desktop.json` list the window.
- `usage.html`, `src/usage/*`: the window. A summary with the rolling total, an `≈` line with the per-active-day figure, an eight-pixel composition bar over input / output / cache reads / cache writes, and six stat blocks (active days, streak, per day, busiest day, top model, share of all time). A trend card drawing a stacked bar per local day by model - the top six and one "other" bucket - or a single smoothed line, with its own range (7 days, 30, 90, a year, everything), a tooltip that follows the pointer, and a legend carrying each series' share and total. A 53-week Monday-first heatmap with month labels, quartile-scaled accent cells and a per-day hover. Two sortable tables - by agent and by model - over 合计 / 输入 / 输出 / 缓存读 / 占比, with zebra rows, and a click on an agent row filtering the whole window to it.
- `src/usage/UsageApp.tsx`, `src/usage/UsageTable.tsx`: the agent marks the session list already uses now label the filter chips and the agent table's rows, so "which agent" is read at a glance here too rather than by reading the id.
- `src/usage/seriesColors.ts`: series colours step away from the theme's own accent by the golden angle, with lightness pulled towards the current background, so a dozen themes in two modes stay legible; the folded "other" bucket is deliberately neutral. Two providers can report the same model id, so the legend qualifies only the duplicated names with the provider.
- `src/usage/tokens.ts`: the data layer, tested: the four ranges (today, this week from Monday, this month, everything), the two attributions and the heatmap all reaching the same total, the top-six fold, quartile levels that push duplicate cuts apart, a streak that does not end just because today is young, and one-decimal magnitudes that never let a real number read as zero.
- `src/styles/globals.css`: the theme's surface, glass, vibrancy frame, borderless rounded frame and body background now name the usage window's root as well as the settings window's. Every one of those rules was written against a single root id, so a second child window drew as an opaque slab while the main window was see-through.
- `src-tauri/src/modules/agent_sessions/opencode.rs`: the step query now asks SQL for `step-finish` parts only. That table also holds every text and tool-output blob (378 MB on this machine against 3.4 MB of step parts), and pulling all of it into Rust to parse it made that read ~10 s instead of ~1 s. `json_valid` is a `CASE` guard rather than an `AND` term: SQLite does not promise the order it evaluates `AND` terms in, and one malformed row would otherwise fail the whole query.
- Read back on the release build: the whole history is 22,592 events, 3,363,262,139 tokens, 68 days, 51 provider/model pairs across the three tools (opencode 2,496,669,946, pi 866,522,959, claude 69,234); this month is 3 days and 175,953,872 tokens, of which 89.9% are cache reads, and the same month under "today" is 15,470,282; switching range takes 16 ms, switching a cache switch 17 ms, and the numbers after each agree with a direct call to the command. Probe: `scripts/dev/probes/usage-window.mjs`.
- Not done: the export (ccswitch / tokenmonitor), which needs a sample of each format before it can be written.

**The usage readers: three stores, one ordered stream of events**

- `src-tauri/src/modules/agent_sessions/claude.rs`, `pi.rs`, `opencode.rs`: each tool now folds its own store into `usage::OwnedUsageEvent`s, oldest first, with `since_ms` pushed into the read so a window's range does not pay for the whole history. Claude Code and pi walk every assistant message of every transcript (a session that ran for a week is a week of days, which a per-session number cannot say), and opencode is read from `part` joined to `session_message`.
- The opencode read had to be written twice, and the measurement is why: `message` (the table that carries the tokens inline) stopped being written in October on this machine while `session_message`/`part` were current, so reading the old table alone answers a month-old past for ever. The current shape is read first and the older one only when those tables are absent. Summing the step parts reproduces exactly the `tokens_input`/`tokens_output`/`tokens_cache_read` the session row carries, so a step is counted once.
- Tokens a record cannot attribute are still counted and named in `unsplit` rather than guessed at; 1,788 of 16,996 token-carrying opencode parts point at a message row that no longer exists (254M of 3.36B tokens here), and they land in the unnamed model bucket instead of being credited to the session's current model.
- `src-tauri/src/modules/agent_sessions/mod.rs`: `usage_events(since_ms)` and `usage_events_at(claude, pi, opencode, since_ms)` merge the three stores and sort once (each reader sorted its own half). A tool whose store is absent contributes nothing and says nothing; one store that cannot be read becomes a failure in the report and not an empty window.
- Tests: `cargo test -p verta --lib` is 1,064, with new ones for each reader over its real layout (claude's two-project transcripts, pi's `<project>/<session>/<uuid>/run-0/session.jsonl`, opencode's both schemas including the stale-table trap), the `since_ms` range, and the merge producing one ordered report whose day and model splits both sum to the total.
- Read on this machine's real stores: 22,591 events, 3,363,262,139 tokens, 65 days, 50 provider/model buckets, no failures. Still not wired: no command, no window, no export shape.

**Usage per day and per model, read once and scoped afterwards**

- `src-tauri/src/modules/agent_sessions/usage.rs`: the layer a usage window is built on. `stats.rs` answers one session at a time; this folds events into a total, a per-day split and a per-model split, and leaves three accounting decisions to the caller rather than baking them in. `TokenScope` keeps input, output, cache read, cache write and unsplit tokens separately, so switching cache in or out is one call on a report that was already read. `offset_minutes` is the time zone, so a UTC day and a local day are both one call away and the same events answer differently under each. `provider` and `model` are the reader's strings, grouped as given, with an unnamed bucket that is kept rather than dropped (dropping it would make the total unreachable from the bars).
- Extractors for the two JSONL formats beside it: Claude Code's four usage keys with `message.model`, and pi's four parts where `totalTokens` wins when the parts disagree with it (the tokens then go in `unsplit`). That second rule is there so this layer can never report a number the session list contradicts for the same line, which it would if it trusted a breakdown the tool itself does not.
- Tests, fourteen of them: a day boundary on both sides of UTC with offsets, an instant before the epoch landing in its own day, leap-day labels round-tripping, both groupings summing to the total (the invariant a window's two views rest on), the unnamed-model bucket, scope switching on one report, and a transcript folded through the same path a reader will use, where a line whose timestamp cannot be parsed costs the total no tokens.
- Deliberately not wired: no command, no window, no export shape. ccswitch and tokenmonitor's import formats are still an open question for the user, and this is the layer both will read.

**A distro's Claude Code sessions are listed, instead of "none"**

- `src-tauri/src/modules/agent_sessions/wsl.rs`, `mod.rs`: a distro answered an empty list for Claude Code because the code said its sessions are "in this machine's home directory and nowhere else". They are not: Claude Code writes `~/.claude/projects` on whichever side it runs, so a distribution that had been using it all along looked empty. The store is plain JSONL, so it needs no query run inside the distro - the reader for this machine's store reads it through the Windows share of the distribution's filesystem, trying `\\wsl.localhost` and the older `\\wsl$`, with the distro's `$HOME` asked of `wsl.exe` (the same helper a fresh terminal uses). Verified on this machine with a fixture inside the distro: one transcript there listed as one session with its title, cwd, turn count and tokens; removing the fixture returned the list to empty, with nothing to report either way.
- The first version of that path builder was written with a single leading backslash (a `PathBuf` rooted on the current drive, which is never a distribution's filesystem) *and its unit test pinned the same mistake on both sides*, so it passed while the feature did nothing. The end-to-end check is what caught it; the test now spells the UNC prefix out in full.

**A tool with no session store is not a failure**

- `src-tauri/src/modules/agent_sessions/claude.rs`, `opencode.rs`, `pi.rs`: the session panel showed `claude: 找不到 Claude Code 会话目录: C:\Users\...\.claude/projects。请确认 Claude Code 已安装并至少运行过一次。` ("没找到不要说"). A missing directory is a fact about one path on one machine, and the panel turned it into a claim about the user's: this reader cannot know whether a tool is installed, and Claude Code honours a configuration directory of its own, so a store can sit somewhere this app never looks. A store that is not there now lists nothing, which the list already draws as its own empty state; the three tests that pinned "a missing store is a clear error, not an empty list" now say the reverse, each with the reason.
- `image.rs`, and the delete paths left alone: what still fails states the path it checked and nothing about installation, because the caller there asked for one named session or one named image and there is something to report.
- There is now no notice, block or count for a tool that has no sessions: "not installed, or installed and never used, is normal" ("没安装或者安装了没会话很正常"). Read back on the release build with the panel open: the panel's text contains no "not found" line at all, no element carries the destructive border the old block used, and `claude`, `pi` and `opencode` answer 3, 26 and 200 rows.
- `wsl.rs`, `mod.rs`: two comments said Claude Code "has none" in a distro and that its sessions are "in this machine's home directory and nowhere else". It writes `~/.claude/projects` on whichever side it runs, so what is true is that reading a distro's copy is not implemented - and with the change above, a distro whose distribution has been using Claude Code all along now reads as an empty list rather than as a failure. That gap is written down rather than papered over.

**The session-opening cover says how long it was up, and why**

- `src/app/sessionOpeningLog.ts`, `App.tsx`: every so often the transition layer stays up a moment longer than it should before the terminal appears ("会话加载过渡层末尾偶尔多停一会儿才进入"). The cover lifts when the agent's screen has been painted, its last resort is a 45 s timer, and nothing recorded which of those happened - so "a moment longer" could have been one missed frame or a wait that ran to its cap. Each opening now records how long the cover was up, what ended it (`ui-painted`, `fallback-timer`, `tab-left`, `write-failed`), which rule lifted it, how many times the wait read the screen, how many of those a rule fired on while the frame that arrived still showed the launch line, and the leaf's screen as it lifted.
- `src/main.tsx`, `src/modules/terminal/lib/terminalDiagnostics.ts`: the record rides in the terminal diagnostics, which a release build installs behind `localStorage["verta:terminal-diagnostics"]`, because the openings that are slow are the ones on the machine it was reported from. The installer now takes the application's own additions, and the entry point supplies them, so a terminal module still never imports the application; one of those additions is a leaf's screen text, so a probe can watch what the pane shows instead of reading a screenshot.
- `scripts/dev/probes/session-opening-latency.mjs`: opens a session from the list, samples the layer's presence in the DOM every 40 ms and compares that clock with the application's own record (tolerance 700 ms), then closes the tab and ends the agent process it started.
- Twelve openings on the release build, two agents, were the next question: does the wait itself ever hold? Six of one opencode session took 4.6 s to 5.9 s (median 5.2 s) and six of one pi session took 6.6 s to 13.9 s (median 10.4 s). Every one lifted under a rule (`silence` for opencode, `own-screen` for pi), `heldTicks` was zero in all twelve, and neither the fallback timer nor the hard cap ever ended a cover. What varies is how long the agent takes to take the screen: pi keeps the launch line visible for that whole time (its byte count stops at 4131, its whole banner, and the frame the cover lifts onto is its own footer), and opencode clears the screen at about 4.4 s. So the pause is the agent's startup, not the loop's retries, and no rule was changed for it - the two rules measured here already lift at the first frame that is the agent's own.
- The measurement, on this machine and the release build: six openings of one opencode session took 4.4 s to 5.6 s, all lifted under the `silence` rule with no tick held back and no fallback timer, and all six lifted onto a screen whose text was empty - opencode clears at about 4.4 s and paints its own UI at about 10 s. Refusing a blank frame was tried and measured: the same three openings then took 10.1 s to 10.4 s, so an extra 5.8 s of cover on every opening to avoid one blank moment, and it was reverted. What the cover hides is the launch line, and that is gone at 4.4 s; the pause the user reported is not this, and the record is what will name it when it happens.

**A session that has stopped stops asking for attention**

- `src/modules/terminal/ghostty/shellCommandState.ts`, `useGhosttyTerminalSession.ts`, `src/modules/terminal/lib/terminalSessionApi.ts`, `src/modules/terminal/index.ts`: a session whose agent had quit kept drawing its tab blue (`attention`) for the rest of the window's life ("会话已经停止却仍显示蓝色状态"). Quitting an agent leaves its last frame where it was and the shell draws its new prompt under it, so the question panel stays inside the bottom lines the judge reads, and the only thing that ever retracts a question is a signal that is never going to come. The shell now says whether a command of its own is in flight: the app's shell integration prints the OSC 133 markers, the terminal's parser already turns them into prompt and command events, and the session records that per leaf. `null` (a shell that never spoke, such as a distribution's shell reached through `wsl.exe`) is not `false` and is read as no opinion.
- `src/modules/terminal/lib/agentJudge.ts`: `judgeTail` takes that fact as an optional `ScreenFacts`. A screen that claims work or a question with the shell back at its prompt is held for `NO_JOB_SETTLE_MS` and then reported as `idle`, not `finished` (an ending nobody saw end is not news); a dead frame cannot put the claim back afterwards, and cannot announce an agent either, because `started` is what the tab's icon and the store's name come from.
- `src/app/hooks/useAgentStateJudge.ts`: the screen tick hands each read the shell's answer for its leaf. Nothing crosses the IPC boundary, so the fact is read at the screen's own half second.
- The system's process table was tried first and is wrong on this platform: measured here, a command started in a Git bash shell is recorded against a fork helper that exits at once, so Windows' parent table says the shell has no children while `sleep 60` runs (`Get-CimInstance Win32_Process`: `sleep.exe` 26292, parent 21748, gone). A build of `pty_foreground_facts` on top of that answered "nothing running" over a live command and was deleted again; the probe below caught it.
- `scripts/dev/probes/stopped-session-dot.mjs`: three claims on a real window. A panel with a command behind it stays blue; the same panel printed by a command that has exited leaves blue and never returns; a command written into that session afterwards earns blue again. Run against the previous build it fails on the second claim with the tab blue at every sample for twelve seconds.
- `shellCommandState.test.ts` covers the three answers (never said, said running, said rest) and that a reused leaf id starts from nothing; `useAgentStateJudge.wiring.test.ts` covers where the fact comes from and that a silent shell hands nothing.

**One row per session id**

- `src-tauri/src/modules/agent_sessions/mod.rs`, `claude.rs`: leaving the manage view left a dozen subagent rows behind, still tickable, and every round trip added more of them ("点击管理后点击完成会遗留几个可选子代理会话，点击 agent 或项目切换就正常"; measured: 151 rows of data, 165 drawn, then 179). The ids were on disk twice. Claude Code files a session's subagent directory under the project key of *every* directory that session was used in, keeping the same `agent-*.jsonl` under each - on this machine one session has 22 transcripts under one key and 14 under another, 14 ids in common - and the page keys its rows by id, so two rows sharing one key made React reconcile them onto each other and leave the stale ones mounted. The growth was one more copy per re-read.
- `one_row_per_session` now runs over every tool's payload: a session id identifies a session, and the newest copy wins. Each tool returns its rows newest first, so the first of a group is the copy whose `.meta.json` was written last - the one with a name. Deleting has the same shape: `locate_all` returns every file filed under an id and the delete removes all of them, because removing one copy would let the other reappear on the next read, which reads as "the delete did nothing".
- `scripts/dev/probes/manage-mode-rows.mjs`: three 管理 -> 完成 rounds have to draw the same number of rows in the manage view, never repeat an id, and come back to exactly the rows they started from - the accumulation (+14 per round trip) is the other half of the same bug.

**The manage view can read one session, subagents included**

- `src/modules/launcher/components/SessionInfoDialog.tsx`, `SessionInfoDialog` wiring, `src/modules/launcher/lib/sessionInfo.ts`, `LauncherPanel.tsx`, `SessionList.tsx`: the manage view is the only place a subagent row is drawn, and such a row carries an id, a title and a badge - which does not answer "what is this and what do I lose by deleting it", while deleting a parent takes its children with it. Selecting exactly one row now offers 会话信息 in the footer (disabled for none or for many: one row is one session), and the row's own context menu opens the same dialog in the plain list.
- The dialog names the tool, the id, the directory, the session a subagent belongs to, the source, and the usage line the rows already carry; for a parent it lists what it started. That count is `subagentsOf` - the same rows the manage view draws, filtered by parent id *and* tool - so the number beside "delete" cannot drift from the list it is drawn from.
- Held by key rather than by row: the list re-reads while the dialog is up (the session watcher fires), and a dialog keyed by a replaced row object would close itself.
- `sessionInfo.test.ts` covers the filter, including another tool's session that happens to share an id; `sessionInfoDialog.wiring.test.ts` covers where it opens from and what it may claim. The probe above reads it back on a real window: the dialog names the row that was selected, its subagent count equals the rows it lists, and Escape closes it.

**The font row says which family is actually in use**

- `src/lib/fonts.ts`, `src/lib/fontOptions.ts`, `src/settings/components/FontPreview.tsx`, `FontPicker.tsx`, `src/settings/sections/GeneralSection.tsx`: "I chose Cascadia Code and it shows JetBrains Mono" turned out to be three silences rather than one bug. The setting was stored, shown and *honoured* - measured on the running app, the terminal's own cell width at 80px is 47px, which is Cascadia Code's 0.586em advance, against 48px for JetBrains Mono with the setting switched to it as a control - but nothing anywhere said which family was in force, and the two are nearly indistinguishable at 13px: both round to the same 8px integer cell and both draw a *dotted* zero, which is the glyph the report was reading. So the row now shows the sample and names the family.
- The preview is drawn with the terminal's own chain (`resolveFontStack`), its own size (`fontSize * zoomLevel`), weight and letter spacing, so it is the same picture the terminal makes; the line under it names the family that picture resolves to, read from `effectiveMonoFamily`. The answer is attached to the DOM as `data-font-effective` / `data-font-fallback` so a probe - and anyone with devtools - can ask the same question a person does.
- `effectiveMonoFamily` measures instead of asking: `document.fonts.check` answers yes for names it has never heard of, and the installed-font list is the system's view rather than the webview's. A family the browser cannot resolve measures exactly like the generic family it falls back to, so the width is compared against both `monospace` and `serif` baselines - one is enough to be fooled by a design whose advance happens to match. When there is no canvas to measure with, the answer is "no evidence", not "missing": a warning that cannot be trusted is worse than none.
- The bundled JetBrains Mono is now in the picker, marked `built in`. It ships as `@font-face`, so it works where it is not installed - and it is what every stack silently falls back to, which meant the face that gets drawn when a choice fails could not be seen at all. It also stops being labelled "not installed" when it is the current value.
- The first version of that measurement made the row lie about the font the app ships: "JetBrains Mono (built in)" showed *falling back to MesloLGM Nerd Font*, with MesloLGM installed and JetBrains clearly resolvable in the same window seconds later. A face the document has not fetched measures exactly like the generic family under it, and the settings window has the `@font-face` rule but none of the bytes until something asks for them - so the first measurement said "unusable", and it was cached, so nothing re-measured once the face arrived. `familyResolves` now treats a face that is still `unloaded` or `loading` as *no evidence*: it asks the document for the bytes and answers "usable" without remembering it, so the real measurement decides once they land (a face that ends `error` is still called missing). `FontPreview` re-renders on `loadingdone` / `loadingerror`, which is what puts the measured answer on screen.

**The sheet's outer edge follows what is visible, not which region it is**

- `src/app/App.tsx`, `src/app/components/shellEdges.ts`, `src/styles/globals.css`: reported with two screenshots - with a side panel closed, the workspace met the window flush and square ("收起时不要贴边，还是要圆角"). Two things had each been a property of a region rather than of the row: the window's own margin was the sidebar's `pl-2` and the right panel's `pr-2`, and the sheet's rounded corner was the sidebar's and the right panel's by name. Collapsing either one took both away with it, and the workspace - square in the middle of the sheet by design - became the whole sheet while still drawn as its middle.
- The margin moved to the row (`px-2` on the panel group), which always exists, so no collapse can take it. The corner is now decided by `data-edge-left` / `data-edge-right`, set from `shellEdges`: an edge belongs to the last *visible* region on that side, and with both panels closed the workspace owns both ends - one card, four rounded corners.
- `shellEdges` is a pure truth table with its own test, and `scripts/dev/probes/shell-edge-collapse.mjs` measures the real thing: the outer margin before and after each collapse (it must not change), which region claims the corner, the pane's computed radii (outer rounded, inner seam still square), and that the panels are restored afterwards.

**The session-opening transition shows the agent's own mark**

- `src/app/components/SessionOpeningOverlay.tsx`, `src/app/components/WorkspaceSurface.tsx`, `src/app/App.tsx`: the layer covers the moment a resume command lands in a terminal, and it was drawing the *application's* logo whoever was starting - so opening a Claude Code session and opening an opencode one looked identical. What drives it now carries `{ leafId, tool }` rather than just the leaf, and the layer draws `AgentIcon` for that tool: the same mark the session's row and the tab chip already use. All four ways a session starts name their agent (the session's own tool, the tab's through `tabAgentIcon`, and the tool the caller asked for in the two new-session paths). A start with nothing to name - an unknown tool, or anything that is not a session - keeps the logo, which is what the layer used to draw for everything.
- The mark is drawn at 34px rather than the logo's 44: a vector glyph fills the box it is given while the app's mark is a bitmap with padding of its own, so the same number reads visibly larger. `text-foreground`, because this is the one mark on screen - the muted colour the list's rows use reads as a disabled control.
- `.verta-session-opening-core` no longer paints the rounded card it used to (the pane's colour at 72%, plus an inset highlight): that plate existed so the bitmap logo had a surface to sit on, and behind a vector icon it reads as a button that is not there. The box stays - it is what the punch animation scales - and its paint does not, so the icon floats on the pane like the rings around it.
- `src/app/components/sessionOpeningOverlay.wiring.test.ts`: a source-level test of the wiring, including that *every* `showSessionOpening` call passes an agent - a start added later that forgets it would quietly draw the logo again.
- `scripts/dev/probes/session-opening-agent-icon.mjs`: the acceptance, on a real session. It presses a session that is not already open and compares the mark inside the layer with the mark that same session's row carries (view box, stroke width, and the geometry of every shape), which catches both "the logo instead of the icon" and "another agent's icon"; the screenshot of the terminal area with the layer up is kept beside it, because which picture was in the middle is not something a DOM read can be trusted to have answered alone. Sizes are read as *layout* sizes: the card is drawn inside the punch animation, which starts at `scale(0.62)`, so a sample from the first frames measures 40x40 for a 64x64 card and 21x21 for a 34px mark - measured that way first, and it read as a layout bug until the animation was accounted for.
- `machine: PASS - the Claude Code row's starburst and the layer's are the same drawing, card 64x64, mark 34px (the first frame's painted 21px is the punch's 0.62), foreground colour rather than the row's muted one, no `/logo.png` anywhere in the layer, and a real claude process came up behind it.`

**无界 keeps its seam for the drag, and 浮雕 is a plate rather than a hairline**

- `src/styles/globals.css`, `src/modules/theme/shape.ts`: two presets that were not doing what their names say, both reported from the running app. 无界 closes the gutters between the three regions - which is the shape - but the resize handle it closes is also the only thing that draws a line there: at `width: 0` the drag worked and gave no sign of where it was happening ("无界形态拖动调整组件宽度时恢复竖线显示"). The line now goes on the hit area the handle already carries (`::after`, 16px of invisible overlay so a zero-width handle stays draggable) as a 1px stripe down its middle, shown on hover, on `:active` and while the library reports `data-separator="active"` - the whole drag, not just the press. A stacked handle gets the stripe rotated.
- 浮雕 drew one 1px highlight and one 1px shadow at 10% and 18%. On a dark theme that is a hairline under a hairline, and next to 极简 - which draws no border at all - the two looked the same ("形态浮雕好像和极简差不多"). It is now a plate: lit along the top *and* the left, shaded along the bottom *and* the right, with a 2px band under the 1px dark edge so the bottom has thickness, plus a sheen that fades out a third of the way down the pane. All of it is paint - gradients and inset shadows - so nothing enters the compositing budget.

**pi and claude's subagents are in the manage view too**

- `src-tauri/src/modules/agent_sessions/claude.rs`, `pi.rs`, `src/modules/launcher/lib/visibleSessions.ts`: the manage view showed opencode's subagents and none of the other two ("管理代理发现 pi 和 claude 的子代理没有呢 只有 opencode 的"). opencode answers the question in its own database, where a subagent *is* a session with a `parent_id`; the other two keep a subagent as a file, so they were read as "not a session" and never appeared.
- Claude Code writes each one to `agent-*.jsonl` under `<session-id>/subagents/` (a workflow's helpers one level deeper), with the agent's id on every line and the launched description in the `.meta.json` beside it - so a row now carries the agent's own id (not the `sessionId` its lines repeat, which is the session's), the description as its title, and its session as `parent_id`. pi writes a run to `<stem>/<run uuid>/run-0/session.jsonl`, which *is* a session by its own header - id, cwd, everything but its parent, which comes from the directory it is filed under. Both are read in two passes per project, sessions first, so a child's parent is the id the parent is actually listed under rather than a guess from a file name.
- `topLevelSessions` is what keeps them out of the list the user resumes from: claude's children follow opencode's rule (hidden while the parent is listed), pi's are hidden whether or not the parent is still on disk, which is the rule its forks already had. `subagent_run_artifacts_are_not_sessions` still holds - the artifacts beside a run are not read as one - and `does_not_list_the_subagents_beside_a_session` became `lists_the_subagents_a_session_started_as_children`.

**Claude Code's sessions are in the same list as the other two**

- `src-tauri/src/modules/agent_sessions/claude.rs`, `mod.rs`, `delete.rs`, `watch.rs`, `wsl.rs`, `src/modules/launcher/lib/resumeCommand.ts`: a third agent joins the session list, beside opencode and pi. Claude Code keeps one transcript per session under `~/.claude/projects/<the cwd, flattened>/<session-id>.jsonl`, so the shape is pi's - a file per session, read by name - and the module is built the same way. Only the transcripts *directly* in a project directory count: beside each one is a directory of the same name holding that session's subagent transcripts, and listing those would show a session per helper a session started. A distro read answers with nothing rather than with the local list, which would otherwise appear once per distro the user has; and a session name is refused rather than approximated, because the name is a `custom-title` event inside Claude Code's own ledger and a line this app appended is not something that tool is known to read back.
- The transcript is mostly bookkeeping - measured on a real one: `mode`, `permission-mode`, `atis-latch`, `api-request`, `cost-state`, `file-history-snapshot`, `agent-color`, `attachment`, and no `summary` kind at all - so the four things a row needs are selected by kind and nothing is assumed about the rest. The name comes from `custom-title`/`agent-name` first, then the first line a person actually wrote, then the last prompt, then the id; "a person wrote it" is what excludes the machine's own markers, which are the ones that start with `<` (`<system-reminder>…The user named this session "daily task"…` is the first user line of a real session, and a session that only ran a command has nothing but `<command-name>/exit</command-name>`). Turns, tokens and the last time are all real here: usage is Anthropic's own four counters on the assistant messages, folded in `stats.rs` beside pi's. A transcript with no parseable event in it is skipped silently - it is junk, not a session that lost its cwd - while one that has events and no cwd is reported, because a row that cannot say where a session ran is worse than a warning.
- `iso_ms` and the civil-date arithmetic it needs moved from `pi.rs` to `stats.rs`: both tools write `2026-11-13T01:05:59.276Z` on their conversation events, and a timestamp parser written for one of them is not a fact about that one.
- The terminal side was already there (`agentRules.ts` has identified Claude Code for a while); what a row adds is where to resume: `claude --resume <id>`, with nothing else on the command line. That is the whole shape of it, and the long flag is the one its `--help` documents. The cwd comes from the terminal being opened *in* the session's directory, which is not a detail: Claude Code looks a session up inside its own project keyed by the working directory, and a wrong one makes `--resume` exit at once with "no conversation found".
- `scripts/dev/probes/agent-sessions-claude.mjs`: the acceptance, on the real store. The transcripts are read a second time in node, with the same precedence the Rust side uses, so a rule that drifted shows up as a disagreement rather than as agreement; a distro read has to answer nothing; and pressing a Claude Code row has to start a real `claude --resume <id>`. That last one is read from the operating system, not from the app: this app spawns a shell and *types* the command into it, so nothing in its IPC or its diagnostics carries the text, and the dev-server probes that import the modules have no counterpart in a release build. What can be read is the process table (`claude.exe --resume <id>`, filtered by executable name as well as by command line - the probe's own PowerShell carries the id as an argument). Staying alive six seconds later is the second half of the claim, and no new transcript appearing is the third: a wrong cwd makes that command give up immediately.
- The store itself is never written: no preference is touched, the session is only opened, and the tab and the process this run started are closed and ended again.

**A picture is fitted from its own size, keeps its shape at every scale, and drags**

- `src/components/pan-zoom.tsx`, `src/components/pan-zoom.test.ts`: the left button did nothing on a picture, and it was not the drag's fault: an `<img>` drags *itself* by default, and that drag takes the gesture away from the surface - the webview paints a ghost of the picture, stops delivering the moves and the pane never scrolls. Reported as "dragging does nothing on a picture" next to a drawing that dragged fine, because a drawing has nothing to drag natively. `dragstart` inside the surface is cancelled while the surface is what is being dragged, which leaves the gesture where it belongs.
- A zoom now keeps the point being looked at where it is, instead of leaving the scrollport at the offset it had - zero, until the content overflows - so that every press of `+` showed the same top-left corner and zooming read as "it only grows downwards and rightwards" rather than "it comes closer". `anchoredScroll` is the rule and is tested: content coordinates scale with the zoom, so the offset that holds a point still is the old offset scaled by the ratio. A wheel records the point under the pointer (in the scrollport's own coordinates, at the moment of the wheel, so it does not depend on where the pointer was last seen); a press of the control, which has no meaningful point of its own, holds the middle of the viewport. The offsets are written on the frame the scale changes and again on the next two, because the content sizes itself in its own render (an inline width, or a drawing sized from its `viewBox` in an effect of its own) and the first frame may still be the old layout; writing a target rather than a delta makes that harmless.

- `src/modules/editor/EditorPane.tsx`, `src/components/pan-zoom.tsx`, `src/modules/editor/imagePreview.test.ts`: the picture preview's fit had never run in this shape of the code. Its scrollport ref was still on the plain wrapper the shared surface replaced, so the `ResizeObserver` watched `null`, the room was never known and the scale was never computed: a wide picture *looked* fitted because the base layer caps every image at its container's width, while a picture taller than it is wide was drawn at its own pixels inside a pane half as tall and could only be scrolled - reported as "適應窗口 does not fit a tall picture". The surface now takes the caller's `viewportRef` (the room is what the fit is computed against, and only the surface knows the element), and the size is the picture's own rather than something the pane clamps.
- The magnification is where the second half of that showed up: `max-w-none` was given only at the 1:1 stop, so at the fit stop the base layer's `max-width: 100%` clamped the *width* while the height kept growing - "zoom in" enlarged the picture into a stretched one. The cap is now lifted at both stops, and it is not needed to protect the pane: at the fit stop the size is already the smaller of the two ratios, so it cannot exceed the room. `drawn` is floored but no longer clipped to the room, which is what had made `+` a no-op in the fit stop. `imagePreview.test.ts` holds both to the source, since neither is visible in a rendered number.
- That clamp had also been hiding a second bug, and lifting it is what brought this one into view: a picture that is already decoded when React attaches its handler never raises `load`, so the size was never read, the scale was never computed and the picture was drawn at its own pixels - measured as a 3072x3072 screenshot at 3074px inside a 1070px pane, with no inline size at all. The size is now read from the element on mount as well as from the event. `src/modules/markdown/MarkdownImage.tsx` had the same race with a quieter symptom: its `loaded` flag is what lifts a placeholder height, so a missed `load` left the picture locked at that height for the life of the block.
- The room is measured from the element on the frames the pane has no box yet, and not by the observer alone: a pane that has not been laid out reports *nothing*, not even a zero, so a picture opened while the workspace was still switching to the editor view ended up with a size, an observer and no room - the fit was never computed, and it opened at its own pixels in a pane a quarter of the size. Zero is not a room either, so a pane that is not laid out yet is not fitted against it.
- `src/components/mermaid-diagram.tsx`, `src/modules/editor/MermaidPreview.tsx`, `src/components/chat-code.tsx`: the drawing's host fills its pane again (`w-full`, `safe` centring in both axes inside itself) instead of being sized by its content, which had shrunk the fitting drawing to 300px when it became a flex item - and, worse, would have made a zoomed drawing the scrollport's content rather than an overflow of a full-width box. `[&_svg]:max-w-full` stays: at 100% it is the "as wide as the pane, never wider than the drawing" cap, and away from 100% the zoom's own inline `max-width` is what lifts it.
- `scripts/dev/probes/image-zoom-pan.mjs`: the acceptance for all of the above, on a real picture - the first image on the desktop by default (`--file=` names another), copied to a name of its own under the system temp directory first, because opening the same path twice lands on the tab that is already open and whatever stop that tab was left on would be read as how a picture opens. It reads the picture's own `naturalWidth`/`naturalHeight` rather than a size it assumed, checks that the fit leaves the whole picture inside its room and that one axis comes out at the room's own size, that a magnification past the pane grows the width past it too and keeps the picture's ratio (a clamped width shows up there first), that 1:1 asks for exactly the picture's pixels, that the left button drags it to the end of the scroll range and stops there, and that a ctrl+wheel holds the content point under the pointer while the window itself does not zoom. A 600x1600 fixture gets its own pass, because the two orientations are limited by different axes.
- `scripts/dev/probes/mermaid.mjs`: the same two checks for a drawing - the drag, and the drawing's shape at every scale against its `viewBox` - plus the wheel anchoring, and the overflow check restated in content coordinates: with the view now scrolled into the drawing, "the drawing starts left of the pane" is the point of zooming, and what must not happen is content *before the scroll origin*, which nothing can scroll to. Both probes now find their pane by walking up from the drawing or the picture to the element that owns the zoom control, and close their tabs through the chip that carries an `aria-label` rather than the first `role="button"` in the tab: that one is the file icon's dropdown, which is how earlier runs left tabs behind for a later run to read.

</details>

<details>
<summary><strong>2026-11-12</strong></summary>

**A drawing and a picture drag with the left button, on one surface**

- `src/components/pan-zoom.tsx`, `src/components/pan-zoom.test.ts`: the scrollport both a drawing and a picture are looked at through, with the gestures as pure functions tested on their own. A drag is written as `scrollLeft`/`scrollTop` rather than as a transform, and that is the whole design: the scrollport already knows how far its content can move, so its own range is the limit and a drag can never put part of the content somewhere no scroll reaches - which is what a transform does when the pointer outruns the edge, and how a drawing's corner is lost for good. The primary button only (a middle click is a paste on Windows, the secondary one belongs to the context menu), a threshold below which a press is still a click, and the click that ends a real drag is swallowed so the content under the pointer is not clicked as well. Centring is `safe` in both axes, for the reason the diagram's own zoom had already taught: plain centring aligns content wider than the scrollport in the middle of its own box, which puts the leading edge outside the scrollable range. Ctrl/⌘ + wheel steps the same 1.25 the controls use, through a hand-attached non-passive listener.
- `src/components/mermaid-diagram.tsx`, `src/modules/editor/MermaidPreview.tsx`, `src/components/chat-code.tsx`: the drawing drags, and a diagram and a picture now share the control - `DiagramZoomControls` is `ZoomControls`. The drag is offered only once the drawing is bigger than its room, watched with a `ResizeObserver` rather than computed, because the room changes when a divider is dragged or the window resized and neither passes through the component. The svg is still sized from its `viewBox`: the surface moves the scrollport, it never transforms the drawing.
- `src/modules/editor/EditorPane.tsx`, `src/modules/editor/lib/imageScale.ts`, `src/modules/editor/lib/imageScale.test.ts`: the picture's two stops - fit the window, original size - gained a magnification over them, in the same steps and on the same control the diagram uses, plus the drag. The rule moved into `imageScale`, where its reasons can be tested: fit scales up as well as down (capping it at the picture's own size made the two stops draw the same pixels in a big pane, so the button was the only way to tell which was on), the magnification multiplies whichever stop is in force, and 1:1 with no magnification is the picture's own pixels - the one number that means something for a picture and nothing for a drawing. An unknown natural size answers `null` rather than 1, so a picture still decoding is not drawn at the wrong size for a frame. Either stop resets the magnification, because carrying it across would make "fit" not fit and "1:1" not 1:1.

**Mermaid: a `.mmd` file and a fence are the same drawing, and it zooms**

- `src/components/mermaid-diagram.tsx`, `src/modules/editor/MermaidPreview.tsx`, `src/modules/editor/lib/diagramTheme.ts`, `src/modules/editor/lib/diagramZoom.ts`, `src/modules/editor/EditorPane.tsx`, `src/components/chat-code.tsx`: a `.mmd`/`.mermaid` file opens as the diagram it is, with the source one stop away on the same control the table and the HTML page use, and a ` ```mermaid ` fence in markdown or a chat answer draws in the space the code block would have taken. One component serves both, so the two cannot drift; a fence that does not parse keeps its frame and shows the parser's message over the source instead of leaving an empty box. The file reads the *buffer*, not the loaded document, and so - unlike the other two render stops - it stays available on a dirty file: a diagram of what was last saved is not what someone editing a diagram wants to look at.

  The drawing is sized rather than transformed, from the `viewBox`: at 100% the svg keeps mermaid's own `width: 100%` capped at the drawing's width (as wide as the pane, never wider than the drawing), and away from 100% it gets an explicit width so the pane scrolls to the rest instead of squeezing the diagram. The control is `− | 100% | +` with the percentage as the way back to fit, multiplicative at the same 1.25 (0.25–4) the slide preview uses, so one press means one thing wherever a preview has a zoom; ctrl/⌘ + wheel does the same thing through a hand-attached non-passive listener (React's own wheel listener is passive, so `preventDefault` there does nothing and the webview zooms the whole window). It sits in the file's view switch - the bar every view control belongs to - and in the fence's block header, which now takes an `actions` slot.

  `mermaid` is imported dynamically and only there, so it arrives with the first diagram rather than with the window: `vite.config.ts` pins it to its own `mermaid` chunk, `dist-graph.mjs` lists it among the packages a startup chunk may not contain, and `dist-budget`/`eager-budget` hold both lines. It is 4.8 MB of script that no launch pays for, and the probe measures that from the running app too: the page's own `index.html` names no mermaid asset, and the chunk appears only once a diagram is opened.

  Two subtlety that measurement settled, both now pinned by a test: mermaid's base theme does arithmetic on every colour it is given (`adjust`, `invert`, `darken`), so the theme tokens are resolved to opaque hex first - an `oklch()` value or a `var()` reference is not something that arithmetic can work on, and it does not throw, it draws nothing or draws black - and `render(id, text, container)` is *not* used: mermaid draws inside that container and then removes it again before its promise resolves (`removeTempElements`), which is why a `.mmd` opened to an empty pane with the svg present during the await and gone after it. The returned markup is parsed (`text/html`, so `<foreignObject>` labels stay HTML) and inserted, never assigned as a string.

  The zoom's centring is `justify-items: safe center` rather than `place-items-center`, and that is not cosmetic: a drawing wider than its pane centred both ways overflows to the left of the scroll origin, where no amount of scrolling reaches it. Measured at 381% - the drawing 1372px wide in a 1102px pane - its left edge sits 24px right of the origin and the pane scrolls the remaining 294px.

machine: probe PASS - 360x430 drawing whose node fill is the theme's `--card` and whose edges are `--muted-foreground`, the markdown fence drawn too, a broken source falling back to its own text over mermaid's parse error, a light-theme switch redrawing in the light `--card`, zoom 100% -> 125% -> 100% -> 80% -> 100% with the drawing's box following, the 381% overflow reachable from the origin, and no mermaid in `index.html`.

**JetBrains Mono ships both italic faces**

- `src/styles/fonts.css`, `src/lib/fonts.ts`, `src/lib/fonts.test.ts`: the app asks for four combinations of its monospace face and shipped two. The terminal keys each glyph on bold and italic separately and rasterises `${italic ? "italic " : ""}${bold ? "700" : weight}`, so `\e[1;3m` is a state it really draws, and the editor asks for italics wherever a theme styles emphasis - with no italic face the browser shears the upright outline, which is a different typeface (the real italic has a single-storey `a` and an `f` that descends). The two faces come from `@fontsource/jetbrains-mono`, already a dependency, so nothing was downloaded and nothing was added to the manifest. `ensureMonoFontsLoaded` waits for all four, which is what the terminal needs rather than what the stylesheet needs: a glyph rasterised before its face arrives is baked into the atlas, which is keyed per cell and only rebuilt on demand. One test holds the stylesheet to the four combinations and to the package's files; the existing preload test now expects both italic loads.

**No theme carries a texture of its own**

- `src/modules/theme/themes/pattern-base.ts`, `src/modules/theme/themes/pattern-base.test.ts` (removed), `src/modules/theme/themes/themeNames.ts`: Carbon Fiber no longer paints a weave under the interface. The theme carried two of them - a 2/2 twill computed from the geometry of the tows, carved one way on the dark palette and the other way on the light one, with its tile size travelling with the tile - and it is colours now, like every other theme: graphite and a silver-cyan sheen, which is what it was ever recognised by from a distance. The decision was between "a theme with a texture of its own silences the material" and "a theme decides the colours, the shape axis decides the material", and it went the second way: one look per palette, and what a theme decides is what a theme has always decided here. Its name and description say colours rather than a weave in both languages, and the test file went with the generator it existed for.
- What is left is a supported path rather than dead code: `ThemeSurface`, `surfaceFrame` and the `surface` field still work for a theme file somebody writes by hand, so a custom theme may still carry a texture - it is the built-ins that no longer ship one. `applyTheme.test.ts`, which drives the mechanism with a synthetic theme, is unchanged.

**The screenshot chord works from outside the window**

- `src-tauri/src/modules/screenshot/hotkey.rs`, `src/modules/screenshot/useGlobalScreenshotHotkey.ts`, `src-tauri/src/modules/screenshot/mod.rs`, `src/app/App.tsx`: the screenshot's chord is registered with the operating system, so it starts a capture while the app is minimised, hidden in the tray or simply behind another window. Everything else was already in place - the grab reads the screen through GDI, the window is excluded from captures, and the overlay takes the focus it needs - so what was missing was a trigger, and a window listener cannot be one: Windows delivers keys only to a window that has the focus. `RegisterHotKey` is the system's own answer. With no window handle the message goes to the *thread* queue, so a thread that reads its own queue is enough and the capture is handed to the main thread from there; the two calls are in `windows-sys`, which the crate already depends on, so this is not a plugin and not a crate. The chord follows the preference: the page re-registers whenever `screenshot.capture` changes, because a global hotkey that outlives its binding is a key the whole machine loses. A chord with no modifier is refused (a bare `A` would be a letter nobody could type anywhere), and a chord another application already owns is reported rather than pretended to be live.
- `scripts/dev/probes/global-hotkey.mjs`: fires the chord for real - `SendKeys` goes through the system's input queue, which is the only way to reach a global hotkey, since an event synthesised in the page never leaves the page - and checks three states: hidden (`plugin:window|hide`), minimised, and on screen with another of the app's own windows holding the focus. It reads the chord from the user's own settings rather than assuming the default, watches the overlay's `screenshot:armed` message rather than a window that may have been left open, completes one full capture from the hidden state (file, size and pixels), restores the binding and the window, and deletes the screenshot it caused. Three Rust tests cover what can be checked without an operating system: a chord with no modifier is refused, letters, digits and function keys get their virtual codes, and the modifier bits are the ones the Windows headers define - the last one caught its own bug on the first run, where the test's base chord already had Alt in it.

**A screenshot from the tray, and 无界 stops drawing inside itself**

- `src-tauri/src/modules/tray.rs`, `src-tauri/src/modules/screenshot/mod.rs`, `src/app/hooks/useTray.ts`, `src/modules/i18n/messages.ts`: the tray menu has a 截图 item. It exists for the case the shortcut cannot cover - minimised, in the tray, or simply not in front - because only the *trigger* was ever missing: the grab reads the screen, so it never needed a focused window. The menu item and the page's own button both end in `screenshot::begin`, one function with two callers rather than two copies, and the menu ids are constants behind a small `action_for` mapping so an item that ships without a handler is a failing test instead of a click that does nothing. The item deliberately does not bring the main window forward first: the picture wanted is the screen behind the app.
- `scripts/dev/probes/tray-screenshot.mjs`: hides the main window, starts the capture through the function the tray item calls, drags a selection on the overlay with real mouse input and saves it, then checks the `screenshot:saved` payload, the file on disk, the pixels (a flat picture is what the grey veil or a failed grab looks like) and deletes what it caused. The tray click itself cannot be synthesised - an icon nobody pinned lives in the overflow flyout, the same reason `tray-return.mjs` drives the commands - so the menu-to-action mapping is covered by a Rust test and the label round-trip is checked here. Two things it had to learn on the way: the main window is `http://tauri.localhost/` exactly, because the capture overlay is served from the same origin and has none of the window permissions; and the overlay is one window kept alive between captures, so a leftover selection has to be cleared with Escape and the capture re-armed, or the drag moves the old box instead of drawing a new one.
- `src/modules/sidebar/SidebarRail.tsx`, `src/styles/globals.css`: in 无界 the sidebar's 会话/文件 rail no longer paints its own band or the hairline above it. The band is there so the switcher sits apart from the list, which is right while the sidebar is a card with edges of its own; 无界 is the shape that removes those edges, so the band was the last line drawn inside one surface and the rail read as a strip pasted onto the panel. What is state stays: the chosen view's background and the hover. The other shapes keep the band.
- `scripts/dev/probes/theme-shape.mjs`: reads the rail's background and top border with the rest of the shell and refuses a 无界 that still draws them - and a shape that removed the band where it belongs. A collapsed sidebar has no rail, which is reported rather than passed over.

</details>

<details>
<summary><strong>2026-11-11</strong></summary>

**Switching shape from the palette, and a drawing you can read**

- `src/modules/command-palette/commands.ts`, `src/modules/command-palette/CommandPalette.tsx`, `src/modules/i18n/messages.ts`: 「切换形态…」 sits right under 「切换主题…」 in the palette, and opens a page of its own the way the theme list does - the six choices with their drawings, the current one ticked, Escape or Backspace-on-an-empty-query going back to the commands. The two pickers became one shape in the component (`page` is `root`, `themes` or `shapes`) so the search, the history and the content legs stay shut while either is open, and a shared `PREVIEW_DELAY_MS` covers both: walking the pointer down the list must not repaint the window on every row it crosses.
- `src/modules/theme/ThemeProvider.tsx`: `previewShape`, the shape's counterpart to `previewThemeId` - hovering a row shows the shell that shape without writing the preference, and choosing one ends the preview the way `setThemeId` does. `shapePref` is exposed next to it so a picker can tick the *choice* rather than whatever the theme is suggesting or the pointer is passing over.
- `src/modules/theme/shape.ts`: the six names moved here, as `SHAPE_LABELS`, because two pickers offer them now and a preset that ships without a name in either is a bug the type checker catches in one place instead of two.
- `src/modules/theme/ShapeIcon.tsx`: the drawing is redrawn, and it moved out of `src/settings` to sit with the shape data both pickers read. Three things were wrong with it. Its tones were `--background` and `--muted`, two near-whites in a light theme, so five of the six choices drew as one pale plate; every tone is now a mix of `--foreground`, which is dark in a light theme and light in a dark one, so the drawing has contrast whichever way the palette goes. Its three panes were equal thirds, which reads as a column grid rather than as a window; the sidebar is the narrow one now, the workspace twice its width, the right panel narrower still. And its corners followed the radius slider linearly, so an 8px-wide pane at the top of the range drew as a pill and the icon as an hourglass; the panes are capped at 45% of their own width and the block carries the rest of the range. The gutters are drawn a touch stronger than the panes - which is what the shell does with `--frame`, only at a contrast a 30x24 drawing can be read at - so 无界 (no gutters, one block) and 极简 (three panes, hairlines between) are told apart by the picture and not only by their names.
- `scripts/dev/probes/shape-picker.mjs`: the same probe now drives both pickers. It measures the drawings on the choices that carry the measurement (the block's corners on 无界, the workspace pane's on 极简, since the narrow panes stop getting rounder on purpose), then opens the palette with Ctrl+P, finds 「切换形态」, checks the six drawings are there, hovers 云朵 and asserts the shell previews it **without** the preference changing, presses Escape and asserts the page went back a level and the preview went with it, then clicks 云朵 and asserts the window and `shapeId` both took it.

**The corner radius is a preference of its own**

- `src/modules/theme/radius.ts`, `src/modules/theme/radius.test.ts`: the radius is its own axis now, with seven stops - 0, 4, 6, 8, 10, 14 and 16 px - because it used to be a field of every shape preset, which made two unrelated things one decision: wanting rounder corners meant giving up the lit edge, the material or the merged shell, and the preset decided the corner of every card and input in the app. The stops cover every radius the presets used to carry (0, 6, 8, 10, 16), the default is `0.625rem` - the value the stylesheet had before this axis existed, so nobody's saved look changes - and the *value* is stored rather than its position, so a stop added or removed later still leaves a stored choice resolvable. An unknown value answers the default instead of leaving the app without corners.
- `src/modules/theme/applyTheme.ts`, `src/modules/theme/ThemeProvider.tsx`, `src/modules/settings/store.ts`: the radius is applied by its own effect, after the theme's and after the shape's, and it is the last thing to speak - a theme may still spell `colors.radius`, and the axis the user chose by hand has to win over it. `--radius` left `SHAPE_VARS` for the same reason: a shape that cleared it would reset the corners every time a preset changed. The preference is `cornerRadius`, stored and broadcast like every other one.
- `src/modules/theme/shape.ts`, `src/styles/globals.css`: 无界 no longer needs square corners for its own sake, so the radius lands on the merged block's outer frame instead - the left region keeps its two left corners, the right region its two right corners, the workspace none, and the three stay flush. Two rounded corners meeting along a seam that no longer exists are what would show the frame through the notch, and this is the shape that has no seam to show it through.
- `src/settings/sections/ThemesSection.tsx`, `src/modules/i18n/messages.ts`: one slider under the shape choices, in stops rather than a continuous range - a dot per stop, the current one lit, the value in pixels next to the label - since a radius is picked by eye and a dial invites fiddling. The section's own description no longer mentions corners, because they are not the shape's business any more.
- `src/modules/theme/ShapeIcon.tsx`, `src/settings/sections/ThemesSection.tsx`: the shape choices draw the shell in miniature - the three regions, the gutter between them, the border, the shadow, the material - instead of one square that leaned on the radius to be recognisable. That lean is what stopped working when the radius left: 无界 and 极简 would have drawn the same square. The radius, the gutters and the border come from the real values, so the drawings follow the slider; the shadow and the sheen are drawn at icon scale, because a real `0 8px 24px` card shadow on a 24px drawing is a smudge. **Known item**: with a region collapsed (width 0) the merged block loses the corner on that side, since there is nothing there to round.
- `scripts/dev/probes/radius-stops.mjs`, `scripts/dev/probes/theme-shape.mjs`, `scripts/dev/probes/shape-picker.mjs`: the new probe walks all seven stops and checks that `--radius`, the `--pane-radius` derived from it and the computed corner of a real pane agree - a stop control whose value and effect drift apart is the one thing it cannot afford - then checks the merged block's four corners per region at a non-zero radius, and that the glass shape's terminal is still transparent with a radius on. `theme-shape.mjs` dropped its per-shape radius assertions, and `shape-picker.mjs` now measures the drawings (three regions, one merged choice, the drawings following the slider) rather than their corners.

**A transparent terminal, a floating shape, and a control you can hit**

- `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts`: the WebGL context no longer asks for `desynchronized`. That hint takes the canvas out of the browser's ordinary compositing path, and such a canvas stops honouring its own alpha: in the acrylic shape a fully transparent terminal was presented as opaque black. It only showed at the square radius stop, because a rounded clip on the pane routes the canvas down a path where the hint happens to be ignored - which is why the report was "black at the lowest radius stop" rather than "black in acrylic". Found by reading screen pixels; `Page.captureScreenshot` samples the page and showed a perfectly translucent terminal the whole time, so this is the one class of bug the other probes in `scripts/dev/probes` cannot see (`glass-composite.mjs` now paints a known colour behind the canvas and asks the screen).
- `src/modules/theme/shape.ts`, `src/styles/globals.css`: 云朵 is the floating card it was meant to be - its panes step in from the frame and carry a soft shadow. Before, the shape only wrote a card shadow that could not reach anything floating: a pane that meets the header and the status bar flush has nowhere to cast one, the panel box clipped what it did cast, and the result was 极简 with a slightly fainter border. `scripts/dev/probes/theme-shape.mjs` now checks both halves of the recipe.
- `src/settings/sections/ThemesSection.tsx`: the corner-radius slider keeps a taller band to click in (its thumb is 16px tall, which is a small thing to hit), and each of its seven stops is a button that jumps there - the same move the slider makes, made directly.

**Carbon Fiber weaves, and 云朵 stops spilling its panes**

- `src/modules/theme/themes/pattern-base.ts`, `src/modules/theme/themes/pattern-base.test.ts`: the Carbon Fiber texture is a 2/2 twill now, computed from the geometry the way the honeycomb was. A weave is not a grid of shapes: it is tows woven over two and under two, which step sideways as they go, and what reads as carbon fibre is the bundles rather than the crossings - each tow is round, so it carries a highlight along its crest and falls into shadow at its edges. The tile is four tows square (3px tows, so 12px) and the size travels with the tile, because a size that does not match it leaves gaps between repeats. The light side carves the same weave the other way round: a white crest changes nothing under `multiply`, so what shows there is the shadow between the tows. A test holds the tile-to-size ratio, the two directions and the crest.
- `src/styles/globals.css`: 云朵 steps its panes in from the frame as **padding on the wrappers** rather than a margin on the panes - the pane is `height: 100%`, so a margin pushed it 8px past the bottom of its box and the panel clipped its bottom edge, which is what showed as a card cut off at the bottom. The step-in is 6px above and below and 4px on the inner edges, measured on screen: that leaves a 9px margin at the window's edge and a 12px gap between two panes (the handle takes 4px of it), where 8px anywhere left the gutters wider than the margins they sit next to and the panes reading as drifting apart.
- `src/styles/globals.css`: the comment above the shape rules claimed a pane can never carry a drop shadow because the panel box clips what a flush pane casts - which is exactly why 云朵 now steps its panes in, so the comment says that instead of contradicting the rule below it.

**Two tones that were not the tone next to them**

- `src/modules/theme/themes/pattern-base.ts`, `src/modules/theme/themes/terminal-pane-tone.test.ts`: the Carbon Fiber light variant gave its terminal `#fbfcfc` while its panes paint `#f4f5f5`. The workspace paints the pane colour behind the terminal canvas, so the difference showed as a rectangle sitting on the workspace - and in 无界, where the three regions merge and nothing borders them, it looked like a sheet laid over the window. Every other built-in theme already had the two tones equal, so the new test holds all of them to it (a terminal that is `transparent` or carries alpha is the glass case and is left alone).
- `src/settings/components/ShapeIcon.tsx`: the shape drawings stopped taking their gutter colour from the frame. `--frame` is translucent whenever the window's material is on, so the drawing borrowed whatever sat behind the settings card; and in a light theme the frame, the card and the pane are three near-whites, which drew five of the six choices as one pale plate. The gutter is `--muted` with a hairline ring now: opaque, and a tone apart from the panes in both polarities.

**The mode choice moves to the Themes section**

- `src/settings/sections/ThemesSection.tsx`, `src/settings/sections/GeneralSection.tsx`, `src/modules/i18n/messages.ts`: 跟随系统 / 浅色 / 深色 moved from General to the top of the Themes section. It is the one choice everything else in that section depends on - which palette applies, which shape, which background - and General is left with what is about the app's own chrome. The hint under it used to send people to the Themes tab; it now says what 跟随系统 does, which is what it is standing next to.
- `scripts/dev/probes/shape-picker.mjs`: the picker is found by its `aria-pressed` buttons rather than by being "the only three-column grid on the page" - the section holds two of those now, and the old selector would have measured the mode buttons.

</details>

<details>
<summary><strong>2026-11-10</strong></summary>

**Acrylic is a shape, not a theme - and a shape decides its own corners**

- `src/modules/theme/shape.ts`, `src/styles/globals.css`: the presets are six now - 无界 `boundless`, 极简 `minimal`, 云朵 `cloud`, 浮雕 `emboss`, 石板 `slab`, 玻璃 `glass` - and each carries a border colour as well as a width, because a border is drawn in whole device pixels and never thinner than one: a declared 0.5px is used as 1px at 100% scale, which left the thinner presets looking exactly like the plain one. `boundless` is the merged one: the three regions of the window - the sidebar, the workspace and the right panel - become one sheet, with no border between them and the frame behind and no gutter either (`src/app/App.tsx` names the three wrappers, `src/styles/globals.css` closes the inner padding and the width the resize handles take), while the outer margins and the window's own DWM corners stay. Its inside is square because of that: two rounded corners meeting along a seam that no longer exists would leave the frame showing through the notch.
- The radius is the shape's own now. A theme that spelled `colors.radius` used to win over the shape, which drew the same preset square in one theme and rounded in another - the one thing an axis exists to prevent. `ThemeColors.radius` is still accepted and written by `applyTheme`; the shape writes it afterwards, and the shape is the last word.
- `src/modules/theme/shape.ts`, `src/modules/theme/WindowVibrancyBridge.tsx`, `src/modules/theme/themes/acrylic.ts`, `src/modules/theme/themes/index.ts`: the desktop material moved onto the shape. It used to be a theme's `glass.desktop`, which made "acrylic" a thing a theme had to be; now `glass` asks for it, the acrylic tint recipe travels with that shape, and the bridge reads the shape instead of the theme. The `Acrylic` theme keeps its colours and suggests `glass`, but it is no longer in the list (`listBuiltinThemes` retires it) - a stored `themeId: "acrylic"` still resolves, as those colours in that shape, rather than falling back to the default theme.
- `src/modules/theme/shape.ts`: under the material the terminal stops painting the theme's colour (`--terminal-background: transparent`), because a solid rectangle in the middle of a translucent window is the one place acrylic looked broken. Switching away puts the theme's colour back (`ShapeOptions.themeTerminal`), rather than leaving a see-through terminal behind. A theme that brings its own glass recipe keeps it (`ShapeOptions.themeGlass`).
- `src/settings/sections/ThemesSection.tsx`, `src/modules/i18n/messages.ts`: the picker offers the six shapes and draws each one with the values it would write - radius, border width and border colour - so they can be told apart before being applied (无界 is the only choice whose swatch shows no channel between the panes, because it is the only one that closes it). The theme list stays one flat list - it was briefly grouped by how many palettes a theme had, which just pointed at the three themes that were missing one.
- `src/modules/theme/themes/dracula.ts`, `src/modules/theme/themes/kanagawa-dragon.ts`, `src/modules/theme/themes/tokyo-night.ts`: each of the three themes that answered only in the dark now ships both palettes and both editor pairings. Kanagawa Dragon takes Kanagawa's own daylight palette (Lotus) and Tokyo Night takes its own Day; Dracula publishes none, so its light variant is derived from its hues (and uses `github-light` for code, since there is no light Dracula editor theme). A test now holds every built-in theme to two palettes.
- `src/modules/terminal/TerminalPane.tsx`: the terminal reads its colours from CSS variables, and it did so only when the mode or the theme changed - so switching to the glass shape left every pane painting the theme's solid colour, which is a black rectangle in the middle of a translucent window. The shape is now one of the things that makes the pane read again (on the next frame, because the provider applies the shape in its own effect and a child's effect runs first). `scripts/dev/probes/glass-terminal.mjs` holds it: the surface's own background has to end up transparent, which is the half the shape cannot satisfy alone.
- Measured the hard way: `color-mix(in oklab, var(--border) 140%, ...)` is an invalid value, and an invalid custom property makes the whole `border` shorthand invalid at computed-value time - `border-style` drops to `none` and the pane's border to 0px, so a shape looked like it had lost its border rather than its colour. The colours are legal now and a test refuses any `color-mix` whose percentages exceed 100.

**The shell's shape becomes an axis of its own, and a theme can state its appearance**

- `src/modules/theme/shape.ts` (new) and its test: the nine shapes as data - corners, border width, and what a shape does with shadows, a lit edge and the accent band - following ModelHarbor's `style.rs` presets. `resolveShape` answers the CSS variables and attributes and writes nothing, so it is testable in node; an unknown id answers `soft` the way `from_key` falls back, because a theme file is editable and a typo in `shape` must not blank the window. `soft` is exactly the values the stylesheet already had (`--radius: 0.625rem`, a 1px border, the shadow the sheet gives it), which is what makes this stage invisible. A theme's own `colors.radius` wins over the shape's - eight built-in themes spell one in fifteen places and must not be re-squared by a shape.
- `src/modules/theme/appearance.ts` (new) and its test: the three things that were global switches and are now something a theme can have an opinion about - the desktop material, and the opacity and blur of the user's background image. The rule is the one this store already uses everywhere: a stored value wins, with nothing stored the theme's default applies, with neither today's default. Each field is decided on its own and reports where its value came from, which is what lets the settings page say "following the theme". Values from a hand-edited file are clamped or refused rather than written through to a CSS variable.
- `src/modules/theme/types.ts`: `ThemeAppearance`, `ThemeVariant.appearance` and `Theme.shape` - the shape being a suggestion a chosen preference overrides, the same way `editorTheme` and its auto setting work.
- `src/modules/theme/applyTheme.ts`: `applyShape`, the thin cell that puts a resolved shape on the document element. What a shape brought along is cleared first, so leaving `emboss` does not leave a lit edge behind; `--radius` is left alone entirely while the theme is speaking.
- `src/modules/settings/store.ts`: the `shapeId` preference, its key, its default, its setter, and its line in `PREF_KEY_TO_FIELD` - the table without which a written value reaches no window's store and the control never moves. It holds `auto` until someone chooses, which is not the same as the shape called `soft`: `soft` is something a user can pick on purpose, and only "nothing chosen" lets a theme suggest a shape. A stored value nothing recognises is treated as absent, so a hand-edited settings file follows its theme rather than silently pinning a shape.
- `src/modules/theme/shape.ts`: `SHAPE_AUTO`, `resolveShapePref` and `isShapePref` - the "let the theme decide" half of the axis, plus the rule that a chosen shape wins over a suggestion and survives a change of theme.
- `src/modules/theme/ThemeProvider.tsx`: the shape gets an effect of its own rather than a tail on the theme's, because the default theme returns from `clearTheme` - a shape hung off that one would never be written for the theme most people use. It also has to answer a change of mode and of theme, since a theme may suggest a shape and may spell its own `--radius`.
- `src/styles/globals.css`: `.verta-pane` reads `border: var(--pane-border-width, 1px) solid var(--border)`. With no shape writing the variable this is the same 1px it was.
- `scripts/dev/probes/theme-shape.mjs` (new): the machine check, driving the two steps a picker takes - the value written to the settings store and the `verta://prefs-changed` event that makes every window follow - and reading back what the document carries. Measured on the release build: `tag` answers `--radius: 1.25rem`, a declared 0.5px border and a 28px pane corner; `minimal` answers `0` / `0px` and a pane that draws no border at all, while `--window-radius` stays 8px throughout - the window's corners are DWM's and a shape does not get to un-round them; `glass` carries `data-shape-material="native"` and no other shape carries it; `emboss` answers 0.5rem / 1px; and the default, `soft`, answers exactly what the shell answered before the axis existed. A border is drawn in whole device pixels and never thinner than one, so a declared 0.5px is used as 1px at this scale - the variable is the truth and the probe accepts only the declared value or that rounding. The user's stored value is read first and put back afterwards, including "there was none".
- `src/modules/theme/index.ts`: the two axes are exported from the module rather than imported by path from the settings page later.
- `src/styles/globals.css`: the four shapes that are more than geometry now paint. `slab` needed nothing (`--pane-shadow` was already read), `cloud` puts `--card-shadow` on the surfaces that actually float - panes meet the header and the status bar flush and the panel box clips anything cast outward, which is why the shell's chrome has no drop shadow at all, so a card shadow belongs on a card - `emboss` draws its two inset edges on the pane, and `band` paints an accent strip along the top edge with `::after`, because `::before` is the glass backing layer. No blur, no backdrop filter, no 3D transform.
- `src/settings/sections/ThemesSection.tsx`, `src/modules/i18n/messages.ts` (zh and en), `src/modules/theme/index.ts`: the picker. Ten choices - `auto` first, then the nine presets - and each one draws itself with the values it would write (`borderRadius` and `borderWidth` read out of `resolveShape`), so `fine` and `minimal` are distinguishable before anything is applied. `auto` is not `soft`: it means "whatever the theme suggests".
- `scripts/dev/probes/shape-picker.mjs` (new): the machine check, and the part that has failed in this codebase before - propagation across windows. The picker is pressed in the Settings window and the assertion is about the main window's document. Measured: ten choices with five distinct radius/border drawings and `minimal` square and borderless; pressing 标签 turns the main window into `1.25rem` / `0.5px` and the Settings window too; pressing 极简 leaves `--window-radius` untouched; pressing 跟随主题 lands back on `soft`. The stored preference is read first and restored afterwards, including "there was none", and the window the run opened is closed by the run.

**The two side panels slide instead of jumping**

- `src/modules/sidebar/usePanelSlide.ts` (new): the window during which a panel's width change is drawn rather than snapped. Both side panels are `react-resizable-panels` panels; measured on this build a 220px sidebar carries its width as `flex: 16.07 1 0px`, so the width is a proportion held in `flex-grow` and `flex-basis` never leaves 0 - one CSS transition on that number is the whole animation. Only while a toggle is in flight: dragging a divider rewrites the same shorthand on every pointer move, and a transition there would leave the edge trailing a quarter of a second behind the pointer. `flushSync` puts the flag in the DOM before the change (the transition has to be on the element at the moment the width is rewritten - the same placement-then-transition two-step the compact session card documents), and the window closes on `transitionend` from the group, with a timer only for the case where no transition ran at all.
- `src/modules/sidebar/useSidebarPanel.ts`, `src/modules/sidebar/useRightPanel.ts`: the six places a panel is opened or closed from - the toggle, a rail click, the command palette, the explorer shortcut, and the right panel's own two - all go through that window, so nothing jumps while nothing drags. Each hook returns whether its side is sliding.
- `src/app/App.tsx`: the flag and the end of the window live on the panel group, so the terminal growing as a sidebar closes is part of the same motion rather than a jump after it.
- `src/styles/globals.css`: the one rule, scoped to `[data-panel-slide] [data-slot="resizable-panel"]`, animating `flex-grow` and nothing else. The duration is a motion token, which is what makes `prefers-reduced-motion` snap it shut without a second rule, and nothing here builds a compositing layer - no blur, no backdrop, no 3D transform. The first version of this rule animated `flex-basis`, which measured as no animation at all: the property resolved to 0.24s and the width still went 220 -> 0 in a single frame, because the library never changes it.
- `src/styles/panelSlide.test.ts` (new): pins those three properties of the rule - scoped to the flag, `flex-grow` rather than a property the library leaves alone, a token duration rather than a literal - because it lives in the global stylesheet and nothing in a component would notice it being widened to every panel or pointed at the wrong property, which is what happened first.
- `scripts/dev/probes/panel-slide.mjs` (new): the machine check, run against the release build. Each side is toggled twice while its width is sampled frame by frame, and the numbers have to show travel rather than a jump - measured: the sidebar closes 480 -> 0 over ten intermediate widths and opens back over eleven, the Git panel 260 -> 0 over ten and back over nine, no horizontal overflow on the document in any of the four, and the flag is off before the first sample and after the last (a flag left on would animate every later divider drag). With `prefers-reduced-motion: reduce` emulated through the debugger the same toggle is one step, which is the token contract doing the work rather than a second rule.

**A picture is one table of formats, and one the window cannot draw is not named a PNG**

- `src/lib/imageFormats.ts` (new) and its test: the one table of what a picture is - what a WebView2 window draws by itself (`png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`), and the one kind that is both a picture and a document (`svg`, opened as text and drawn as a thumbnail). Four panes had grown a list of their own and drifted: the editor's main view knew `svg` and not `bmp`, the column beside it knew `bmp` and `avif` and not `svg`, so a file the sidebar drew a thumbnail of answered "cannot be displayed" when it was opened.
- `src/modules/editor/EditorPane.tsx`, `src/modules/editor/SidePreview.tsx`, `src/modules/terminal/ghostty/terminalImages.ts`: all three read that table now. A bitmap or an AVIF opens in the main view instead of being called a binary file, an SVG keeps its source in the editor and gets its drawing beside it, and a filename the terminal prints is recognized by the same list rather than by a fifth one.
- `src-tauri/src/modules/agent_sessions/image.rs`: the mime a terminal attachment is handed over with is read off its own bytes, and a format nothing names is refused rather than called a PNG. Calling it a PNG is what drew a broken picture: a `data:` URL is not sniffed by the browser, so every bitmap the terminal lists (`.bmp` is on that list) came out as a PNG that was not one. Bitmaps, icons and AVIFs are named now; anything else leaves the terminal's own mosaic in place, which is how that terminal shows a picture to begin with. The heads are measured and pinned in the tests.
- `src/modules/markdown/MarkdownViewToggle.tsx` and `src/modules/editor/EditorPane.tsx`: a picture's preview switch moved to where a Markdown file's switch is. The bar and the class of one stop are drawn in one place now (`ViewToggleBar`, `toggleStopClass`) instead of the image pane copying the styling: a Markdown file offered its switch in the top right of the editor column and a picture offered the same choice as a lone button in the bottom right, so the control moved depending on what kind of file was open. Same corner, same bar, same size of stop - a picture simply has one stop rather than a document's three.
- `scripts/dev/probes/image-formats.mjs` (new): the machine check, run against the release build. Measured: the 2x2 bitmap is drawn by the main view (`http://asset.localhost/...`, `naturalWidth` 2, no 二进制文件); the SVG keeps `<svg` in the code editor and the column beside it draws the file at its own 24 by 16; the AVIF takes the picture path and answers 读不出这张图片 rather than 二进制文件 (the fixture's bytes are its `ftyp avif` box and no pixels, so not decoding is the right outcome); the file of bytes nothing names is still 二进制文件 with no picture; and the preview switch measures `top: 12, right: 12` for both the Markdown pane and the picture pane, inside the same 27px-high bar. Two traps this window sets, both of which would have made the probe pass on nothing: the icons are `<img>` elements too (a Hugeicons glyph is a `data:image/svg+xml` URL - 15 of them on the control pane), so only `asset.localhost` sources count as pictures of files; and a hidden editor tab is `visibility: hidden`, which `checkVisibility()` ignores by default, so the ancestors are walked instead.

**A working directory Git-Bash spelled is asked about, once per spelling**

- `src-tauri/src/modules/fs/translate.rs` (new) and `src-tauri/src/modules/fs/mod.rs`, `src-tauri/src/lib.rs`: the `translate_path` command - what a path means on Windows when a POSIX shell spelled it. Git-Bash reports its cwd over OSC 7 in MSYS spelling, and only one shape of it can be repaired by reading (`/c/Users/x`, which the OSC 7 parser already turns into a drive). `/tmp`, `/usr/bin` and `/home/x` are real places under the Git for Windows install or under `%TEMP%`, and no amount of reading says which: `/tmp` is the user's temp directory only according to the install's own mount table. So the shell is asked, through the `cygpath -w` MSYS ships for exactly this, and the answer is what a Windows API can then open. The translator is found beside the shell (`<Git>/usr/bin/cygpath.exe`, which is where the tool actually is - measured: there is none in `Git\bin`), the leaf's own shell is used when it named one, and a refusal is an ordinary answer rather than a failure. Measured: `/tmp` is `C:\Users\<user>\AppData\Local\Temp`; a path under no mount comes back as a plausible path that does not exist, so nothing here pretends to validate and the caller still shows what the filesystem says.
- `src-tauri/src/modules/pty/shell_init.rs`: the Git for Windows bash search is reachable from the translator, because only the install that spelled a path can translate it.
- `src/modules/terminal/lib/spelledCwd.ts` (new) and its test: the answer is kept beside the spelling, keyed by what the shell said, because the shell reports the same cwd at every prompt - a translated path written into the terminal once would be overwritten by the next prompt. A refusal is remembered too, so a machine with no Git install is asked once rather than once per prompt.
- `src/lib/native.ts`, `src/app/App.tsx`: a reported cwd that needs translating is asked about before the leaf keeps it, so the path the pane stores - and with it the breadcrumb, the folder menu, the explorer root and what a restored tab saves - is one Windows can open. While the first ask is in flight nothing is written: a spelling nothing can open is worse than the path the pane was showing a moment ago.
- `src/modules/statusbar/lib/pathUtils.ts` and its test, `src/modules/statusbar/CwdBreadcrumb.tsx`, `src/modules/i18n/messages.ts`, `src/modules/statusbar/CwdBreadcrumb.test.ts` (new): the breadcrumb's folders-beside-this-one menu - every segment's own drop-down, and the list beside the current folder, with the folder the trail is standing in marked - which is what asked `list_subdirs` about a spelling it could not open in the first place.
- `scripts/dev/probes/statusbar-siblings.mjs` (new): the machine check. A terminal of the product's own (its shortcut, not a session opened the raw way - that one has no receiver on the page, so its shell's OSC 7 never reaches the window), moved with `cd` to `/tmp/<fixture>/inside`, the fixture's MSYS spelling. Measured: `translate_path` answers `C:/Users/<user>/AppData/Local/Temp/<fixture>/inside`, the raw spelling still fails with 系统找不到指定的路径, and the trail shows the Windows path while the shell stands in the POSIX one; the folder's menu then lists `deeper`, `sibling-a` and `sibling-b` with `inside` marked, choosing `sibling-a` moves the shell there, and the first segment's caret lists `C:/Users` - the same six folders `list_subdirs` answers with, `cxj` marked.

</details>

<details>
<summary><strong>2026-11-09</strong></summary>

**A page is a sheet the document is laid out in, not a band of white behind it**

- `src/modules/editor/lib/docxPages.ts`: what pagination answers is which blocks each page holds, not how much padding to put above the block that began one; the two helpers that padded a block to line it up with a painted sheet are gone with the painting.
- `src/modules/editor/DocxPreview.tsx`: the pages are real boxes - one element per page, the section's size with its margins as that page's padding, white with its own shadow, the page number in its corner, and the gap between sheets a gap between elements. Pagination measures the document once as a single column, then moves every block into the page it starts on; the repeating gradient, the overlay that drew the page numbers and the padding that pushed a block onto its band are deleted. A block taller than a page makes its sheet grow rather than being drawn over the sheet below.
- `src/modules/editor/docxBodyDom.ts`: the caret and the selection are carried across that move by block and text offset - both ends of a selection, because a range does not survive the node it points into being moved - and every read of the body (the paragraphs written back, the list numbering, deleting a paragraph) counts blocks across the pages in document order rather than the body's own children.
- `scripts/dev/probes/docx-preview.mjs`: reads the page rather than the paper, because the margins and the white are the page's now.
- `scripts/dev/probes/docx-pages.mjs` (new): a ninety-paragraph archive is opened and checked page by page - at least three sheets, every sheet the section's size with its margins and one page number, every block wholly inside the page it starts on, no block drawn across a page break, and a line typed at the end of a full first page landing on the second with the caret.

**A picture the pane cannot draw is counted, not silently dropped**

- `src-tauri/src/modules/docx.rs`, `src/lib/native.ts`, `src/modules/editor/DocxPreview.tsx`, `src/modules/editor/docxBlocks.test.ts`, `src/modules/i18n/messages.ts`: a document that names a picture nothing here can draw (a TIFF, or anything else the webview has no decoder for - what a scanner, a fax or an old Word leaves behind) used to leave an empty line and no word about it, so a document missing its figures read as a document that never had them. The reader now counts the pictures it could not turn into an image, the count travels with the read, and the pane says how many under the sheet. A picture past the per-image size cap is also skipped and counted rather than refusing the whole read, which is what one oversized photograph used to do and what the `.pptx` and `.xlsx` readers already did - a document whose pictures are too big still has its text.
- `src-tauri/src/modules/pptx.rs`, `src/modules/editor/PptxPreview.tsx`: the same count for a deck, taken from the picture shapes that ended up with no image, said in the slide tool bar.
- `src-tauri/src/modules/xlsx.rs`: one range check written as a range, which is what the current clippy asks for.
- `scripts/dev/probes/docx-preview.mjs`, `scripts/dev/probes/pptx-preview.mjs`: each fixture carries a picture nothing here can draw (a `.tiff`), and each probe asserts both halves - that no `<img>` is drawn for it, and that the count is said out loud.

**A Windows metafile is drawn, not counted**

- `src-tauri/src/modules/metafile.rs` (new) and `src-tauri/src/modules/mod.rs`: a Windows metafile (`WMF` or `EMF` - what Word holds a pasted chart, an equation or a screenshot as, and what no webview decodes) is replayed record by record into an SVG the pane draws: the shapes (`RECTANGLE`, `ELLIPSE`, `POLYGON`, `POLYLINE`, `LINETO`, and the path bracket `BEGINPATH`/`ENDPATH` with `FILLPATH`), the pen and brush an object is selected with, the text with its font, and the raster records (`META_STRETCHDIB`, `DIBSTRETCHBLT`, `DIBBITBLT`, `SETDIBTODEV`, `EMR_STRETCHDIBITS`, `BITBLT`, `STRETCHBLT`, `SETDIBITSTODEVICE`), whose device-independent bitmap is taken apart at 1, 4, 8, 16, 24 and 32 bits a pixel and re-encoded as a PNG. Both containers are read, the drawing is sized to its own ink, and a metafile that is one bitmap comes back as that bitmap. The field order is the one Windows itself writes, established from metafiles recorded through GDI and the pictures GDI+ rendered from them rather than from the documentation: GDI writes a rectangle record's corners bottom, right, top, left, and a raster record's `BITMAPINFO` two bytes further along than its layout suggests.
- `src-tauri/src/modules/office.rs`: `data_url` - the one place a picture becomes something an `<img>` can use - recognizes a metafile by its own bytes before it falls back to the extension, so a document's metafile is replayed rather than dropped. Word names the file whatever it likes, and a metafile in a document is a metafile whatever extension it carries.
- `src-tauri/src/modules/docx.rs`: the media table holds the `data:` URL itself, so a picture the reader converted keeps its own type instead of being re-encoded under the mime its name claims.
- `scripts/dev/probes/docx-metafile.mjs` (new): two metafiles Windows recorded - a rectangle, a filled rectangle, an ellipse, a polygon, a polyline, a line, text and a stretched bitmap - are put in a document, and the probe asserts both reach the pane as `data:image/svg+xml` pictures and that nothing is reported as undrawable. It screenshots the pane, to be put beside the PNGs GDI+ rendered from the same two files.

**A turn at work is read from opencode's own words, not from the circle it paints**

- `src/modules/terminal/lib/agentRules.ts`, `src/modules/terminal/lib/agentRules.test.ts`, `src/modules/terminal/lib/agentJudge.test.ts`: OpenCode's live phase now depends only on its footer's interrupt hint and positive shell/subagent tallies, as requested. Goal labels, icons and leftover `Thinking` text cannot keep a stopped session orange. Wrapped footers and the measured `esc...rupt` abbreviation still indicate work; questions retain their blue state, and other agent families keep their existing detectors.
- `src/modules/terminal/lib/agentState.ts`, `src/modules/terminal/lib/agentState.test.ts`: a job tally must be a positive integer, so `0 shells` or `0 subagents` cannot claim background work.
- `scripts/dev/probes/agent-state-judge.mjs`, `scripts/dev/probes/tab-agent-dot.mjs`, `scripts/dev/probes/launcher-session-state.mjs`, `scripts/dev/probes/tab-agent-unseen.mjs`: working fixtures include the live interrupt hint instead of relying on transcript text that may remain after a turn ends.
- `VERTA.md`: document the footer-only OpenCode phase contract so future changes do not reintroduce goal or transcript heuristics.

</details>

<details>
<summary><strong>2026-11-08</strong></summary>

**A document says more about itself than its words, and its pages are cut where the text ends**

- `src/modules/editor/DocxPreview.tsx`: a page's padding is not always additive. A block that was letting its own margins collapse through it stops doing so once it is given one, so the flow below it moves by less than the padding asks for: on a 780 block thesis the first page gap asked for 260px and pushed the rest of the document down by 239, and every page after it began a line short of its sheet. What each page actually gained is now measured, one page at a time from the top, and the padding is corrected by that much. Correcting all the pages from a single measurement instead does not settle: each correction moves every page below it, and on that thesis two rounds of it had three sheets of padding on one page.
- `src/modules/editor/lib/docxPages.ts`: `pagePaddingToward` states that correction on its own - where the page is drawn, where it has to be, and the padding it already has - so the rule that never asks for a negative padding is tested without a browser. (Gone again on 2026-11-09: a page holds its own blocks, so there is no padding left to correct.)
- `src-tauri/src/modules/docx.rs`: a text box is written twice by Word - once as DrawingML inside `mc:Choice` and once as VML inside `mc:Fallback`, for readers that predate the first - and both copies hold paragraphs. Both were read, so every text box in a document was drawn twice: a notes file of 20 boxes held 10 distinct texts, each drawn twice. A fallback is now left alone when the choice above it held something this reader draws; a part that states the fallback alone is still read, because skipping it would lose the text.
- `src-tauri/src/modules/docx.rs`: `w:shd` is read in all three places a document paints one - a run's own fill, a paragraph's line, and a table cell - plus the fill a whole table states, which every cell without one of its own shows. `auto` and white are the paper and are not a fill, and anything that is not six hex digits is dropped rather than guessed. Measured over the documents to hand: 218 paragraph fills in 2 files, 49 run fills in 3, 3 cell fills in 2 and 4 table fills in 3, so a shaded table header and a shaded passage were drawn as bare paper.
- `src/lib/native.ts`, `src/modules/editor/DocxPreview.tsx`: a table's rows are cells now - `{ runs, shade }` - rather than bare run lists, so a cell can say what it sits on. A run's fill is painted behind its text and a highlight is painted over that, because the marker is what is seen first.
- `src-tauri/src/modules/docx.rs`, `src/lib/native.ts`, `src/modules/editor/DocxPreview.tsx`: a run keeps three marks it used to drop - where it sits (`w:vertAlign`, so a superscript is raised and a subscript lowered, drawn smaller the way Word does it), whether it is struck through (`w:strike` and `w:dstrike`, with `w:val="0"` read as off), and what colour its highlight is (`w:highlight`, kept as the colour name Word writes, because the palette is Word's and painting it is the pane's business). 12056 raised or lowered runs are in the documents measured here, 309 struck-through ones and 132 highlighted ones. `w:caps` and `w:smallCaps` were measured too and are switched off in every place a document states them, so they are not read.
- `src-tauri/src/modules/docx.rs`: `w:strike` and `w:dstrike` are separate properties and are read as such. Word writes both on the same run, one on and one off, and folding them into one field let the switched-off one win: 106 struck runs of a real file came out as ordinary text. Either kind of strike is drawn as one line through the text.
- `src/modules/editor/DocxPreview.tsx`: what a run is drawn as is `runStyle`, a function of the run alone, so underline and a strike become one `text-decoration-line` instead of two declarations that would replace each other.
- `src-tauri/src/modules/docx.rs`: a comment says who wrote it. The part states the author in `w:author`, and reading past it left every comment unattributed - 371 comments across 8 authors in the documents measured here. A blank author is no author, which some writers produce. Footnotes and endnotes carry none: they are the document's own voice.
- `src/lib/native.ts`, `src/modules/editor/docxBlocks.ts`, `src/modules/editor/DocxPreview.tsx`: the author reaches the pane, which reads a comment as "Comment by A. Reviewer: ..." and leaves the attribution off when the file names nobody.
- `src-tauri/src/modules/docx.rs`: a picture written as VML (`v:imagedata`) is read as well as one written as DrawingML (`a:blip`). Word writes an embedded OLE object - an equation, a chart, a spreadsheet - with a picture preview, and that preview is VML; the reader only ever looked inside `w:drawing`, so those previews were invisible. The size comes from the `v:shape` style, in points or whatever unit it states. Such a picture has no drawing ordinal, because there is no `<w:drawing>` for a deletion or a move to address, so the pane draws it and offers neither.
- `src-tauri/src/modules/docx.rs`: comments and endnotes are read too, the same way footnotes are. A comment is the whole of `word/comments.xml` - the body holds only `w:commentReference`, and the span the comment applies to is marked by `w:commentRangeStart` and `w:commentRangeEnd`, which are not read: a file can hold a range with no reference, and reading those as well would draw one comment twice in nearly every file that has any. Every one is `Block::Note` and carries which of the three parts it came from. 15 of the documents measured here hold comments, 371 of them and 5710 characters, and none of that text was drawn before; the endnotes parts of the 62 that have one hold separators only, so nothing new appears for them.
- `src/lib/native.ts`, `src/modules/editor/docxBlocks.ts`, `src/modules/editor/DocxPreview.tsx`: a note says where it came from, so the pane can call it what it is - a footnote, an endnote or a comment - instead of every note being one word.
- `src-tauri/src/modules/docx.rs`: a footnote's text is read. The body only cites a note - `w:footnoteReference` names an id, and the words are in `word/footnotes.xml`, a part of its own - so the note appeared nowhere at all. Each note is drawn as a `Block::Note` right after the paragraph that cites it, and the separators a footnotes part also holds (the rule above the notes, marked by `w:type`) are not notes. A note is a block of its own rather than part of the paragraph's text because the pane writes one text per paragraph: folded in, it would have been saved into the body of the document.
- `src/lib/native.ts`, `src/modules/editor/docxBlocks.ts`, `src/modules/editor/docxBodyDom.ts`, `src/modules/editor/DocxPreview.tsx`: the note block on the drawing side. It is drawn read only, a rule and a lighter face under the paragraph that cites it, and it is left out of what the DOM is read back as and out of what the writer can address - like a table, it has no paragraph ordinal.
- `src-tauri/src/modules/docx.rs`: a table inside a table cell was skipped whole, and its text with it - one real file keeps 171 characters in a 2x2 table inside a cell. The model has no table for a table to sit inside, so the nested table's own rows and cells stay out of the outer table's structure, while its paragraphs are read into the cell it sits in, a space apart. Nothing is lost and the outer table keeps the rows and cells the file states.
- `src-tauri/src/modules/docx.rs`: a paragraph can open inside another, which is what a text box inside a run is. The outer paragraph was replaced by the inner one, so the paragraph a box was anchored in lost its own words. The outer one is now kept while the box's paragraphs are read, and the box's text is drawn after it, where the box is anchored. Paragraph ordinals - what the pane edits by - stay the document's own, so a box's anchor remains the (empty) line it is.
- `src-tauri/src/modules/docx.rs`: the walk that numbers paragraphs for writing had a single slot for "the paragraph being read", so a nested one took it and the outer paragraph's ordinal vanished: every edit after a text box was refused as out of range. It keeps a stack now, like the read.
- `src-tauri/src/modules/docx.rs`: an edit to a paragraph that is read from its `mc:Choice` copy is now written into the `mc:Fallback` copy as well, pairing the copies by position within the same `mc:AlternateContent`. Without it the file held two different texts for one box: the copy Word shows said one thing and the copy an older reader shows said another. The twin is only written when its bytes landed in the rewrite verbatim, so a paragraph that was deleted, or rewritten along with its parent, is left alone.
- `src-tauri/src/modules/docx.rs`: a paragraph with another one nested in it is emitted as the bytes it shares with its child, and the child is what the walk rewrites - so an edit to the paragraph's own words was silently dropped on save. Those edits are carried into the rewrite by where the bytes landed, and the paragraph's own tail after the last nested one is emptied with the rest, because the pane states one text per paragraph. This is what makes typing into the line a text box is anchored by reach the file at all.

</details>

<details>
<summary><strong>2026-11-07</strong></summary>

**A Word document is drawn as the page Word drew, and a .csv is a table that can be corrected**

- `src-tauri/src/modules/docx.rs`: the reader now brings back what the document looks like, not just what it says - a run's point size, colour and face; a paragraph's alignment, indents, spacing and the size its own line is drawn at; `word/styles.xml` resolved the way Word resolves it (`docDefaults`, then the `basedOn` chain root first, then the paragraph's own properties), without which a whole document is drawn at whatever fallback the pane happens to have; the default face out of `word/theme/theme1.xml`, because Word's default run names a theme font rather than a font; pictures (`r:embed` through the relationship table into `word/media/*`, handed over as `data:` URLs at the size `wp:extent` asks for, with per-image and total caps that skip rather than fail); and table cells as runs rather than strings, so a bold header comes out bold. The section's paper (`w:pgSz`, `w:pgMar`) is read too.
- `src/modules/editor/DocxPreview.tsx`: the body is drawn on that paper - a white sheet of the section's size with its margins as padding - and every block carries its own box (size, face, colour, alignment, indents, space before and after, line height), with the document's own ink rather than the app's foreground, which on white paper had drawn a whole page in near-white.
- `src/modules/editor/docxBodyDom.ts`: an empty paragraph is a line with a height, and the flattening now drops only the single `<br>` the browser puts at the end of a line instead of every empty line at the end - two Enters came back as none. A line that already ends in a `<br>` is not given a second one, which had put the caret between two of them and sent the next keystroke into a new paragraph.
- `src/modules/editor/DocxPreview.tsx`: no save banner over the document (a text file has none, and the banner pushed the page down when it appeared); the tab's dot says what is owed instead, from an `onDirtyChange` the pane reports; the write waits as long as `editorAutoSaveDelay` says, and with autosave off it waits for the pane to lose focus; a structural write re-reads for the paragraph numbering but leaves the page alone, so Enter no longer flashes and rebuilds the lines below it; a paragraph is deleted by where it is on the page, since the ordinal written into the DOM goes stale the moment a line is inserted.
- `src-tauri/src/modules/csv.rs` (new) and `csvPreview.test.ts`, `CsvPreview.tsx` (new): a `.csv` is read as a table - the delimiter decided by parsing the first line (counting characters calls a semicolon file comma-separated when its fields contain commas), RFC 4180 quoting with the commas, escaped quotes and newlines inside fields, CR / LF / CRLF all ending a record, GB18030 after UTF-8 for the exports Excel writes on a Chinese Windows, and a BOM that does not become part of the first field. The pane draws it with a sticky header, virtualized rows and widths measured from the content, and says which delimiter and how many rows it read.
- `src/modules/editor/CsvPreview.tsx`, `src-tauri/src/modules/csv.rs`: a cell is edited in place, and only that field's bytes are replaced - the file's quoting, line endings, other fields and the newline inside a quoted value all come back exactly as they were, which a re-serialization of the table would have quietly rewritten. A value is quoted only when it has to be, and a field already inside quotes keeps those quotes with its own doubled. The write is refused if the file changed since it was read.
- `src/modules/editor/EditorPane.tsx`: `.csv` / `.tsv` opens as the table, with the source one click away and the table falling back to it while the buffer is dirty; a `.csv` that is not UTF-8 reaches the table instead of the "binary file" screen, which is where every Chinese export had been going.
**A workbook is drawn as the grid it holds, and a deck as the slides it holds**
- `src-tauri/src/modules/office.rs` (new): what the three Office readers share - the package opened on its bytes with entry names matched however they were written, one part read under a ceiling with the container named in the message, a relationship target resolved against the folder of the part that named it, an attribute read by local name (and by its full name where one element carries both `id` and `r:id`), text decoded and unescaped with the character references the reader splits out resolved back, an `#rrggbb` colour from the three ways a package states one, and a picture's bytes as a `data:` URL.
- `src-tauri/src/modules/docx.rs`: the container readers are shared with the two new ones, so the inflated-size ceiling and its message live in one place.
- `src-tauri/src/modules/xlsx.rs` (new): a workbook read as a grid. `xl/workbook.xml` names the sheets and the sheet's own `r:id` finds its part, so a sheet is read where the relationship points rather than where its name suggests; `xl/sharedStrings.xml` for the text a cell only holds an index into, with the phonetic runs skipped and rich-text runs joined; `xl/styles.xml` for the font, fill, alignment and number format of a cell, resolved through `cellStyleXfs` when the cell style does not apply what it names (`applyFont="0"` means "as the named style says", which is how Excel writes the plain cells of a workbook), with the styles the sheet does not use left out; and the number format code applied here rather than in the frontend, covering the builtin table (fixed decimals, thousands, percent, scientific, the date and time shapes), custom codes with their literal text and locale blocks, and the two things that make a serial number a date (Excel's 1900 leap year, and whether a `m` is a month or a minute).
- `src/modules/editor/XlsxPreview.tsx` (new) and `src/modules/editor/lib/xlsxGrid.ts` (new): the sheet list is read on its own so its tabs can be drawn without reading a sheet, and one sheet is read when its tab is opened - a workbook of fifty sheets read whole is a payload of tens of megabytes for the one tab in view. The grid virtualizes both axes, draws the columns that state their own width, spans a merged region with its covered cells left out, and holds the frozen rows and columns in place while the rest scrolls. A cell is drawn in the theme's ink on the theme's surface: the workbook's own font colour and fill are read but not painted, and a row carries no hover fill, so nothing in the grid is highlighted but the value.
- `src-tauri/src/modules/pptx.rs` (new): a deck read as slides. `p:sldIdLst` gives the order (its `r:id`, not the `id` beside it), each slide's own relationship table finds its pictures, and a shape comes back as the box it was placed in (EMU to pixels at 96 dpi), its rotation, its fill and its paragraphs - with a run's weight, size, colour and face read off the `rPr` beside it, a list level as an indent, a bullet as its glyph, and a line break kept as a newline rather than lost when the next run opened. The slide master is not read, so a shape that inherits its place from a layout is drawn with what the slide itself declares.
- `src/modules/editor/PptxPreview.tsx` (new) and `src/modules/editor/lib/pptxLayout.ts` (new): each slide is drawn as a box of the size the file states, with its shapes placed where the file places them, so what is shown is the layout rather than a reflow of the text; a slide is white paper, so a run that names no colour is black ink rather than the pane's own foreground, which on a dark theme had drawn the text in a near-white grey; the tool bar carries the page number, a zoom, and a fit-to-width that follows the pane.
- `src/modules/editor/CsvPreview.tsx`: the same rule as the workbook's grid - a cell reads in the theme's ink, the header is the surface rather than a tinted band, a row carries no hover fill, and the cell being edited is ringed rather than filled. Two cells edited inside one round trip both reach the file now: the guard is the file's identity at the moment it was written, so two writes sent together both carried the identity the file had before either, and the second was refused as a file changed underneath. The writes are queued, each taking the identity the one before it brought back, and a cell shows what was typed as soon as it is typed rather than when the reply arrives.
- `src/modules/editor/lib/columnResize.ts` (new) and `src/modules/editor/lib/useColumnDrag.ts` (new): dragging a table's column edge, for the workbook and the `.csv`. A press within the grip of a column's trailing edge grabs it; the drag is tracked on the window, so a pointer that leaves the cell - or the pane - is still dragging until the button comes up; and the width is clamped so a stray drag cannot collapse a column or make a sheet unreadable. What changes is the view: nothing is written back, so a `.csv` keeps its bytes and a `.xlsx` keeps its own `<col>` elements, and a dragged width is gone on reopening.
- `src/modules/editor/XlsxPreview.tsx`, `src/modules/editor/CsvPreview.tsx`, `src/modules/editor/EditorPane.tsx`: the drag is wired into both tables.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: the types, calls and strings the new panes and the drag need, in both languages.
- `src/modules/editor/EditorPane.tsx`: `.xlsx` / `.xlsm` / `.pptx` go to their readers the way a `.docx` does, whatever the text reader makes of the file.
- `src/lib/native.ts`: the types and calls for the three readers above.
- `src/modules/i18n/messages.ts`: the strings the two new panes need, in both languages.
- `src-tauri/src/modules/pptx.rs`: a colour written inside the text body is not the shape's own fill. `<a:endParaRPr>` and `<a:defRPr>` live in there and carry the text's colour, and reading theirs as the background painted a whole text box in the colour of its own last paragraph mark: on one real deck that was a green block 957 by 461 pixels over a slide whose shape declares no fill at all. A colour is the shape's only when it sits in `spPr` outside the outline.
- `src/modules/editor/DocxPreview.tsx`: a page wider than the pane is drawn to fit it. A page taken from a wide original - a slide exported into a document, a landscape sheet - was drawn at its own 1700 pixels inside a centred row, so it overflowed both sides and its left edge could not be scrolled to at all. The scale is the pane's width over the page's, and it never goes above one: an A4 page at rest keeps the size the file gives it. It is applied as `zoom`, so the paper's width, margins and type come down together and the row centres what is actually drawn.
- `src-tauri/src/modules/pptx_color.rs` (new): a colour as a deck states it. A colour is either written out or named as a theme role, and a role is not a slot: `tx1` is what a master's `clrMap` says the text colour is, and the answer is usually `dk1`. Reading the role as a slot name found nothing, which is how a dark deck's body text came out black. The modifiers are lightness operations and are applied in HSL, so `lumMod 20000` is a fifth of the lightness rather than a fifth of the channel: `#4472c4` at `lumMod 20000` is `#0d1728`. `alpha` is transparency, which the pane does not draw, and `satMod` is left out rather than guessed at.
- `src-tauri/src/modules/pptx_theme.rs` (new): the theme's twelve slots and its font scheme, the roles a master maps onto them, and the levels of text style. A master's `p:txStyles` and a shape's own `a:lstStyle` are the same shape of data, so one reader serves both, and a narrower level fills in only what a wider one left unsaid.
- `src-tauri/src/modules/pptx.rs`: the chain a slide inherits along is read now, slide then layout then master then theme, with the master and its theme read once and shared by every slide that points at them. A shape that names no size takes its placeholder's level from the master, so a title is the 36pt bold the master states rather than the 18pt the pane had been drawing. The layout's own text styles are deliberately not read: a layout states them per placeholder shape, and taking its list wholesale put 60pt over ordinary text boxes that the master sets at 18pt.
- `src-tauri/src/modules/pptx.rs`: a colour with children is resolved when its own element closes, because its modifiers arrive before it does, and a colour written with none is resolved where it stands. A run's properties, a placeholder and a level wrapper are all written self closed in real decks, so they are read from the empty element arm as well as from the one that has children.
- `src/modules/editor/PptxPreview.tsx`: a slide is drawn on the colour it states, falling back to its layout's and then its master's, and on white paper when none of the three says anything. 426 of 3857 slides in the decks measured here state their own.
- `src/lib/native.ts`: the background a slide carries.
Measured across 118 real decks and 3857 slides: theme colours are 73 percent of every colour reference the reader had been ignoring, and every run now resolves one. A shape's own `lstStyle` turned out to be on 36.6 percent of shapes, so it is read rather than left for later.
- `src-tauri/src/modules/pptx_theme.rs`: the boxes a layout and a master give their placeholders, by the key a slide addresses them with, which is `idx` when a slide names one and `type` when it does not. A placeholder in a real deck often states no transform at all, and a shape with no box is drawn zero by zero at the origin, which is a shape nobody can see.
- `src-tauri/src/modules/pptx.rs`: a placeholder that states no box of its own is drawn in the layout's, and in the master's when the layout states none. A box the author moved is still its own. A placeholder that no level places stays where it was rather than being given a guess, because a guess would put text somewhere the file never asked for.
Measured on five real decks where the gap was worst: text shapes with a visible box went from 596 to 744, and slides that drew nothing at all went from 123 to 59. One deck of lecture slides went from 30 blank slides to none.
- `src-tauri/src/modules/xlsx_conditional.rs` (new): the rules a sheet states about its own cells. Four kinds are read, which is what the workbooks measured here use: a value that appears more than once, a value that appears once, a number compared with a constant, the cell's text against a needle, and a two or three colour scale. The colours come from the workbook's differential formats, which live apart from its cell styles, and every field such a format leaves out is left out here too rather than filled with a default that would repaint the cell.
- `src-tauri/src/modules/xlsx.rs`: a cell carries the style a rule paints beside its own, so the cell's formatting survives underneath. The rules are read only in a sheet that states one, and applied after the whole sheet is read, because a duplicate is only a duplicate relative to the other cells in the rule's own ranges.
- `src/modules/editor/XlsxPreview.tsx`: a cell a rule marks is drawn in the rule's colours. This is the one place the grid draws a colour the workbook states, and it is deliberate: what a rule states is not decoration but a statement about the value, which is the whole point of a sheet saying "these two journal names are the same".
Not read: data bars, icon sets, `expression`, `top10`, `aboveAverage`. Each is a different drawing rather than a different colour, and a guess at one would be worse than drawing the cell plainly.
Measured: of the 30 workbooks on this machine, 3 carry conditional rules and all of them are `duplicateValues`, so the rest of the kinds are read from the format rather than from a file that uses them. The two workbooks checked hold no duplicate in the ranges their rules cover, so the rules are dormant there; the drawing path is pinned by a workbook built in a test and read back, and by a cell carried through the running pane.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: the call and the strings for it.
- `src-tauri/src/modules/docx.rs`: a picture says which of the document part's drawings it is, counted from zero in the order the file writes them. Document wide rather than per paragraph, because a picture often sits in a table cell and a cell's paragraphs have no place among the block ordinals to hang a number on: 182 of the pictures in the documents measured here are in tables. It counts drawings rather than pictures that survived the size cap, and it counts them by byte offset rather than by how many were parsed, because a paragraph inside a nested table is not read at all and a parser's own counter would skip its picture and shift every number after it.
- `src-tauri/src/modules/docx.rs`: `fs_delete_docx_image` takes one picture out, named by that number, wherever it sits. Only the drawing is cut. Cutting the run instead would take with it any text the run holds beside the picture, so the run goes only when the picture was the only thing in it, which keeps a hollow element out of the user's paragraph. A picture number the part does not have is refused rather than rewritten against the wrong paragraph, and undo brings the picture back the way it brings back a deleted paragraph, by restoring the part that held it.
- `src/modules/editor/DocxPreview.tsx`: a picture carries a removal control that appears when the pointer is over it. It sits outside the editable surface, so the click cannot leave the caret inside the picture. It is offered for a picture anywhere on the page, a table cell included.
- `src-tauri/src/modules/docx.rs`: `fs_move_docx_image` puts one picture at the end of another paragraph. It travels as a run of its own, because a drawing is only valid inside one: a picture cut out of a run that also holds text arrives wrapped in a new run, and the word beside it stays where it was. Nothing else moves, and a move into the paragraph the picture is already in is not a write at all. The paragraph it leaves is found by byte range rather than by rewriting it, so a picture in a table cell can move into the body just as one in the body can move into a cell.
- `src/modules/editor/DocxPreview.tsx`: a picture can be dragged onto a paragraph, which is how Word does it and leaves the text alone. The drop names the paragraph by the same ordinal an edit names, and the pane reads the page again afterwards because the runs of two paragraphs are no longer what the DOM holds.
- `src-tauri/src/modules/pptx_theme.rs`: a `p:bg` may be a picture rather than a colour, and the reader used to answer nothing for those, so a slide drawn on a photograph came out as plain white paper. 38 of the 3857 slides measured here are, plus 5 layouts and 8 masters, and every media part behind them is under a megabyte.
- `src-tauri/src/modules/pptx.rs`: the three levels of paper now fall back together rather than one kind at a time. A slide drawn on a photograph has a paper, and reaching past it for the master's colour would have set both, drawing a colour behind a picture. The background picture comes out of the same byte budget as a shape's, because a hundred slides inheriting one master's photograph would otherwise be a hundred copies of it.
- `src-tauri/src/modules/pptx.rs`: the cache of what a slide inherits is now keyed by the layout it was built for. Caching "layout to master" and then answering from the master's entry gave every slide after the first of a layout the previous layout's placeholder boxes, and that is invisible until a deck has two layouts on one master: a title on the second layout took the first layout's title box. Reading a master is now its own function, so the two caches describe the parts they are named after.
- `src/modules/editor/PptxPreview.tsx`, `src/lib/native.ts`: a paper that is a picture is drawn covering the slide, the way PowerPoint draws it.
- `src-tauri/src/modules/pptx_theme.rs`: a `p:bg` may also be a gradient, and the colour reader used to answer one with its first stop, which turned a light two-stop paper into flat white. Stops are read as colours, so a stop named as a theme role keeps its `lumMod`, and the line is read as an angle. DrawingML counts that angle clockwise from pointing right and CSS from pointing up, so every angle is turned by a right angle on the way out; a gradient that names no line is drawn top to bottom. A gradient is no longer reported as a colour at all, so nothing paints one behind the other.
- `src-tauri/src/modules/pptx.rs`: the three kinds of paper are one value carried per level, so a level answers as a whole. They were three fields falling back one at a time, which set a colour behind a photograph and would have set two behind a gradient.
- `src/modules/editor/lib/pptxLayout.ts`: the value a slide is drawn on comes from one function, so which kind wins is testable without a browser.
- `src/modules/editor/lib/docxPages.ts`: where a document's pages end, as arithmetic over block extents. A page holds as many whole blocks as fit its text area and the next one begins at the block that did not fit, so a line is never cut in half. A block taller than a page (a paragraph the reader made that long, a table) fills one page on its own and overflows it, because splitting it would split a paragraph into two.
- `src/modules/editor/DocxPreview.tsx`: a long document is drawn as a stack of pages. The document stays one flowing column while it is being typed into, and the pages are cut a second after typing stops, so the caret is never inside a layout that is being rearranged. The gap between two pages is a `paddingTop` on the block that begins the page: a style, not a node, so paginating moves nothing the caret could be sitting on and the document reads back unchanged.
- `src/modules/editor/DocxPreview.tsx`: what holds its place while the pages are cut is the line the caret is on, not the block: a block can be a page tall, and watching it would pin its top a page away from the text being typed. With no caret in the body the block at the top of the view holds instead, and with neither, nothing is scrolled.
- `src/modules/editor/DocxPreview.tsx`: the sheets, their height and the page numbers are written through refs rather than rendered by React. A state change there would re-render the editable body, and the text inside it is the reader's until it is saved.
- `src/modules/editor/DocxPreview.tsx`: a rect is in the window's pixels and a scroll offset is in layout pixels, and the paper may be drawn shrunk on top of that. The extents and the scroll are converted with their own scales, and `overflow-anchor` is off on the pane: leaving the browser's own anchoring on corrected the scroll a second time and the page visibly jumped.
- `src/modules/editor/lib/docxPages.ts`: the padding each page is given is a whole number of pixels and the running total counts those whole pixels, not the exact ones. Carrying the fraction forward left every page slightly above its sheet, and a twenty page document ten pixels out by the end.
The paper is still one sheet in the sense that matters: one editable surface, so a selection, an undo and the caret all behave as they did before. True page boxes would mean one editable surface per page, and a caret crossing a boundary would have to be carried between two elements. That is a change to how the document is edited rather than how it is drawn, and it is not made here.

</details>

<details>
<summary><strong>2026-11-06</strong></summary>

**A Word document is one editable body, and the details card stops arriving**

- `src-tauri/src/modules/docx.rs`: a blank line is read as a paragraph of its own instead of being dropped, and a self-closing `<w:p/>` counts as one too - pressing Enter at the end of a document wrote a paragraph that the next read threw away, which left the caret nowhere to land; a `ListItem` now carries the numbering definition it asks for, so two adjacent lists can be told apart; writing text into a paragraph that has no `<w:t>` creates a run instead of refusing the whole save (a blank line, or a line holding only an image, is exactly where typing starts after Enter); `DocxInsert.after` is optional, so a new line can go in front of everything in a body whose first element is a table or which has no paragraphs at all; a save whose part is byte-identical to the one it read writes nothing and remembers nothing, and the same document part is never stacked twice - one Ctrl+Z after either used to take back nothing.
- `src/modules/editor/docxBlocks.ts` and its test (new): what the pane sends the writer, computed by aligning the lines on screen against the lines the file has - the identical ends are dropped, the middle is matched by longest common subsequence so a line keeps its own paragraph (and with it its style and numbering) while its neighbours are edited, and what is left over pairs up in order as a retype, so fixing a typo is one edit rather than a deletion plus an insertion. Also: what a block claims to be, what a block the browser created inherits from the line above it, and whether a write moved the numbering enough that the file has to be read again.
- `src/modules/editor/docxBodyDom.ts` (new): the DOM the browser leaves behind, flattened back into one paragraph per direct child - a bare `<div>` from Enter follows the kind of the line above it, a `<br>` or a nested block ends the line, and the caret is carried across the rebuild by text offset. List markers are a pseudo-element fed by a `data-marker` attribute assigned here, so a marker is never part of a paragraph's text and is never written to the file.
- `src/modules/editor/DocxPreview.tsx`: the whole body is one editable surface instead of one per paragraph - a caret cannot move between two editable elements, so cross-paragraph selection, Backspace joining two lines and deleting several lines at once were impossible by construction. Enter, Backspace, the selection and the input method belong to the browser now; only paste is intercepted (as plain text, split into lines); every edit is aligned against the baseline and written 600ms after typing stops, or at once when the numbering moved; the baseline is updated by what was written, so a save never re-sends lines the file already has. `groupBlocks`, `isEditableBlock`, `pendingEdits` and the per-paragraph `EditableText` are gone.
- `src/modules/editor/docxPreview.test.ts`: the list grouping and per-paragraph editing cases are gone with the code they pinned; what remains pins the routing, the save guard, the single editable surface, paste being the only key taken over, and the DOM being normalised after each edit.
- `src/modules/editor/EditorPane.tsx`, `src/lib/native.ts`: `DocxInsert.after` is `number | null`, and the parsed list item carries `numId`.
- `src-tauri/src/modules/docx.rs`: an insert with `after: null` ("in front of everything") now goes in front of the body's first paragraph rather than the first paragraph of the part - a paragraph inside a table is one too, so a body beginning with a table had the new line written into its first cell, carrying the cell's own paragraph properties. The reader tracks table depth to tell the two apart.
- `src/modules/editor/docxBlocks.ts`: text is compared with a real no-break space and a space taken as one character. A paragraph the file wrote with `U+00A0` read back as a space in the pane, so it never compared equal, and every save re-sent it and rewrote its spacing although it had not been touched.
- `src/modules/editor/DocxPreview.tsx`: a list item is drawn one step in per its level (`data-level`, `padding-left`), which the read already had and the pane was throwing away - a nested item sat at its parent's margin. The level is drawn from the read and never sent back; the writer keeps each paragraph's own properties.
- `src/modules/editor/docxBlocks.ts`: `adoptDraft(before, draft)` builds the baseline after a write, filtering the read the same way the draft is filtered. Copying ordinals across the unfiltered read shifted every paragraph after a table onto its neighbour - the pane then named the wrong paragraph, or, once the typed-in paragraph had no ordinal, named none at all and said 已保存 while the file had not moved.
- `src-tauri/src/modules/docx.rs`: `find_text_node()` matches a `<w:t>` text node rather than the `<w:t` prefix, which `<w:tabs>`, `<w:tab/>` and `<w:tc>` also start with. `<w:tabs>` failed the whole save (its `>` was read as the end of a text node, and no `</w:t>` followed), and `<w:tab/>` was rewritten into an empty text node, emptying the run after it - the tab and the rest of the line disappeared from the file.
- `src/modules/editor/DocxPreview.tsx`: an input method's composition is left alone (`isComposing`) instead of having the selection re-installed on every composition update, `normalizeBody` reports whether it changed anything so an untouched caret stays put, a paste with no plain text in it (an image, a table from a page) is no longer swallowed by `preventDefault`, and typing that lands while a structural save is in flight is written before the re-read replaces the body.
- `src/modules/editor/docxBodyDom.ts` (new, continued): the caret cannot simply be put at the start of a block - the block's first child is the delete affordance, which is `contenteditable=false`, so a range in front of it is canonicalised by the browser to the end of the line above, and an empty line has no text node to sit in at all. Typing after Enter therefore landed in the previous paragraph. The caret is now placed in the block's own text (skipping anything inside `contenteditable=false`), and an empty line gets a `<br>` last in it with the caret in front of that.
- `src/styles/globals.css`: `.verta-docx-marker::before` draws a list marker from `data-marker`; `.verta-compact-card` no longer fades in and its move transition is the only one left.
- `src/modules/launcher/components/CompactSessionCard.tsx`: the transition is switched on one frame after the first placement rather than in the same commit. Applied together, the browser interpolated `transform: none` into the placement and the card flew in from the window's corner; now it appears where the row is and only a move to another row animates.
- `src/styles/motionBudget.test.ts`, `src/modules/launcher/components/sessionRowDensity.test.ts`: the card's base rule has no hidden opacity and no opacity transition, and the placement-to-transition frame is pinned.
- `src-tauri/src/modules/agent_versions.rs`: an upgrade is allowed five minutes instead of a hundred seconds, and a timeout now names the command it ran. An npm install naming two plugins took 37s on a warm cache and over a minute cold, so the hundred-second limit killed installs that were still working and reported them as a failure - "老是升级失败" from the outside. Every upgrade attempt is logged with its command, and a refusal or a timeout with its output, to `Verta.log`.

</details>

<details>
<summary><strong>2026-11-05</strong></summary>

**A compact session's details are one card that travels down the list**

- `src/modules/launcher/components/CompactSessionCard.tsx` (new): the details of a compact row - title, numbers, directory - drawn as **one** card for the whole list, positioned with a `transform` and anchored to whichever row the pointer is on. Following the rows is therefore that transform changing: the eye tracks one panel along the list instead of watching a panel per row appear and disappear. This is the part of the edge-dock reference that survives a single webview - its bubble is one native window moved by a spring, and this is one element moved by a transition. The card is measured before it is shown and its first placement is not animated, so it is never seen at the window's corner; its text is keyed by session and fades in when the row changes, so the details are replaced while the card keeps moving.
- `src/modules/launcher/lib/compactCardPosition.ts` (new) and its test: where the card sits for a row - the row's right side, the left when the card would run past the edge, clamped inside the window both ways, and following the row down by exactly one row. The width it is given comes from the card's own content, so a longer directory flips sides sooner; the card is as wide as its text asks for under a 19rem cap, rather than a fixed width that either crammed a long path or floated in empty space beside a short title - and rather than a minimum width, which is what bound it in practice (the content wanted 170px and a 13rem floor drew 208px).
- `src/modules/launcher/components/SessionList.tsx`: the list owns the one card and hands it the hovered (or focused) row's position; a row no longer carries a tooltip of its own, and the row the card describes carries `aria-describedby`. The anchor is recomputed on scroll and resize, because a stationary pointer and a scrolling list move the row.
- `src/styles/globals.css`: `.verta-compact-card` moves on `transform` at `--dur-base`/`--ease-soft` and fades at `--dur-fast`, from the window's own motion tokens; `data-ready` (set with the first placement) is what keeps that first appearance unanimated, and `.verta-compact-card-body` fades the swapped text in. Only transform and opacity are involved, and nothing declares `will-change`. Under reduced motion the card arrives where the row is and its text does not fade.
- `src/styles/motionBudget.test.ts`, `src/modules/launcher/components/sessionRowDensity.test.ts`: the card's transition lengths as relations to those tokens, the body fading without moving, and the shape that makes it move - one card for the list, anchored, positioned by its transform, non-interactive, in the window's own surface.
- `src/styles/globals.css`: floating layers are no longer paused while the window is unfocused. Entering from `opacity: 0` is what a one-shot entrance does, so a paused one is an empty layer rather than a cheaper one - measured with the window unfocused, hovering a compact row drew the details card with no text in it at all (the body's fade sat paused on its first frame). Every tooltip in the window had the same hole, a tooltip being something hover opens without the focus being asked for. These entrances run once for 160-320ms; the animations that repeat forever are the state indicators and keep their own rules.
- `scripts/dev/probes/compact-card-roam.mjs` (new): hovers two rows in turn and requires the **same** element to come back with a different transform, a changed body and the described-by row following it; a per-row tooltip fails this by being a new element every time.

**The rendered document shows a scrollbar, and the git panel's panes are its own**

- `src/styles/globals.css`: new `.verta-doc-scroll`, the thin native bar the code editor already had and the rendered document did not. The shell hides scrollbars everywhere, so a long document looked exactly like a short one until the reader tried to scroll; this region gets the bar back with the gutter reserved, so a document that grows past the pane does not shift its own text sideways the moment it starts to scroll.
- `src/modules/markdown/MarkdownPreviewPane.tsx`, `src/modules/editor/SidePreview.tsx`: the two containers that scroll a rendered document wear it. The side preview's scrubbing markers move off the edge, which is now the bar's: measured at 10px in this webview, they sat 8px in and rode its last two pixels.
- `src/modules/markdown/markdownScroll.test.ts` (new): the class is on the element that scrolls rather than on a wrapper, the rule behind it exists, and the shell's bars stay hidden by default - dropping either half brings the bug back.
- `scripts/dev/probes/markdown-scrollbar.mjs` (new): measures the bar the two ways it can be absent - the computed `scrollbar-width` and the layout gutter the bar occupies - with the class and without it (10px of layout against none). A hidden bar scrolls just as well, so the gutter is what tells a drawn bar from a working but invisible scroll.

**The git panel's working tree is two panes, and staging is one of its three actions**

- `src/modules/source-control/panes.ts` (new) and its test: which files a pane lists, which of the ticked paths it is showing, whether every row in it is ticked, what the header's checkbox does to that set, and which way the pane's action goes. A file edited on both sides belongs to both panes, which is what the merged list could only express as a third checkbox state.
- `src/modules/source-control/SourceControlPanel.tsx`: the action row is 暂存 / 提交 / 推送. Below it the list splits into 更改 and 暂存 with a count each, and a row's checkbox is a **selection**: ticking it changes nothing on disk - the button above is what acts, staging the ticked files in the changes pane and unstaging them in the staged pane, where its label follows the pane and the file goes back to the working tree with its edits intact. The list header's "all" ticks every row of the pane and no more. Discarding is offered only where there is a working-tree edit to lose, and a pane with nothing in it says so instead of drawing the other pane's files.
- `src/modules/source-control/useSourceControlPanel.ts`: `setFilesStaged(paths, staged)` - the button acts on the set of ticked files, and the context menu's per-file toggle comes through it. The header checkbox no longer drives a mutation, so `headerCheckState`, `toggleAll` and the two all-or-nothing mutations they fed are gone.
- `src/modules/source-control/useSourceControlPanel.ts`: the two empty-state strings were hardcoded English with no consumer; they are message keys now and the empty panes say them.
- `src/app/App.tsx`: the right panel's wrapper is a column. The stash strip is a sibling of the panel, and with a block wrapper the panel took the whole box while the stash was laid out past its bottom edge and cut off by the pane's own `overflow: hidden` - it was drawn nowhere, which is what the new probe now measures.
- `src/modules/i18n/messages.ts`: the pane names, the staging progress label, the unstage-file label, the nothing-to-stage reason and the two empty states.
- `scripts/dev/probes/scm-two-panes.mjs` (new): each pane's count and rows against `git status`, the action's label and its ticked count, the empty pane's note, and the stash strip hit-testable inside the window. The selection rule is checked the only way that proves it - ticking a row and then the header's "all" has to leave `git status` byte for byte as it was - which is also why this probe never presses the button: it reads the repository rather than staging in it.

**An HTML file can be looked at as a page**

- `src/modules/editor/EditorPane.tsx`: `.html` and `.htm` open with a 渲染 stop beside 源码. It hands the browser the file itself over the asset protocol in a sandboxed frame - the route the PDF stop already uses, so no new dependency and no CSP change - and the frame replaces the source while it is up because what it shows is the file on disk, which is also why the stop is unavailable while the buffer has unsaved edits. The sandbox grants scripts and same-origin and stops short of top navigation: with that, a page could navigate the Tauri window itself and hand `window.__TAURI__` to an origin of its choosing.
- `src/modules/editor/htmlPreviewUrl.ts` (new) and its test: the frame's URL, built segment by segment instead of with `convertFileSrc`. That function percent-encodes a whole path as one URL segment, which is right for an `<img>` or a PDF frame and wrong for a document: a browser resolves `./style.css` by replacing the last segment, and with one segment there is no directory left to resolve against, so every relative reference collapses to `http://asset.localhost/style.css` - measured on a two-sheet page, that URL loaded both sheets with zero rules and drew the page as unstyled text, while this one loads both and a `../` reference with them. The asset handler decodes everything after the leading `/` and opens the result as a path, so the leading separators are encoded too (`/home/me` must not arrive as `home/me`) and that encoded root is followed by a real separator, so a `..` in the page cannot pop the root off the URL and leave a relative path behind.
- `src/modules/editor/htmlPreview.test.ts` (new): the frame is pointed at the asset protocol, carries the sandbox the browser preview uses, never carries `allow-top-navigation`, and is the true branch of "clean buffer and rendered selected".
- `scripts/dev/probes/html-preview.mjs` (new): renders a fixture page and reads it from inside the frame - its text, a colour its own stylesheet sets, a global its own script sets - and records what the page's script reaches when it calls the IPC. The frame is a different origin *and* a different process in this webview, so the page answers over `postMessage` with its own reading of itself rather than the parent reaching in.

**A Word document is read rather than called a binary file**

- `src-tauri/src/modules/docx.rs` (new): a `.docx` is a ZIP holding `word/document.xml`, and this reads the paragraphs, headings, emphasis, lists and tables out of it. It reads Word's own shapes: most properties are self-closing (`<w:pStyle w:val="Heading2"/>`, `<w:ilvl/>`, `<w:numId/>`, `<w:b/>`), so they are read from empty elements as well as from start tags - reading them only from start tags left every heading a plain paragraph and every list flat and unnumbered. Numbered lists are told from bulleted ones by `word/numbering.xml` when it is there, and read as bullets when it is not. A nested table is skipped rather than taken for rows of its parent, deletion marks are dropped while insertions are kept, and a part cut off in the middle is an error: `quick-xml` checks end *names*, and nothing tells it a document ended early. Both parts are read with ceilings of their own, because a ZIP's declared size is not the size it expands to.
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`: `zip` without its default features, which would add zopfli, zlib-rs and four more codecs a document does not use, plus `quick-xml`; `flate2` is named directly because zip declares it with `default-features = false` and Deflate entries need a decompressor that is actually on. All three were already in the tree: the lock gains three edges and no package.
- `src/lib/native.ts`: `readDocx`, and the shape it returns - paragraphs with their heading, their list and their styled runs, and tables.
- `src/modules/editor/DocxPreview.tsx` (new): the blocks drawn as elements - no HTML passthrough, so nothing in the document can inject anything into the window - numbered as they are drawn so each has a stable key, with the same scroll bar the rendered Markdown wears, a note when the document was longer than the block ceiling, and its own message when the archive could not be read. Images, text boxes and footnotes are not carried by the reader and are not drawn.
- `src/modules/editor/EditorPane.tsx`: `.docx` goes to the reader instead of the binary-file notice, and `.doc` - OLE2 rather than ZIP, which no reader here understands - says it needs Word, or a save as `.docx`.
- `src/modules/i18n/messages.ts`: the loading, failed, empty, truncated and old-format lines.
- `src/modules/editor/docxPreview.test.ts` (new): consecutive list items become one list, anything else ends it, what it numbers is stable, and the editor's routing, the document's own scroll class and the cancelled read.
- `scripts/dev/probes/docx-preview.mjs` (new): builds a real archive with `Compress-Archive` - so the entries are spelled the way PowerShell spells them, which is part of what the reader has to tolerate - and requires the document to be drawn as a document (heading, bold run, numbered list, 2×2 table, `&amp;` as `&`), and a file that is not an archive to say so rather than draw nothing.
- `src-tauri/src/modules/docx.rs`: a `.docx` is now editable in place, and the file on disk is the document. The reader gives every paragraph the ordinal of its `<w:p>` element - counting the ones inside tables and the ones that draw nothing, because the writer addresses paragraphs by that number - and reports whether the document can be written back at all (a read cut off at the block ceiling may not: saving from it would drop what follows). It also reports the file's identity (size and modification time), which the writer checks before replacing it.
- `src-tauri/src/modules/docx.rs`: `fs_write_docx` can also add a paragraph after a given one, which is what Enter does: the new `<w:p>` is written directly after its neighbour and copies that neighbour's properties, so a new line under a heading is another heading and one under a list item continues the list - while an empty line is a paragraph with no run at all.
- `src-tauri/src/modules/docx.rs`: `fs_write_docx` rewrites the document part by slicing the original bytes: the text nodes of an edited paragraph are replaced (the new text into the first, the rest emptied) and a deleted paragraph's element is dropped, while everything else in the part is copied out exactly as Word wrote it - no re-serialization, so namespace prefixes, attributes and elements this reader does not understand survive. The archive is rebuilt with every other entry copied verbatim (its own compression included) into a temporary file that is then renamed over the original, so a crash mid-write leaves the document intact. Edited text is escaped and keeps its edge spaces via `xml:space="preserve"`; a paragraph with no text node (an image, a field) is refused rather than turned into an empty run.
- `src/lib/native.ts`: `writeDocx`, and the guard on `DocxDocument`.
- `src-tauri/src/modules/docx.rs`: Ctrl+Z in a `.docx` takes back the last change by restoring the document part that was there before it. That is the only way to bring a deleted paragraph back whole - its XML is not in the model any more, so nothing the pane could re-send would recreate its properties and runs. The last twenty parts per file are kept in memory, which is enough for a working session; a step is one save, and a save happens when typing stops.
- `src/modules/editor/DocxPreview.tsx`, `src/modules/editor/EditorPane.tsx`: Ctrl+Z in a `.docx` is split by what there is to undo. Typing that has not been written yet is dropped by reading the file again - the pane keeps no history of its own, and the file is the last state the user can see. Once everything is on disk, the last change is taken back out of the file and the pane reads it again. No redo.

  It travels through the shell's own undo command rather than a listener in the pane: `useGlobalShortcuts` matches `Mod+Z` in the capture phase and calls `stopImmediatePropagation`, so a keydown handler inside the pane never hears the key at all - an earlier version had one and it was unreachable. `EditorPane`'s handle now asks the document pane first and falls through to CodeMirror only when the pane is not a document.
- `src/modules/editor/EditorPane.tsx`: `Mod+S` no longer writes over a file the text reader did not load as text. Nothing fills the buffer for a `.docx` (or an image, a PDF), so saving that empty buffer emptied the file; the document pane saves its own paragraphs, and there is nothing else to save.
- `src/modules/editor/DocxPreview.tsx`: Enter splits the paragraph at the caret - what came before stays, what came after becomes the next paragraph - and Shift+Enter is left to the browser. A split or a deletion renumbers every paragraph after it, so the pane reads the file again instead of renumbering its own copy: typing into a model whose numbering has moved on is how an edit lands on the wrong paragraph (which is what a deletion did before this). A pure text edit does not re-read, so the caret stays where it is, and after a split the caret is put at the start of the new paragraph.
- `src/modules/editor/DocxPreview.tsx`: paragraphs, headings and list items are editable where they are drawn; the text goes into the paragraph's first run, so a paragraph edited here loses emphasis inside it while every untouched paragraph keeps exactly what Word wrote. Typing is written back about 600ms after it stops - the whole document each time, so a lost request cannot leave half an edit - with a small `正在保存…` / `已保存` line. A hover `×` deletes a paragraph. If the file changed on disk (saved in Word in between), the write is refused and the pane stops and asks for a re-read instead of overwriting it. Tables, images and a truncated read are read-only, and the pane says why.
- `src/modules/i18n/messages.ts`: the saving, saved, failure, conflict, reopen, retry, delete-paragraph and read-only lines.
- `src/modules/editor/docxPreview.test.ts`: the pending edits in document order, a paragraph that is both typed in and deleted, which blocks can be edited, and a list item numbered by the paragraph it came from rather than by its place in the list.
- `scripts/dev/probes/docx-edit.mjs` (new): edits a real archive through the pane, waits for the save, and then reads the file back out of the archive - the new text present, the deleted paragraph gone, and a part nobody touched byte-for-byte what it was. A second document is split with a real Enter keypress at a caret placed mid-paragraph, and its part is compared against the two paragraphs that should have come out. Then Ctrl+Z is pressed for real on both documents, and each part has to come back byte-for-byte as it was before the change.

**The bell's one-click update, and a refused check that says why**

- `src/modules/notifications/lib/useAgentVersions.ts`: `batchIds` - the rows a one-click run covers, which is the set the list is showing, because every one of them has its own button on screen. It used to be only the rows *known* to be behind, and that is what made the button disappear in the case that needed it: one behind row plus one row whose check was refused (an `HTTP 403 Forbidden` from GitHub's anonymous quota) left the count at 1 and no batch action at all - reported as "缺少一键更新按钮". `updateReason` reads a refused check's status: 403 and 429 are the quota running out, any other status is itself, and a request that never arrived has none.
- `src/modules/notifications/NotificationBell.tsx`: the batch button appears whenever the list holds more than one row, and says what it does (`一键更新（N）`) rather than being an unlabelled icon in the section heading. The bell's own badge still counts the rows *known* to be behind, so it does not shout about a check that was never made. A refused row says the reason in the row (`被限流（403）`, `查询失败（500）`) instead of "未知", with the full text still on hover.
- `src/modules/i18n/messages.ts`: the button's label and the two reason lines.
- `src-tauri/src/modules/agent_versions.rs`: a refusal is reported as what it is - `http_failure` names the source, keeps the status, and for 403 and 429 says that it is usually the anonymous quota, and what turns it off.
- `src-tauri/src/modules/github/mod.rs`, `src-tauri/src/modules/agent_versions.rs`: the GitHub reads go through the logged-in `gh` first (`gh api … -H Accept: application/vnd.github.raw`), which spends the account's own quota instead of the shared sixty an hour, and fall back to the anonymous read when gh is missing, logged out or refusing.
- `src-tauri/src/modules/agent_versions.rs`: one `npm install` pins the plugins it was not asked about. Naming every plugin `@latest` is what produced "回退一个小版本然后重试": a click about one row re-resolved all of them, and a plugin installed from a git branch (7.0.1, newer than the registry) came back at the registry's 6.3.0. The clicked plugin is asked for its newest; a git plugin keeps its own spec, because its installed version is not on the registry to pin to and npm would fail the whole install over it; and a plugin whose installed version cannot be read keeps `@latest`.
- `src/modules/notifications/lib/useAgentVersions.test.ts`: the batch set with an unreadable row in it, and what each kind of refusal reads as.
- `scripts/dev/probes/agent-bell-update-all.mjs` (new): opens the bell and requires the batch button whenever more than one row is listed - present, enabled and labelled - and a rate-limited row to say so in the row itself. It presses nothing: that button runs the machine's own updaters.
- `src-tauri/src/modules/agent_versions.rs`: a batch click is one command, not one per row. `plan_batch` splits the ids into the plugins (which share a single `npm install`, because they are one npm project) and the rest (which are separate programs and still run in turn), and `agent_versions_upgrade_many` runs that plan, reporting one outcome per id. Two plugin rows used to be two installs, each pinning the other to where it was and each re-reading every registry afterwards - measured on this machine, updating two plugins took two `npm install` runs for one project.
- `src-tauri/src/modules/agent_versions.rs`: when the group install fails, each plugin is retried on its own before the outcome is reported. One install is atomic, so a single member it cannot install (a plugin installed from a git branch on a network that cannot reach the repository) would otherwise report the rows beside it as failed too - and say nothing true about them.
- `src/modules/notifications/lib/useAgentVersions.ts`: `upgradeAll` is one call and one check, not one of each per row; every row in the batch spins at once, because one install covers them all. Failures come back as one line (`batchFailureNotice`): every name, and only the first detail, collapsed - npm's failure is a dozen lines and would push the popover off the window. A row whose command answered but which is still behind counts as a failure, as it does for a single row.
- `src/modules/notifications/NotificationBell.tsx`: while a batch runs the section says what it is doing ("正在更新 superpowers…（网络慢时会等一会儿）"), and the row's spinner carries the same hint on hover. The wait is the network's: a plugin installed from git is cloned, and a slow link left the row spinning for twenty seconds with nothing said.
- `src/modules/i18n/messages.ts`: the in-flight line, its per-row hint, and the batch failure line.

</details>

<details>
<summary><strong>2026-11-04</strong></summary>

**The right panel's repository belongs to the session that picked it, and three floating layers stop being see-through**

- `src/modules/source-control/repositoryTarget.ts`, `src/app/App.tsx`: the repository the right panel is showing is remembered per session tab within a folder, not per folder - two sessions opened at one folder pinned the same sub-repository, so switching it in one switched it in the other. Picking a repository is a choice about what this session is looking at, and a folder holding several checkouts is exactly where two sessions differ. The scope still names its environment first, which is what a resolved answer is checked against.
- `src/modules/notifications/lib/useAgentVersions.ts`: opening the bell clears the last upgrade's confirmation line. The popover checks again every time it opens, and that check now also drops "updated to X": the green line belonged to the visit that produced it, and without this it stayed until the app restarted.
- `src/modules/projects/ProjectsView.tsx`: a local project row keeps one menu. The right-click copy of the ⋯ menu carried the same rows and the two read as duplicates; the panel's remote list offers its actions from ⋯ alone, so that is the one that stays.
- `src/styles/globals.css`: `verta-float-mask`, the pane tint floored at 88% instead of following the theme's pane opacity all the way down, so a floating layer with text of its own is never read through the window. Alpha rather than a blur, per the compositing budget.
- `src/components/ui/context-menu.tsx`, `src/components/ui/select.tsx`, `src/modules/launcher/components/SessionList.tsx`: the file list's right-click menu, settings' choice list and a compact session's details carry that mask.
- `src/modules/i18n/messages.ts`: the agent-state labels read as names rather than as sentences, since the colour legend in settings and the state dot's tooltip are where they are read: "运行中", "等待输入", "刚结束", "后台运行，无标签页", "后台任务运行中" ("Working", "Waiting for input", "Just finished", "Running in the background, no tab", "Background tasks still running").
- `src/modules/i18n/messages.ts`: the settings descriptions are written in written Chinese rather than spoken: lines that addressed the reader ("你不在", "还是没找到", "不要过渡"), colloquial verbs ("关掉", "停上去", "兜底", "收进托盘", "手输"), and clauses stacked with commas are now declarative sentences with the same meaning, no setting lost.
- `scripts/dev/probes/project-row-menu.mjs` (new): a right-click on a local project row opens no menu, ⋯ opens exactly one, and its rows are the ones the row's actions name.
- `scripts/dev/probes/float-mask.mjs` (new): the three masked layers are measured at the alpha the engine computed - the popover colour at 88%, not a blur - with a reading that could not happen failing the probe rather than passing it silently.

**Tabs survive a close: a launch restores the list the last window left behind, and a session tab reopens its session**

- `src/modules/settings/store.ts`: new `restoreTabsOnLaunch` preference, on by default, with `setRestoreTabsOnLaunch`.
- `src/settings/sections/GeneralSection.tsx`: the switch, in a new Startup group.
- `src/modules/i18n/messages.ts`: the group label and the switch's title and description.
- `src/modules/settings/store.ts`: `restoreTabsOnLaunch` defaults to off - a launch is one terminal unless the switch is turned on, and a value the user has stored wins over the default.
- `src/modules/i18n/messages.ts`: the switch's description states both positions, and that a session tab resumes its session.
- `src/modules/i18n/messages.ts`: the switch's description is one sentence - it restores every tab that was open at close - the parenthetical about a session written from two places is gone.
- `src/settings/sections/GeneralSection.tsx`, `src/modules/settings/store.ts`, `src/modules/i18n/messages.ts`, `src/modules/tabs/lib/useTabRestore.ts`, `src/app/App.tsx`: the workspace-environment choice is removed - its setting row, its preference and setter, its message keys and the two reads that seeded a new space from it. A space and a new terminal always start on this machine; a WSL distro is reached from a session row or the terminal list in the plus menu, each of which names the distro.
- `src/modules/launcher/components/LauncherPanel.tsx`: the source heading ("this machine" / each distro) is drawn only when there is more than one source, so grouping by agent or by project no longer opens with a "this machine" line over a list that is entirely on this machine.
- `src/modules/tabs/lib/bootTabRestore.test.ts`: the switch starts off.
- `scripts/dev/probes/tab-restore.mjs`: turns the switch on itself (the default is off) and puts the original value back; a third stage checks the launch the default promises, one cold terminal.
- `src/modules/tabs/lib/tabStorage.ts`: the read side of `verta-tabs.json` is back (`loadTabState`); the write side never left.
- `src/modules/tabs/lib/serialize.ts`: `hydrateTabs` is back: terminal trees with each leaf's cwd / env / shell, editor / preview / markdown tabs, a cwd that cannot name a directory in its env is dropped but still names the tab, corrupted entries skipped. A tab that stored a session comes back marked `pendingResume`, which is never serialized.
- `src/modules/tabs/lib/useTabRestore.ts`: boot reads the saved list when the switch is on, adopts the environment the restored active tab was in, authorizes every restored cwd up front, and swaps the list in; with the switch off, or nothing saved, the launch is the cold tab in the default environment as before.
- `src/modules/tabs/lib/useTabs.ts`: `TerminalTab` gains the transient `pendingResume`, and `clearResumeIntent` drops it - and the session id with it, when the resume was refused.
- `src/modules/launcher/lib/openSession.ts`: `planSessionResume` builds the same plan a session row builds, from what a restored tab carried (`agent`, `sessionId`, the active leaf's cwd and env); `null` when the pieces do not fit.
- `src/app/App.tsx`: a restored session tab resumes on its first activation, running the same sequence a click on the session row runs (the opening cover, the resume command, the wait for the agent's UI before the cover lifts) and asking the folder for its repositories the same way, so the source-control panel is placed there too. A session that cannot be rebuilt comes back as the plain terminal the tab still is, and the session list stops pointing at it.
- `src/modules/tabs/lib/bootTabRestore.test.ts` (new): the restore is the preference's to gate, the fresh path is what remains with it off, and preferences / boot marking / persistence survive both ways.
- `src/modules/tabs/lib/serialize.test.ts` (new): the round trip, the resume marker and its absence from the written file, the dropped cwd, split trees, editor / preview / markdown, corrupted entries.
- `src/modules/launcher/lib/openSession.test.ts`: `planSessionResume`'s local, distro and illegal-id cases.
- `scripts/dev/probes/tab-restore.mjs` (new): `--stage=setup` builds the scene (a scratch terminal tab, a throwaway pi session opened by a row click) and quits the app; `--stage=check` runs against the relaunched window and requires the saved tabs on screen and a judge state on the session row, which only happens when the session's UI is live.

**The update check reaches git-installed packages and opencode's plugins**

- `src-tauri/src/modules/agent_versions.rs`: pi's `git:` packages from its settings file are listed as rows, each read from the checkout's own `.git` (a loose ref, a packed ref, or a commit) and compared against the commit the remote is on now - a GitHub source through the host's API, any other host through `git ls-remote HEAD`.
- `src-tauri/src/modules/agent_versions.rs`: opencode's plugins, from the dependencies of `~/.config/opencode/package.json` with the plugin API itself excluded, each compared against the npm registry or, for a `github:` spec, against the version in that repository's `package.json` read through GitHub's API.
- `src-tauri/src/modules/agent_versions.rs`: every read goes out through the system's proxy and is retried without it when the request could not be sent at all; the reads carry a user agent (GitHub's API answers 403 without one) and the connect timeout is 4 s.
- `src-tauri/src/modules/agent_versions.rs`: `AgentComponent` carries `agent` (`opencode` / `pi`) and `compare` (`version` / `revision`); the rows of each family are assembled by one function, so the branch with no HTTP client lists the same ids with an error in place of the remote's answer. `git ls-remote` runs with `GIT_TERMINAL_PROMPT` cleared.
- `src-tauri/src/modules/agent_versions.rs`: the colour escapes a tool writes through a pipe are removed before a version is read (`opencode --version` answers `ESC[2mvESC[0mESC[1m2.2.5ESC[0m`).
- `src-tauri/src/modules/agent_versions.rs`: the new rows are upgraded by `pi update git:<source>` for a pi git package, and by one `npm install --prefix <config dir>` naming every opencode plugin at its newest for the opencode ones - opencode's own `plugin update` answers without looking at a plugin configured as a path, and installing them one at a time lets npm put another back at the commit its lock file still names. The commands are resolved from the configuration the row came from, never the caller's text. New ids `pi-git:<source>` and `opencode-plugin:<package>`.
- `src/modules/notifications/lib/useAgentVersions.ts`: a row that is still behind after its command says so, instead of "updated to <the old version>"; a batch counts what updated.
- `src/modules/notifications/lib/useAgentVersions.ts`: `AgentComponent` gains `agent`; `hasUpdate` reads a `revision` row by difference and a version row part by part; `upgradable` and `updateRows` pass each row's `compare`.
- `src/modules/notifications/NotificationBell.tsx`: each row in the updates section is drawn with its tool's own icon beside the library name.
- `src/modules/notifications/NotificationBell.tsx`: an "update all" button in the section's heading, drawn only while more than one row has something newer.
- `src/modules/notifications/lib/useAgentVersions.ts`: `upgradeAll` runs every row that has something newer one after another, and `upgradedMany` counts what the batch updated, so the confirmation is one line rather than whichever row happened to finish last.
- `src/modules/i18n/messages.ts`: keys for the button and the batch confirmation, in both languages.
- `src-tauri/tauri.conf.json`: the CSP allows the asset protocol the way the build serves it - `http://asset.localhost`, which `convertFileSrc` produces - for images, media and frames. Without it every picture opened from the file list drew "could not read this image" with its path, and the same for video, audio and PDF previews.
- `src/modules/notifications/lib/useAgentVersions.test.ts`: the revision cases (either direction counts, equal does not, an unparsable commit is not a number) and the same library installed by both tools as two rows.
- `src-tauri/src/modules/agent_versions.rs` tests: the git checkout's `HEAD` forms, the source-to-repository split, a tool's colour escapes, and the upgrade ids.
- `scripts/dev/probes/agent-versions-check.mjs`: reports each row with its `agent` and `compare`, counts the rows per id family, and lists the revision rows with whether each is behind and the rows the badge would count.

**A file dropped from outside brings the window forward, so the question about it is on screen**

- `src/lib/windowFocus.ts` (new): `bringWindowForward`, the window's own `setFocus` for a drop the OS delivered to it.
- `src/modules/explorer/lib/useExplorerFileDrop.ts`, `src/modules/terminal/lib/useTerminalFileDrop.ts`: an accepted drop brings the window forward first. Measured 2026-11-04 with the window unfocused: the native `drag-drop` arrived on time and the conflict dialog's DOM was built 42 ms later, but an unfocused window is not painted, so the dialog stayed invisible until the window was clicked and came forward.
- `src/lib/windowFocus.test.ts` (new): both surfaces that accept a dropped path call it, and neither calls it during `enter`/`over`, where it would take the foreground from the window the drag started in.

**The file list's own menu no longer offers "attach to agent"**

- `src/modules/explorer/FileExplorer.tsx`, `src/modules/explorer/ExplorerSearch.tsx`: the "attach to agent" entry is gone from a file's context menu and from a search result's, and with it the `onAttachToAgent` prop neither surface ever received - the entry was drawn and did nothing. `src/modules/i18n/messages.ts`: its wording, both languages.
- `scripts/dev/probes/explorer-agent-menu.mjs`: the file's menu is now also checked for the absence of that entry, and the folder's for the agent row it is supposed to keep.
- `src/modules/settings/store.ts`: the key-to-field table that carries a write back into a window's store is now named and exported (`PREF_KEY_TO_FIELD`), and it holds `restoreTabsOnLaunch` - until now that switch was the one preference missing from the table, so it wrote its value on every click and stayed where it was on screen.
- `src/modules/settings/preferencePropagation.test.ts` (new): every field of `DEFAULT_PREFERENCES` has an entry in that table, so a preference cannot be added to the store, the disk format and the setters while being left out of the way back.

**Notes: a tab of their own, a list on the left and the editor on the right, files in notes\\ beside the executable**

- `src-tauri/src/modules/workspace.rs`: `notes_dir` creates `notes\\` beside the executable when it is missing, authorizes it, and answers with it; `notes_path` is the part a unit test can hold.
- `src-tauri/src/lib.rs`: the command is registered.
- `src/lib/native.ts`: the `notesDir` wrapper.
- `src/modules/notes/` (new): the list and the editor pane inside one tab, and the writes a notes tab owes - switching notes, leaving the tab and closing it all save first (`notesSave.ts` is the registry the close path calls, because the editor's handle lives in the view). A row renames in place (the pencil, or a double click) and deletes through a trash button and a rounded confirmation; a new note is named `note-YYMMDD-HHmmss.md`, to the second.
- `src/modules/notes/NotesView.tsx`: the right side keeps the three stops a markdown file has in an editor tab - rendered (the full-page render), source, and preview (source with the rendered column beside it) - drawn from the same toggle with the same disable-while-dirty rule, so the note and the file it is behave as one.
- `src/modules/tabs/lib/useTabs.ts`: `NotesTab`, `planNotesTabOpen` (one tab; a folder that moved with the executable drops the pick), `openNotesTab`, and `activePath` / `root` in the patch.
- `src/modules/tabs/lib/serialize.ts`: notes in the union, in the writer and in the reader.
- `src/modules/tabs/lib/useTabRestore.ts`: a restored notes tab is not granted here - its view authorizes through `notes_dir` the first time the tab is shown.
- `src/modules/tabs/NewTabMenu.tsx`, `src/modules/header/Header.tsx`: the notes tab opens from a button beside the projects one in the header, not from the new-tab menu; the terminal submenu no longer carries a 16rem floor, which left its right side empty.
- `src/modules/tabs/TabChip.tsx`, `src/modules/tabs/lib/tabLabel.ts`: the chip's icon and label.
- `src/app/components/WorkspaceSurface.tsx`: the notes layer.
- `src/app/App.tsx`: the handler that opens the tab, the rename of a picked note with its file, and the close that writes first. The header's note and GitHub icons toggle: a second click closes the tab each opened, through the ordinary close path, so a note is written before its tab goes.
- `src/app/hooks/tabCloseGuards.ts`, `src/app/hooks/useTabCloseGuards.ts`: a notes tab counts as open on the file it holds, and closing writes it.
- `src/modules/editor/index.ts`: unchanged - the notes view reaches `EditorPane` through its own file, because the barrel sits in the main window's eager graph and an export there pulled CodeMirror into the first load (the eager-budget test caught it).
- `src/modules/i18n/messages.ts`: the keys, both languages.
- `src/modules/tabs/lib/planNotesTabOpen.test.ts` (new), `src/modules/tabs/lib/serialize.test.ts`: one tab, the adopted folder, the round trip.
- `scripts/dev/probes/header-toggles.mjs` (new): the note and GitHub icons open their tab on the first click and close it on the second, and the note written by the tab that was closed is on disk before the tab goes.
- `scripts/dev/probes/notes-tab.mjs` (new): opens the tab from the header button, checks the new note's name to the second, types, requires the three view stops, switches away and back, renames the row and its file, closes and reopens, deletes through the confirm, and checks the folder is the one beside the executable.
</details>

<details>
<summary><strong>2026-11-03</strong></summary>

**Shallow clones, replacing a project with its remote, and the commit graph from a project row**

- `src-tauri/src/modules/git/operations.rs`: `clone_repo` takes a `depth`; `git_clone_repo` and `src/lib/native.ts` carry it through.
- `src/modules/projects/CloneRepoDialog.tsx`: a "newest commit only (shallow)" checkbox, which clones with `--depth 1`. The same dialog serves the projects list and the remote-repos list.
- `src-tauri/src/modules/projects/replace.rs` (new), `src-tauri/src/modules/projects/commands.rs`: `projects_replace_from_remote` resets a project to its upstream branch, and with `shallow` narrows the copy to one commit as well.
- `src/modules/projects/ProjectsView.tsx`: two new project-row menu entries, "pull and replace local" and "shallow pull (newest commit only)", each behind a confirmation dialog that names the branch, the commits and the files to be discarded. No backup is kept.
- `src/modules/projects/ProjectsView.tsx`, `src/app/components/WorkspaceSurface.tsx`, `src/app/App.tsx`: "open commit graph" on the project-row menu, opening the graph tab for that project's repository.
- `src-tauri/src/modules/git/operations.rs`: `git_run_in_repo` returns the exit status alongside the first line of output.
- `src-tauri/src/modules/projects/replace.rs`: a failed git step returns an error carrying git's own message; `clean -fd` runs only after the reset succeeded.
- `src/modules/projects/lib/types.ts`, `src/lib/native.ts`, `src-tauri/src/modules/projects/types.rs`: `ProjectStatus` carries `shallow`; `WireProjectReplaceReport` added.
- `src/modules/i18n/messages.ts`: seven keys for the new actions and dialog wording, in both languages.
- `scripts/dev/probes/shallow-pull-narrows-history.mjs` (new), `scripts/dev/probes/project-shallow-truth.mjs` (new).

**Dragging files out of the explorer, and a question when a drop lands on an existing name**

- `src-tauri/src/modules/drag.rs` (new): `fs_start_drag` starts a native drag session with the shell's `start_drag`, on the main thread, returning immediately. `src-tauri/src/Cargo.toml` takes the `drag` feature of the `tauri` crate; `src-tauri/src/modules/mod.rs` registers the module.
- `src/modules/explorer/lib/useExplorerDnd.ts`: a pointer drag that leaves the explorer hands its paths to that command once per gesture.
- `src-tauri/src/modules/fs/copy.rs`: two new commands - `fs_copy_conflicts` (which of the sources the destination already holds, in the sources' own spelling) and `fs_copy_replacing` (the same batch, allowed to replace). The replacement is staged and swapped in at the end; a directory that is replaced is moved aside first, so a failed swap puts it back.
- `src/modules/explorer/lib/dropConflict.ts` (new): the name a source would land under, and the conflicting names without repeats.
- `src/modules/explorer/DropConflictDialog.tsx` (new), `src/modules/explorer/FileExplorer.tsx`, `src/modules/explorer/lib/useExplorerFileDrop.ts`: one question per drop, applied to every name in it. The conflicting names are drawn as a line of text, up to five and then a count. Dismissing answers "skip". Nothing is remembered.
- `src/modules/i18n/messages.ts`: six keys, in both languages.
- `scripts/dev/probes/copy-drop-conflict.mjs` (new), `scripts/dev/probes/explorer-drop-conflict-dialog.mjs` (new), `scripts/dev/probes/explorer-desktop-drag.mjs` (new).

**Source control: a folder of repositories, and the panel staying open when asked**

- `src-tauri/src/modules/git/contained.rs` (new), `src-tauri/src/modules/git/contained_tests.rs` (new), `src-tauri/src/modules/git/mod.rs`: `git_contained_repos` lists the repositories a folder holds - a directory with `.git` in it, at most two levels down, never inside a repository it already found, dot directories skipped - each with the time of its last commit.
- `src/modules/source-control/repoDiscovery.ts` (new), `src/modules/source-control/repoDiscovery.test.ts` (new): the rules for choosing among them - the folder itself if it is a repository, otherwise the one below it, otherwise the one committed to most recently; and a place the panel has already been put is never moved by a later scan.
- `src/modules/source-control/useRepositoryTargeting.ts`, `src/app/App.tsx`, `src/lib/native.ts`: the scan runs when a session is opened at a folder, and only then; a folder is asked about once.
- `src/modules/source-control/useRepositoryTargeting.ts`: "open in source control" falls back to `git_contained_repos` when the clicked folder is not itself inside a repository.
- `src/modules/source-control/useRepositoryTargeting.ts`: choosing a repository by hand, and choosing "follow the active context", both mark the folder as answered.
- `src/app/App.tsx`: `openSourceControl` opens the panel instead of toggling it.
- `src/modules/source-control/SourceControlPanel.tsx`: the repository header carries `data-scm-repo`.
- `scripts/dev/probes/repo-discovery-newest.mjs` (new), `scripts/dev/probes/session-open-places-panel.mjs` (new), `scripts/dev/probes/open-in-source-control-keeps-panel.mjs` (new), `scripts/dev/probes/resolve-repo-one-level-down.mjs` (new).

**Source control follows a change made outside the panel**

- `src/modules/source-control/useSourceControl.ts`: the repository is registered with the file watcher while it is known - the working tree as itself, and `<root>/.git` with `<root>/.git/refs/heads` and `<root>/.git/refs/remotes/<remote>` through `includeSkipped`.
- `src/modules/source-control/useSourceControl.ts`: `fs:changed` is answered with one read of this repository, and only for paths inside it; a change that arrives while the panel is hidden is settled when it is looked at. The throttle defers rather than drops.
- `src/lib/repoPath.ts` (new): `changeTouchesRepo`; `src/modules/projects/lib/statusStore.ts` re-exports it.
- `scripts/dev/probes/commit-fires-watch-event.mjs` (new), `scripts/dev/probes/scm-follows-external-change.mjs` (new).

**Session state: an unread screen settles, and the service that runs a turn is asked**

- `src/modules/terminal/lib/agentRules.ts`: the opencode footer is identified by `ctrl+p` alone.
- `src/modules/terminal/lib/agentJudge.ts`: a screen identified as an agent's that no state rule can read counts as no evidence of work, and settles to `idle` after `IDLE_SETTLE_MS`.
- `src/modules/terminal/lib/agentRules.test.ts`, `src/modules/terminal/lib/agentJudge.test.ts`: the captured rest footer as a case, and the held-then-settled path.
- `scripts/dev/probes/session-open-dot-state.mjs` (new).

**Two settings retired or rewritten**

- `src/settings/sections/GeneralSection.tsx`, `src/modules/settings/store.ts`, `src/modules/i18n/messages.ts`: the "restore window position & size" switch, its preference, setter, startup group label and two message keys are removed. A value already stored under that key is no longer read.
- `src/modules/i18n/messages.ts`: the state-colour description rewritten in both languages.

**A session's state asked of the service that runs it**

- `src-tauri/src/modules/agent_sessions/service_turns.rs`: reads `GET /api/session/active`; `active_ids_from_json` reads the map the endpoint returns and rejects an entry that is not `running`.
- `src-tauri/src/modules/agent_sessions/mod.rs`: `agent_sessions_running` answers the ids, `None` when the service could not be asked.
- `src/modules/launcher/lib/sessionActivity.ts`: `activeWithService` gives the service's answer to the opencode rows; the write-time window keeps the rest.
- `src/modules/terminal/lib/sessionServicePhase.ts` (new): the join from "this tab resumed session X" to its ptys; `sessionsRunningNow` applies only the positive direction.
- `src/app/hooks/useAgentStateJudge.ts`: asks the service on its own cadence, separate from the screen judge.

**Opening an already-open session returns to its tab**

- `src/modules/launcher/lib/openSession.ts`: `openTabForSession` finds the terminal tab that already resumed a session, matched on `Tab.sessionId` among terminal tabs.
- `src/app/App.tsx`: `handleOpenSession` returns to that tab instead of opening another.
- `src/modules/launcher/lib/openSession.test.ts`: three cases.
- `scripts/dev/probes/session-double-open-one-tab.mjs` (new).

**A pull - in the panel or in a terminal - reaches its row**

- `src/modules/projects/ProjectsView.tsx`: while the tab is open the panel registers the directories it needs change events for, and releases them when the tab closes; a read nobody can see is settled by one narrow read when the panel is looked at again.
- `src/modules/projects/ProjectsView.tsx`: a row response is used only if no later read has already answered that row.
- `src-tauri/src/modules/fs/watch.rs`: `fs_watch_add` takes `includeSkipped`, the one hatch through the listing filter that drops `.git`.
- `src-tauri/src/modules/fs/watch/plan.rs`: entries of a repository's metadata carry their size and mtime, not just their names. Four entries are left out of that fingerprint: `index`, `index.lock`, `FETCH_HEAD` and `objects`. The ref directories are watched one level deep.
- `src/modules/explorer/lib/watch.ts`: `watchAdd` carries the option through.
- `scripts/dev/probes/projects-terminal-git-updates-row.mjs` (rewritten), `scripts/dev/probes/projects-pull-refresh.mjs` (rewritten), `scripts/dev/probes/markdown-preview-follows-typing.mjs` (new), `scripts/dev/probes/session-cover-repeat.mjs` (new).
</details>

<details>
<summary><strong>2026-11-02</strong></summary>

**A file whose name looks like a pattern no longer takes its neighbours with it**

- `src-tauri/src/modules/git/process.rs`: every git command now carries `--literal-pathspecs` ahead of the subcommand, on this machine and inside a distro alike. Every path here came from `git status`, so a status row for `note[1].txt` no longer matches `note1.txt` too when staging, unstaging or discarding.
- `src-tauri/tests/git_operations.rs`: the pair checked through each of the three destructive paths (stage, unstage, discard, the latter covering both `restore` and `clean`) in a real repository, and a unit case pinning that the switch sits before the subcommand rather than after it.
- Also corrects a stale expectation in that file: the branch-name rejection case asserts `InvalidRefName` rather than `InvalidPath`, matching the ref check that was split from the path check.

**A cancelled shell is not a shell still running**

- `src/modules/terminal/lib/agentState.ts`: a pattern that reads a word only where the agent writes its own count (`↓ 1 shell`, `· 2 shells`). The count has to sit where the footer puts it - after `↓`, after the `·` that separates its fields, or at the start of the line - so the tool's own result line `! Shell cancelled · cd … pnpm tauri dev` no longer reads as background work, and neither does a reply that happens to say "opened 2 shells".
- `src/modules/terminal/lib/agentRules.ts`: both `trailing` rules (shell, subagent) read the counted form.
- `src/modules/terminal/lib/agentRules.test.ts`: the reported screen, its neighbour that really is counting a shell (still `trailing`), and a sentence with a count of shells in it.

**The updatable list can be worked through without waiting, and a failure keeps its row**

- `src/modules/notifications/lib/useAgentVersions.ts`: `upgrading` is the set of ids in flight rather than one id, so one component's upgrade no longer disables every other row's button; the same component cannot be started twice. The section's spinner stops when the last run does.
- `src/modules/notifications/lib/useAgentVersions.ts`: the list is built by a new `updateRows`, which keeps a component whose check could not answer, so a failed check is no longer drawn as "everything is up to date" and a failed update keeps the button that can retry it.
- `src/modules/notifications/NotificationBell.tsx`: only the row that is running is disabled; a row whose answer was incomplete shows "unknown" instead of a version pair, with the reason on hover; the two failures go to the window's own bottom-right toast, with a stable id so a repeat replaces rather than stacks.
- `src/modules/i18n/messages.ts`: the word for a version that could not be read, in both languages.
- `src/modules/notifications/lib/useAgentVersions.test.ts`: the failed-check row kept, the newer-version row still listed, and "nothing to do" only when every row answered.

**Renaming a file keeps the editor's unsaved edits**

- `src/modules/editor/lib/documentPathChange.ts` (new): what a change of the open path means - nothing, the same document at a new name, or a different file. The answer comes from the caller's word rather than from "the path is not what it was", and the default loses nothing if the caller is wrong.
- `src/modules/editor/lib/useDocument.ts`: a rename is a path migration now, not an open. The buffer, its unsaved flag and the saved baseline survive it, and the write-behind timers are re-armed for the new name.
- `src/modules/editor/lib/drafts.ts`: a draft follows the file to its new key.
- `src/modules/tabs/lib/useTabs.ts`, `src/modules/editor/EditorPane.tsx`, `src/modules/editor/EditorStack.tsx`, `src/app/App.tsx`: the rename handler stamps the tab with the path its file had, which is what tells the editor the two paths are one document.
- `src/modules/editor/lib/documentPathChange.test.ts`, `drafts.test.ts`, `src/modules/tabs/lib/applyTabPatch.test.ts`: the decision pinned in both directions, the draft re-keyed (old name no longer offers it), and the note surviving a later dirty patch.
- `scripts/dev/probes/rename-keeps-edits.mjs` (new): creates its own fixture under the explorer root, opens it, types into it, renames it through the tree's own double-click flow, then checks the buffer still holds the typed text, the tab still carries its unsaved dot, and Ctrl+S writes to the new name and nothing to the old one.

**A read that answers late cannot land on another repository's panel**

- The four remotes panels are one mounted instance each whose `repo` prop is swapped when the person moves between repositories, and a `gh` read answers seconds later.
- `src/modules/remotes/lib/readTicket.ts` (new): two counters per panel - a **scope** that changes when the panel moves to another repository or closes, and a **request** per kind of read - so a read is refused both when the panel moved on and when the same panel asked for the same thing again. Two, rather than one, so that re-asking for the list does not cancel the detail and vice versa.
- `src/modules/remotes/IssuesDialog.tsx`: the list and the detail both hold a ticket, a repository switch abandons everything in flight and clears the detail along with it, and the two writes refuse to act on a detail that belongs to another repository. Answering from the cached list also replaces the request it answered, so a read still in flight for the same repository cannot land on top of the cache.
- `src/modules/remotes/ReleasesDialog.tsx`: the list read holds a ticket too. Saving edits names a release by the id on screen, which is checked against the rows of the repository now on screen.
- `src/modules/remotes/RunListDialog.tsx`: the same, for rerunning, cancelling and deleting a run.
- `src/modules/remotes/lib/readTicket.test.ts` (new): the newest read of a kind kept, an earlier one dropped, everything taken before a repository switch or a close dropped, and one kind re-asked without cancelling the other.
- `src/modules/remotes/lib/repoActivityDot.test.ts` reads `IssuesDialog.tsx` as text and looks for the end of the detail callback; the callback keeps the one-line shape that check looks for.

**Two downloads of the same file name no longer write into one file**

- Every download of a given asset now writes into a temporary file of its own rather than the single `<name>.verta-part` beside the destination.
- `src-tauri/src/modules/github/releases.rs`: the temporary file is one per download and named randomly by `tempfile` (`<name>.XXXXXX.verta-part`), created in the destination's own directory so promoting it is still a rename rather than a copy across filesystems. The download's finish takes the handle rather than a path, so there is no name left for a second download to hold.
- `src-tauri/src/modules/github/commands.rs`: the streaming write goes through that handle, and the four failure paths and the success path hand back the file itself rather than a path to something another download might be writing into.
- `src-tauri/src/modules/github/releases.rs` tests: two downloads of one name get two different files, neither sees the other's bytes, publishing one leaves the other's next write unable to reach the published file, and a failed download still leaves an existing file at the destination untouched with no leftover temporary.

**The plain file commands check the workspace they were promised to check**

- `src-tauri/src/modules/workspace.rs`: two entry points on the registry - one for a path about to be read, one for a path about to be created, written, renamed or deleted. The read side compares the canonical path, so `..` and a symlink pointing out of an opened folder are refused; the write side compares the nearest existing ancestor, which covers a target that does not exist yet and a "new folder a/b/c" chain created in one step.
- `src-tauri/src/modules/fs/file.rs`: `fs_read_file` and `fs_write_file` go through them.
- `src-tauri/src/modules/fs/mutate.rs`: `fs_create_file`, `fs_create_dir`, `fs_rename` (both ends, since a rename can carry a file out of an opened tree as easily as into one) and `fs_delete` go through them. `fs_move` and `fs_delete_batch` already had their own check and keep it.
- `src/app/App.tsx`: a file handed in from outside - "Open With", a CLI argument - has its parent registered first, which is what lets it be read and then saved; the terminal's own cwd entry point already worked this way.
- `src-tauri/src/modules/workspace.rs` tests: a file under an opened root accepted, a file in a directory nobody opened refused, a link that leaves an opened folder refused, a target that does not exist yet accepted through its parent, a chain whose immediate parent is missing accepted through the nearest ancestor, and a new file in a foreign directory refused.

**The side preview renders what is being typed, not what was on disk**

- `src/modules/editor/lib/useDocument.ts`: the buffer has a subscriber list now, published on every edit, on a load and on a restored draft, and handed the current text immediately when someone subscribes so a preview opened mid-edit starts on it.
- `src/modules/editor/EditorPane.tsx`: the preview renders that live text rather than `doc.content`, and subscribes only while the column is open.
- `src/modules/editor/sidePreviewFollowsTyping.test.ts` (new): pins both halves - the hook has to publish, and the pane has to read the published text.

**The commands and code left behind by the retired assistant are gone**

- Removed: the app commands `shell_session_*`, `shell_bg_*`, `secrets_*`, `ai_http_*` and `lm_ping` - a persistent shell, a background-job runner, an AI request proxy with its address classifier and client cache, and a key store in the OS keychain.
- `src-tauri/src/lib.rs`: those registrations, the three pieces of managed state and the two hooks that cancelled an AI stream on page load and on window close.
- Deleted: `src-tauri/src/modules/net.rs`, `src-tauri/src/modules/net/` (clients, ip, stream), `src-tauri/src/modules/secrets.rs`, and `src-tauri/src/modules/shell/{session,background,ringbuffer}.rs`.
- `src-tauri/src/modules/tls.rs` (new): the one part of that group still in use - the `ring` provider every reqwest client needs installed before it is built. The session-state reader and the version check call it, and it used to live in the deleted client module.
- `src-tauri/src/modules/shell/mod.rs`: reduced to the one-shot runner, which the editor's external formatter still calls. `src-tauri/tests/shell_background.rs` went with the background runner it tested.
- `src-tauri/Cargo.toml`: the `keyring` direct dependency (Windows and macOS flavours), `bytes`, and reqwest's `stream` feature; `futures-util` stays, because the version check joins its per-package lookups with it. `shared_child` stays: gh, LSP and the capture helper use it.
- `src/lib/native.ts`: the wrappers for those commands.

**The tab list is written down but no longer read back, and the old key events are gone**

- The code that read the tab list back is gone, including the migration from the per-workspace file older versions wrote.
- `src/modules/tabs/lib/tabStorage.ts`: `loadTabState`, `loadLegacyTabState` and the legacy store they read are gone; `saveTabState` stays, because the list is still recorded.
- `src/modules/tabs/lib/serialize.ts`: the whole hydration side - tree rebuilding, the cwd-versus-environment repair, and `freshTerminalTab` - is gone, along with the two title helpers only it used. `serializeTabs` and the types it writes stay.
- `src/modules/tabs/lib/serialize.test.ts`: deleted with the code it tested.

**The project list settles on its own after a pull**

- `src/modules/projects/ProjectsView.tsx`: a pull from the list settles its old status on its own, without a click on Refresh.
- `src/modules/projects/ProjectsView.tsx`: a pull now settles **only its own row**, through a read that takes the projects to read and whether to fetch first. The pull has already fetched, so the row is a `git status`, about 3.0 s end to end. The per-row ⟳ uses the same read with `fetch`, so settling one row no longer means fetching the whole list either.
- `src/modules/projects/ProjectsView.tsx`: a check that the panel asks for before the list has loaded is retried once the list lands.
- `src/modules/projects/lib/pullGate.ts` (new): when a pull may start - not while the status check is running, at most two at a time, never the same project twice.
- `src/modules/projects/ProjectsView.tsx`: `pulling` is the set of projects in flight, read through a ref so two rows clicked in one frame cannot both see an empty set; the row's button follows the rule the guard uses, so the two cannot drift apart. A check that fails keeps what the last good check found, on screen and in the file.
- `src/modules/projects/lib/pullGate.test.ts` (new): a row allowed while idle, refused during a check, refused while it is already running, two at a time and no more, the slot freed however the pull ended, and the gate never mutated in place.
- `scripts/dev/probes/projects-pull-refresh.mjs` (new): clicks a row's own ⇣ and then only polls the table, so what it reports is the panel settling itself rather than a Refresh.
</details>

<details>
<summary><strong>2026-11-01</strong></summary>

**Each changed file in source control says how many lines it added and removed**

- The Changes list draws the counts on each changed row, `+13 -0` and `+1089 -62` among them.
- `src-tauri/src/modules/git/types.rs`, `parser.rs`, `untracked.rs`: a changed file carries `added` and `removed` now (`Option<u32>`, so "git cannot say" is not the same as zero). The status parse leaves them empty; the untracked-directory expansion copies them from the entry it splits.
- `src-tauri/src/modules/git/operations.rs`: `status_inner` reads the counts along with the status, from `git diff --numstat` (working tree against the index) and `git diff --cached --numstat` (index against HEAD), merged per path into a file's total difference from HEAD. A rename is keyed by the path the status reports, which is the new one. A binary file reports `-` for both counts and is left out. A read that fails leaves every row without numbers and the status itself untouched.
- `src/lib/native.ts`, `src/modules/source-control/useSourceControlPanel.ts`: the two fields on the wire type and on the panel's row, carried through the flat per-file list. The optimistic unstage path, which fabricates rows before git answers, gives them `null` rather than a guess.
- `src/modules/source-control/lineCounts.ts` (new) and `SourceControlPanel.tsx`: `+N` in green and `−M` in red, right-aligned before the row's buttons, in tabular figures so a refresh does not shift the row. Zero is shown (`−0`). The pair is labelled for a screen reader instead of being read as "plus thirteen minus zero", and the row carries `data-scm-path` with the numbers inside a `[data-scm-counts]` for the probe to read.
- The minus is U+2212 MINUS SIGN, not the ASCII hyphen, so the two signs sit on the baseline together and read as the same size; `src/modules/source-control/lineCounts.test.ts` fails if the ASCII hyphen comes back.
- Untracked files show no numbers: git has no diff to count for them.
- When the counts are recomputed: only when the panel already refreshes (opening it, switching tabs, pressing refresh, after stage, discard or commit).
- `scripts/dev/probes/scm-line-counts.mjs` (new): compares every rendered row against `git diff --numstat` plus `git diff --cached --numstat` run by the probe itself in the same repository, merged by the same rule. A rendered number that disagrees with git fails the probe and exits 1.

**A working directory reported as a URI keeps its drive letter**

- The file tree and source control both read the active tab's cwd: `src/modules/tabs/lib/useWorkspaceCwd.ts` hands the tab's cwd to the tree, and source control resolves its repository from the same value.
- `src/modules/terminal/lib/osc-handlers.ts`: the repair for a drive that ends up inside a URI's authority decodes the authority before it looks for the drive inside it, so a `$PWD` in Windows form (`F:/dir`) printed as `file://HOSTF%3A/dir` is repaired the same way a literal colon is.
- `src/modules/terminal/lib/osc-handlers.test.ts`: the percent-encoded URI case added to the existing table.

**A tab is marked only when its icon is the agent's**

- `src/modules/tabs/lib/tabAgentIcon.ts` (new): one predicate for the two things that have to agree - the icon a tab draws and whether it earns the state marker.
- `src/modules/tabs/TabChip.tsx`: the icon and the marker both read that predicate now.
- `src/modules/tabs/lib/tabAgentIcon.test.ts` (new) and `tabAgentMarker.test.ts`: the truth table is a test of the predicate (no `agent` key, a property that is there but empty, a tab that is not a terminal), and what is left in the chip's guard is the wiring - it has to ask through that predicate and must not test `tab.agent` itself.
- `src/modules/tabs/lib/useTabs.ts`: a DEV-only `__vertaNewAgentTab`, the app's own path for a tab opened for an agent, so that a probe can have a tab whose icon is an agent's without an agent being started on it.
- `scripts/dev/probes/tab-agent-dot.mjs`: its fixture is opened through that hook rather than with Ctrl+T, and its closing step finds its own tab by `data-tab-id` instead of taking the last `[role=tab]` in the document. It reads the four states (idle emerald, working orange, attention sky, trailing purple), a cleared screen with no dot, and its own tab gone afterwards.

**Themes can no longer be created or imported**

- `src/settings/sections/ThemesSection.tsx`: the Create and Import .verta-theme buttons are gone from Settings and then Themes, and with them the hidden file input, the `.verta-theme` drop target and the error line under the theme list. What is left is the list itself: pick a theme, edit or remove a custom one.
- `src/settings/sections/ThemesSection.tsx`: the imports of `validateTheme` and `saveCustomTheme` went with them; both are still used elsewhere (the theme editor writes through `saveCustomTheme`, and `themeFiles.ts` validates what it reads).
- `src/modules/i18n/messages.ts`: the four strings that existed only for that path (`settings.themes.create`, `.import`, `.importFailed`, `.readFailed`) are gone from both languages. The background image's own "choose image" / "change image" controls and their drop target are untouched.

**A state's colour is a preference, not a constant**

- `src/modules/terminal/agentStateColours.ts` (new): the state vocabulary, the colour each state starts on, and three class tables keyed by hue - the dot, the bar's bed and the bar's light. It imports nothing.
- `src/modules/terminal/AgentStateDot.tsx`: both surfaces resolve their state to a hue through one preference and then read the same two strings, so a tab chip and a session list row cannot describe one session two different ways. The colour is the user's now; the breathing and the unseen-window marker are not, and stay strings of their own. The state type is re-stated here rather than re-exported. The default is what the interface has always drawn: `attention` sky, `working` and `background` orange, `idle` and `finished` emerald, `trailing` purple.
- `src/modules/settings/store.ts`: `agentStateColours`, repaired one state at a time - an unknown hue costs that state its choice and leaves the other five alone, and a table that is not a table at all falls back whole. `resetAgentStateColours` writes the defaults out rather than removing the key, so "asked for the defaults" and "never chose" are told apart in the file.
- `src/settings/components/StateColoursGroup.tsx` (new) and `src/settings/sections/ThemesSection.tsx`: a row per state and one swatch per hue, beside the session-opening transition. A swatch is painted the colour itself and is a real radio, so the arrow keys and the "3 of 8" a screen reader announces come from the platform.
- `src/modules/terminal/agentStateAppearance.test.ts`: rewritten around the shapes rather than the colours - every state has a hue, every hue is spelled out literally in all three tables, the bar is its dot's colour held back to a quarter, and every state breathes whatever colour it is.
- `src/modules/settings/agentStateColours.test.ts` (new): one bad entry costs one state, a missing state is filled in, and anything that is not a table draws the defaults.
- The settings window's six rows start on the defaults; a colour picked there reaches a session list row and the tab chip without a reload, the choice survives a reload of the main window, and Reset puts the file and both windows' stores back on the defaults.

**A pi session's turns and last activity are read from the whole file, not its first 8 MiB**

- `src-tauri/src/modules/agent_sessions/pi.rs`: `session_stats` reads the whole session file rather than its first 8 MiB. The timestamp extraction moved into `message_stamp` so both the reader and a test can name the same rule.
- `src-tauri/src/modules/agent_sessions/pi.rs`: a regression case builds a file larger than the old 8 MiB window (9 MiB of user messages) and asserts the turn count covers all of it and that the last activity is the end of the file.

**A reply that mentions PowerShell no longer marks its tab as having background work**

- `src/modules/terminal/lib/agentState.ts`, `agentRules.ts`: the `trailing` rule matches `shell` as a whole word, through a new `containsWord` pattern, so a reply that mentions PowerShell no longer counts as background work. The footer's own spellings still answer: `↓ 1 shell`, `↓ 2 shells` and `↓ 3 subagents` are all asserted.
- `src/modules/terminal/lib/agentRules.test.ts`: the scanned sentence is a case now, and it must not read as `trailing`.

**The cover that hides a session's launch command stays up until the command is gone**

- `src/app/coverRule.ts` (new) and `src/app/App.tsx`: which rule may lift the cover is one pure function now, and every rule requires that the launch command is not on the screen.
- Two more rules were closed: `bytes-fallback` no longer decides on a byte count alone, and `timeout-no-command` no longer accepts a screen with nothing on it.
- Every rule's answer is confirmed after the paint by reading the screen again (`paintsWithoutLaunchLine`).
- `src/app/coverRule.test.ts` (new): the thresholds each rule needs, the floor that keeps a branding flash from ending the wait, and an exhaustive case over every combination of the four thresholds and the three flags, asserting that no rule fires while `showsLaunch` is true.

**The bell lists the agent tools that can be upgraded**

- `src-tauri/src/modules/agent_versions.rs` (new): which tools this machine has, what versions they are on, and whether a newer one is published. opencode and pi answer for themselves, pi's npm extensions come from pi's own settings file, and every registry read runs at once.
- The registry is read over plain HTTPS against the URL `npm` is configured with, so a configured mirror answers the same way as npm would.
- On Windows the tools are `npm`, `opencode` and `pi` shims, run through `cmd /C`. The upgrade command is looked up by component id among the commands this module knows and is never built from the renderer's text.
- A pi npm extension is upgraded with `pi update --extensions`.
- `src/modules/notifications/lib/useAgentVersions.ts` (new) and `NotificationBell.tsx`: the header bell stays visible and counts what is in it. Only components with a newer published version are listed; when nothing is behind, one line says so. The check runs when the header mounts and again when the popover opens.
- An upgrade that succeeds says which version the component landed on; the row leaves the list once it is current.
- `src-tauri/src/lib.rs`, `src-tauri/src/modules/mod.rs`: the two commands registered.

**Each changed file in source control says what happened to it**

- `src/modules/source-control/lineCounts.ts`, `SourceControlPanel.tsx`: a `M`, `D`, `A`, `U` or `R` after the counts, in a fixed width slot, in the colour of the bar beside it and with the word in its tooltip.
- `src-tauri/src/modules/git/operations.rs`: an untracked file is counted as every line being added, by reading the file directly. A binary file answers no count rather than `+0`, and a file past the size cap is left without one rather than read whole.

**The projects panel spins rather than writing a word into a one glyph button**

- `src/modules/projects/ProjectsView.tsx`: the pull control keeps its size and shows a spinner while it runs. The row's own refresh button spins in place, and the panel's refresh button shows a spinner beside its fixed label.
- `src/modules/projects/ProjectsView.tsx`: the row's refresh button has its own per-row state.

**Switching to another repository paints its file list instead of waiting for a fetch**

- `src/modules/source-control/useSourceControl.ts`: the automatic fetch runs after the list is shown rather than in front of it, and a switch into another repository lands in 2 to 3 seconds. Its result still replaces the ahead and behind counts when it arrives, and each update re-checks that the request is still current.
- `src/modules/source-control/repoSnapshots.ts` (new): the last status of each repository, so switching back paints it before the live read lands; the caller always starts a live read afterwards. Bounded to twelve repositories by least recent use.
- `src/modules/source-control/useSourceControl.ts`: the context change window for data that is already fresh goes from two seconds to thirty.
- `src/modules/source-control/repoSnapshots.test.ts` (new): a repository is identified by its root rather than by how it was spelled, a POSIX path keeps its case while a Windows drive path does not, two workspaces stay apart, and eviction drops the least recently used entry.
</details>

<details>
<summary><strong>2026-10-31</strong></summary>

**The tab's state marker follows the tab's icon**

- `src/modules/tabs/TabChip.tsx`: the marker is drawn only on a tab whose icon is an agent's (a tab opened for an agent: a resumed session, or a project row's "open with"), and not on every tab the activity store knows a state for. The icon says which agent this tab is for and the marker says what it is doing.
- `src/modules/tabs/tabAgentMarker.test.ts` (new): the condition read as source text, asserting both halves - the state has to exist and the tab's icon has to be an agent's - and that the marker is not conditioned on the store alone.

**A tab whose agent has left stops describing one**

- `src/modules/terminal/lib/agentJudge.ts`: when the screen has shown no agent for longer than the grace period, the judge reports `exited` after whatever else it reported, so the activity store is told the session has no agent on it. A tab left on a bare shell prompt reads no state at all now, and the resting branch of `tabAgentStatus` finds no name to draw green on; the two tabs with agents actually running still read `working`.
- `src/modules/terminal/lib/agentJudge.test.ts`: the three cases on the agent-leaving path assert the new signals, and a new case replays the reported sequence end to end (an agent at rest, then four bare prompts) and asserts that the store is left with no name and no phase for that session.

**A turn that ended with background work still running is a state of its own**

- `src/modules/terminal/lib/agentRules.ts`: one rule for a session whose footer counts the tool's own shells (`opencode_trailing_shell`) and one for the subagents a turn started (`opencode_trailing_subagent`), both reporting the new state `trailing` at priority 815, below the rule for a turn in flight. The footer **wraps**, so `↓ 1 shell` often sits on the second-to-last line with only the remainder `·` below it, and both rules read the last lines rather than the last one. Subagents are matched as `subagent` and not `agent`, which also matches the model router opencode prints (`openai_agentrouter`). A count is excluded while the screen still offers an interrupt (`esc interrupt`, drawn elided in some frames as `esc...rupt`), and a spinner glyph anywhere in the region excludes it too.
- `src/modules/terminal/lib/agentState.ts`, `agentJudge.ts`, `agentActivity.ts`: the state, its visibility flag, the signal kind a change emits, the phase the store keeps, and the order a tab's chip is chosen in (a question, an ending nobody has looked at, a turn in flight, background work, then an agent at rest).
- `src/modules/terminal/AgentStateDot.tsx`: how that state is drawn on both surfaces - in purple, a colour no other state uses, on the dot and on the row's bar (the bed at a quarter, the light at full strength).
- `src/modules/i18n/messages.ts`: the state's wording in both languages: "The turn ended, background tasks are still running".
- `src/modules/terminal/lib/agentRules.test.ts`, `agentJudge.test.ts`, `agentActivity.test.ts`, `agentStateAppearance.test.ts`: the measured screens as fixtures (from the capture in `idle-screen.log`: the wrapped footer, the same situation unwrapped, a subagent count, and a running turn with the same counts on it that must stay `working`), the priority cases, and the appearance tables held to the colours they claim (four colours over six states now, since this one has its own).
- `scripts/dev/probes/tab-agent-dot.mjs`: a step that puts a screen with background work on a tab and reads the chip's state, its colour and its animation, and every step also writes a magnified picture of the chip. The fixture holds the shell's prompt back with a trailing `sleep`, and the steps around it wait longer, so the `clear` the next step writes does not land just before the read. The probe reads the chip's `background-image` as well as its colour, since a blended marker has nothing in `background-color` at all.
- `scripts/dev/probes/service-kept-lit-watch.mjs`: the row-level watch counts a row drawn as `trailing` as lit, and reports a row that stays lit because the screen itself says so in its own bucket.

**A question panel with more than one question is still a question**

- `src/modules/terminal/lib/agentRules.ts`: the question panel is recognised by its footer's real verbs. A single-question panel reads `enter submit  esc dismiss`; a panel with more than one question navigates with `⇆ tab` and its footer reads `↑↓ select  enter confirm  esc dismiss` while a question is being filled in, and `enter submit  esc dismiss` once the last one is. `enter confirm` is now a second rule for the same state and a second marker for the family.
- `src/modules/terminal/lib/agentRules.ts`: both panel rules read the **last three lines** rather than the bottom twelve, which leaves room for a wrapped footer and none for footer words quoted as prose in a reply.
- `src/modules/terminal/lib/agentRules.ts`: the permission card and the older caret question no longer count as a card while the footer still offers to interrupt the turn, which `noneOf` now says. Measured on the dev build: the prose screen reads `working` (via `opencode_interruptible`), a real card reads `blocked`, and a two-question panel reads `blocked`.
- `src/modules/terminal/lib/agentRules.test.ts`: the two-question panel as measured, asserted to read `blocked` and to be recognised as opencode, and a contrast screen - a mid-turn transcript that quotes both footers' words above its real footer - asserted to read `working`.
- `src/modules/terminal/lib/agentRules.test.ts`: a mid-turn screen whose bottom lines carry the card rule's two words (`permission`, `allow`) as prose above a footer that still offers `esc interrupt`, asserted to read `working`.

**A session row stays on screen while the list is being re-read**

- `src/modules/launcher/lib/sessionSources.ts` (new): the rows each source last answered with, kept per source rather than as one list, with the two edges the keeping needs - a source a read is no longer asking for (the WSL toggle went off) is dropped with its rows, and a source that failed is dropped too. The sources are walked in a fixed order when the rows are merged.
- `src/modules/launcher/components/LauncherPanel.tsx`: a read replaces the rows of the source that answered instead of rebuilding the list out of the sources answered so far. The pending set is still installed for every request and cleared per source, so the panel goes on saying it is reading while a source is outstanding.
- `scripts/dev/probes/session-rows-stable.mjs` (new): reads each read's **own answer** off a clone of the IPC response and samples the drawn rows every 20 ms, so a row that left the list can be attributed to the source that was still being read. It fails when a row leaves and comes back with no failing read, and it fails *itself* when a press is known to have landed and no change was recorded at all. The response body is read in the background, and a press is checked against the button's disabled state.
- Measured on the dev build with the same probe and the same session: both presses and the reads the session store's writes started left thirteen rows on screen the whole way, with nothing recorded but the header going between "refresh" and "reading".
- `src/modules/launcher/lib/sessionSources.test.ts` (new) and `src/modules/launcher/lib/sessionPanelRead.test.ts`: that sequence as a unit test (a source answering again keeps the other source's rows; an empty answer drops its own; a source no longer asked goes with its rows; a failed source goes too; the same list whatever order the sources answered in), and the panel's source-text guard follows the shape its read now has.

**The opencode service credential only goes to the one place it opens**

- `src-tauri/src/modules/agent_sessions/service_turns.rs`: the service file's URL is validated by parsing it rather than by its text. `http://127.0.0.1:42000@host` starts with the loopback address and connects to `host`, so the host now comes from the parsed URL and has to be a loopback address itself, `localhost` is normalized to `127.0.0.1`, and only `scheme://host:port` survives, so embedded credentials, another path, a query and a fragment are all refused. The client also refuses proxies (`no_proxy`, which includes the system proxy this build reads on Windows) and redirects (a policy that follows none). The service file is read only below 64 KiB and the answer only below 4 MiB.
- `src-tauri/src/modules/agent_sessions/service_turns.rs`: an answer that is not `/api/session`'s shape now reads as "could not ask" instead of as an empty list: a row without a string id, a `time` that is not an object and stamps that are not integers all count as unreadable. The credential-bearing struct lost its derived debug formatting, and the fixture no longer carries the measured password. Regression coverage added for the loopback-looking URL, the path, query and fragment overrides, an oversized service file, an oversized answer, a malformed answer, a redirect that must not reach a second listener, and the request that a real answer still produces.
- `src-tauri/src/modules/agent_sessions/wsl.rs`: the reader a distro runs applies the same rules in Python: `urlsplit` with an `ipaddress` loopback check on the parsed host, no credentials inside the URL, no other path, and an opener with no proxy handler and a redirect handler that declines every redirect. Its payload is validated the same way, an unreadable answer prints nothing, and the request goes to `/api/session` on the validated base rather than to whatever the file said.
- `scripts/dev/probes/wsl-service-credentials.mjs` (new): runs the distro-side Python program (taken out of `wsl.rs`) against a synthetic `service.json` in a temporary home and two throwaway loopback servers, one of them the place a redirect would send the request. Neither server is contacted now, a real answer is still read, an idle service still reads as an empty list, and an unreadable one prints nothing. The child is spawned asynchronously.

**The settings window's placement, measured against the window it is for**

- `scripts/dev/probes/settings-window-center.mjs`: the probe no longer measures the settings window against the middle of the screen. It reads both windows' boxes, checks the settings window against the main window's middle, prints both numbers so a run shows which rule the window followed, reports the size the code asks for, and has `--move-main`: put the main window near the bottom-left of the work area, ask for the settings window again through the application's own command, measure, and put the main window back where it was.
- `scripts/dev/move-window.ps1` (new): moves the dev build's main window to a given screen position, picking the process by executable path and its window as the largest visible one - the same rule `shot-window.ps1` follows.
- Measured on the dev instance with the main window moved to (40,451) in a 2560x1392 work area: the settings window is 900x910 at (299,447), and the main window's middle is (299,446).

**The sessions panel's reading state, measured from a cold start**

- `scripts/dev/probes/session-reading-cold-start.mjs` (new): records what the sessions panel says during a cold start, sampled inside the page every 25 ms from the first frames, together with every session-store read and when it settled. The reads come from the `fetch` the IPC actually uses, with the command's arguments in the request body. Two surfaces are measured separately: the list draws its reading copy in its own empty state, which only exists while the list is empty, and the panel header draws it on the refresh button for as long as the first read is in flight. Measured on a dev instance started from scratch with the WSL toggle on: the panel first draws empty, saying it is reading, with 13 reads outstanding, this machine's eight rows arrive, then the distro's block, and the header carries the reading copy over the whole wait. The empty "no sessions yet" copy never appeared. Restoring `reading={false}` makes the probe fail with such frames.
- `scripts/dev/probes/session-cold-start.mjs`: now hooks the `fetch` the IPC uses rather than `window.__TAURI_INTERNALS__.invoke`, reports each read with the tool and distro it asked for and how long it took, and fails when it recorded none. Measured: opencode on this machine answers in 50 to 150 ms, pi on this machine takes about 3.3 s, opencode inside the distro takes 0.77 to 0.97 s, and pi inside the distro about 20 ms.

**The two awaits before the first render, and what they cost**

- `src/main.tsx`: `pty_close_all` and `initLaunchDir` (the `get_launch_dir` read) are issued together now instead of one after the other before React rendered, so the interface waits for the longer of the two rather than for their sum; the reaping still completes before any tab spawns. Measured on the dev build, each run a fresh process: the pair takes 30, 33 and 32 ms on the critical path. Reloading a page that has a terminal open still logs `pty_close_all: reaped 1 orphaned session(s)` before the new tab's session is opened.
- `scripts/dev/probes/startup-awaits.mjs` (new): records every IPC call from the first frame of a cold start with the moment it was asked and the moment it came back, reports what those two awaits cost on the critical path and whether they overlapped, and notes when the window's drag region appeared (the root element cannot show that: `index.html` already has a child inside it).

**Whether a terminal model is still alive is asked in one place**

- `src/modules/terminal/ghostty/GhosttyBlocks.ts`, `ghosttyBlockSessions.ts`, `useGhosttyTerminalSession.ts`: five call sites that wrote out their own liveness check (`model.isDisposed?.()`) now go through `isModelLive`, which is where the two deliberate answers live: no model at all is not live, and a model that cannot answer the question is. The sites that can hand over no model at all keep their own check first.
- `src/modules/terminal/ghostty/modelLiveness.test.ts`: a case that walks the terminal module and fails when any file other than `modelLiveness.ts` calls `isDisposed`, naming the file and the count.

**The folder menu's row of agent icons is one row of that menu**

- `src/modules/explorer/FileExplorer.tsx`: the row of agent icons at the top of a folder's right-click menu was taller than every entry under it, by a padding on both the wrapper and the items. The wrapper lost its vertical padding and the items took the menu's own item padding, so the row is 28 px like the entries it sits above. The other two surfaces that draw the same row (the local project row's dropdown and its context menu) are unchanged.
- `scripts/dev/probes/explorer-agent-menu.mjs`: the probe reports each row's height and the row block an item sits in, and fails when the agent row is not the height of the entries under it, naming both. Measured on the dev build: every row in that menu is 28.

**A turn that outlives the write window keeps its row lit**

- `scripts/dev/probes/service-kept-lit-watch.mjs` (new): watches a session the opencode service reports mid-turn and records, every thirty seconds, what that service read returns, what the panel drew for the row, and how old the session's last write is. A row is lit either because the store was written within three minutes or because the service says the turn has not finished. It reads the store's file stamp as well, and it exits 3 when the situation never arose instead of reporting the claim as verified. Measured on the dev build against turns already running: fourteen samples over seven minutes, all with three sessions mid-turn, one of them (`Verta Go`) reaching a write age of seven minutes, and eight consecutive samples where that row was drawn as running with its last write past the window; no sample had the service reporting a turn while the row went dark.
- `scripts/dev/probes/service-kept-lit-watch.mjs`: the watch survives the page being reloaded under it, waits for the panel to come back, and says how long it actually watched. A sample imports everything it needs on each call and keeps no state, so the debugging target is reopened and the same sample taken again; each reload is counted into the summary, and the closing lines print the observed minutes next to the asked-for ones. The first row is waited for rather than looked for once.
- Measured on the dev build over forty five minutes in one unbroken run (115 samples): a row does go dark, and at the right moment. `Verta Go`'s row stayed lit for about three more minutes after its turn ended, going dark at **04:39:03** with the service no longer reporting it and its last write **3.5 minutes** earlier, just past the three minute write window. The same 115 samples had no row missing from the document at all.

**A state-dot watch records only what that run itself recorded**

- `scripts/dev/probes/state-dot-watch.mjs`: attaching to a window that has been open a while is handed every console line already buffered in it, so each run now tags its lines with a tag only it knows and ignores every other tag. Measured on the dev build: the same five second run reports 20 entries and 3 verdicts, none of them older than the run, on the first attach as well as the second.
- Measured with it, a question held open in a tab: the judge read `blocked (opencode_questions_panel)` for as long as the panel was up, the tab's own dot read `attention` on every sample and the `unseen` latch held that pty. Both cleared in the same tick the panel was dismissed and the verdict went back to `working (opencode_interruptible)`.

**A credential reader is measured where a distro runs it**

- `scripts/dev/probes/wsl-service-credentials-in-distro.mjs` (new): the reader a distro runs is a Python program handed to `wsl.exe` as `python3 -c`, and this probe runs it in the distro, from the program taken out of `wsl.rs` rather than copied, and prints whether the application's own argv (2445 characters, multi-line) survives the trip through `wsl.exe` and the distro's python accepts it. Measured on Ubuntu-22.04 with python 3.10.12: the trip is intact and nine checks of the boundary pass there. A harness inside the distro sets the synthetic home and runs the two loopback servers, and the probe checks that the harness removed its temporary directory rather than believing it. `--program-from=<rev>` runs the same checks against an earlier revision's program.
</details>

<details>
<summary><strong>2026-10-30</strong></summary>

**A session mid-turn, asked of the service that runs it**

- `src-tauri/src/modules/agent_sessions/service_turns.rs` (new): opencode runs a background service that holds its sessions and knows, per session, when the current turn started (`busy`) and when the last one ended (`idle`). A session with `busy` later than `idle` has a turn still running. The service's endpoint and password are read from `~/.local/state/opencode/service.json` at call time, nothing is stored, and only a loopback URL is accepted. A missing file, a stopped service or an answer that is not `/api/session` all read as "could not ask", which is kept distinct from "nothing is running".
- `src-tauri/src/modules/agent_sessions/mod.rs`, `src-tauri/src/lib.rs`: the command, on the blocking pool.
- `src-tauri/src/modules/agent_sessions/wsl.rs`: the same question asked from inside a distro, since each one runs its own service on its own loopback interface.
- `src/modules/launcher/lib/sessionActivity.ts`, `src/modules/launcher/components/LauncherPanel.tsx`: the two readings are merged - either one saying "yes" is enough. The service is asked on the panel's existing slow tick, and a source that cannot be asked contributes nothing, leaving the write times to carry the list alone.
- `src/modules/launcher/lib/sessionActivity.test.ts`, `src/modules/launcher/lib/sessions.ts`: the merge pinned in both directions, the fallback when the service cannot be asked, and the wrapper that tells "could not ask" apart from "nothing running".

**A question is blue, and it stays counted while it is being asked**

- `src/modules/terminal/lib/agentRules.ts`: two shapes of the opencode question panel. The panel this machine draws has **no caret** on its options (an option line is the number, a dot and the option's text, with no selection arrow), and its footer replaces the usual `ctrl+p` / `· tokens` hints with its own. The panel is identified by its own footer (`enter submit`, `esc dismiss`), which is chrome rather than content and so cannot be confused with an option line pasted into a conversation. The idle rule keeps reading the usual footer.
- `src/modules/terminal/lib/agentActivity.ts`, `src/app/hooks/useAgentStateJudge.ts`: a waiting session is counted wherever it is drawn. The phase leaving `attention` is what clears the count; an *ending* is still cleared by looking.
- `src/modules/notifications/lib/attentions.ts`: a question panel owns the alternate screen and writes no newlines - the whole screen arrives as one string whose rows are marked only by box characters, so the line-based excerpt took the middle of the conversation instead of the question. The panel's question is now read from its own layout, between its header and its first option.
- `src/modules/terminal/lib/agentRules.test.ts`, `src/modules/notifications/lib/attentions.test.ts`: the measured screens kept verbatim.

**The list says it is reading while a source is still out**

- `src/modules/launcher/components/LauncherPanel.tsx`: sources settle one at a time and each is cleared as it answers, and the list counts as reading until the last one has answered.
- `src/modules/launcher/lib/sessionPanelRead.test.ts`: pins that a source still outstanding keeps the list in "reading".

**This machine's sessions stay above the distros', each newest-first**

- `src/modules/launcher/lib/sessionGroups.ts`: the source order is fixed (this machine, then each distro by name) and only the rows inside a source are ordered by recency.
- `src/modules/launcher/components/LauncherPanel.tsx`: uses that instead of grouping inline.
- `src/modules/launcher/lib/sessionGroups.test.ts`: pins the order, including the case of a distro session newer than this machine's.

**A distro having no pi sessions is not reported**

- `src-tauri/src/modules/agent_sessions/wsl.rs`: the platform's `pi` is the Windows binary, which WSL resolves to the same program, so its sessions stay on the Windows side and are listed there; a distro with none no longer raises a notice.

**The settings window opens over the window it is for, and a third taller**

- `src-tauri/src/lib.rs`: the window asks for 910 rather than 700, and it is centred on the main window rather than on the screen, clamped to the work area so a main window against an edge cannot place it partly off.

**The count of waiting sessions beside the tab strip is gone**

- `src/modules/header/AgentActivityBadge.tsx` (deleted), `src/modules/header/Header.tsx`, `src/modules/i18n/messages.ts`: the badge and its wording, in both languages, are removed. Each tab already carries its own dot, and the sessions list carries the row's.
- `scripts/dev/probes/tab-agent-dot.mjs`, `scripts/dev/probes/tab-agent-unseen.mjs`, `scripts/dev/probes/agent-lab.mjs`: stopped reading the badge.

**A probe for the dots, and what it measured**

- `scripts/dev/probes/background-agent-dot.mjs` (new): reads every session row's state marker out of the live page and counts them by state. `--expect-active=<text>` fails the run when no row whose title contains that text carries a mark. Measured on the dev instance: a session left running in a bare `opencode` (no `--session`) shows the orange mark, and the same run showed a session marked a few minutes earlier go back to no mark once its writes stopped; a row whose title does not match reports "no mark". A session opened as a tab is drawn from the tab - a stale row read as no mark went to the tab's own `idle`.

**The activity window is three minutes for every tool**

- `src/modules/launcher/lib/sessionActivity.ts`: the table keeps one window per tool, and both tools now read three minutes - a length that covers the longest gap measured inside a turn on either of them.
- `src/modules/launcher/components/LauncherPanel.tsx`: passes the table.
- `src/modules/launcher/lib/sessionActivity.test.ts`: pins that both tools share the window, that it covers the longest gap measured on either, and that a session quiet for longer than it is let go.

**A session's two times are read as whichever is later**

- `src/modules/launcher/lib/sessionActivity.ts`: the activity window now combines the conversation time and the time the session's own store was last written as whichever is later, which is also what the row's own display already does.
- `src/modules/launcher/lib/sessionActivity.test.ts`: both directions pinned - a fresh store time over a stale conversation time, and the reverse.

**A session left running outside this window now shows an orange dot**

- `src/modules/terminal/AgentStateDot.tsx`: a fifth state, orange like work in flight but with its own wording, which says an agent is at work out there without naming the tool.
- `src/modules/launcher/lib/sessionActivity.ts`: the two readings - which sessions were written to inside the window, and the merge. A session open in a tab keeps the pty's reading (a question waiting stays blue), a session with no tab and a recent write gets the new state, and subagent sessions are left to their parent so one agent cannot light two rows. The window is three minutes.
- `src/modules/launcher/components/LauncherPanel.tsx`: the times arrive with the rows the list already reads, so this makes no query of its own, and a slow twenty-second tick re-answers "is anything still recent". The tick stops while the window is put away in the tray.
- `src/modules/launcher/lib/sessions.ts`, `src/lib/native.ts`, `src/modules/i18n/messages.ts`: the wording, in both languages, and the removal of the process-snapshot wrapper it replaces.

**Which session a running agent belongs to is read from the session store, not the process table**

- `src-tauri/src/modules/agent_sessions/mod.rs`, `src-tauri/src/lib.rs`: the process-table command and its registration are gone, along with `src-tauri/src/modules/agent_sessions/background.rs`. That command answered only processes that named a session in their command line (`opencode --session <id>`); what says which session was touched now is the session's write times, read from the store the app already reads.
- `src-tauri/Cargo.toml`, `src-tauri/src/modules/pty/foreground.rs`: the two `windows-sys` features the deleted module needed, and the ToolHelp snapshot goes back to being private to the close-tab guard.

**The settings window no longer takes its size and place from the last run**

- `src-tauri/src/lib.rs`: the window-state plugin is told to skip the settings window's saved geometry, so it opens where the code puts it (centred) and at the size it asks for. The plugin still saves the window. The window label also has one definition inside the Rust side now. The capability files still spell it out, so renaming that constant means touching them too.

**Renaming a session from its row menu now opens the name box**

- `src/modules/launcher/lib/selection.ts`, `src/modules/launcher/components/SessionList.tsx`, `src/modules/launcher/components/LauncherPanel.tsx`: both sides now go through one function, and the menu's session key (`tool::source::id`) carries a type that a bare session id does not satisfy, so the two cannot drift apart again without a compile error.
- `src/modules/launcher/lib/selection.test.ts`: covers the match, the raw-id mismatch, and two stores holding the same id.

**Two more probes, and the numbers they produced**

- `scripts/dev/probes/repo-activity-dot.mjs` (new): reads every repository row's name and whether a dot is drawn next to it, plus the dot's size, colour painted onto a canvas (Tailwind ships oklch, so the computed value is not an rgb string) and its distance from the name. Moves the real pointer onto a named row first. Measured on the installed build: the dot is 6x6, amber, six pixels right of the name, and it appears only once a repository has something newer than the last look.
- `scripts/dev/probes/settings-window-center.mjs` (new): compares the live settings window's box against the middle of the screen and of the work area.

**A dot beside a repository's name when something there is newer than the last look**

- `src/modules/remotes/RemoteReposView.tsx`: the dot sits in the name cell, cannot be squeezed away by a long name, and is decided by comparing the newest update against the repository's mark. The question is asked on the row's existing hover, alongside the CI one, so nothing is asked and no dot is drawn at startup; an answer expires after a minute, a failed read included. A mark is never written earlier than the newest update already known for that repository. Renaming a repository moves its mark with it, because the marks are keyed by name.
- `src/modules/remotes/IssuesDialog.tsx`: opening an entry - not opening the list - is what marks a repository as read.
- `src/modules/remotes/lib/repoActivityDot.test.ts` (new): pins where the dot is drawn and what clears it.
- `src/modules/i18n/messages.ts`: the dot's own wording, in both languages.

**When each repository was last looked at, kept beside the repository list**

- `src/modules/remotes/lib/listStore.ts`, `src/modules/remotes/lib/listStore.test.ts`: the marks live in the same file as the list, under their own key, and are read back through validation of their own. The store writes whatever it is handed, an empty map included; the caller writes only when a mark actually moved.

**The rule for "something new", and the frontend wrapper for the read behind it**

- `src/modules/remotes/lib/activity.ts` (new), `src/modules/remotes/lib/activity.test.ts` (new): the pure answers - is the newest update later than the last look, what does a mark become after something is read, and what is kept when the stored marks turn out to be junk. Everything that is not a real timestamp is treated as "never looked at", and a read that produced no timestamp is never drawn as something new.
- `src/lib/native.ts`: the wrapper for the new read, with its own payload type so an empty repository and a failed read stay distinguishable.

**A read that answers whether a repository has new activity**

- `src-tauri/src/modules/github/activity.rs` (new): reads the newest update out of a one-item listing of a repository's open pull requests and issues. An empty list is a definite "nothing is open"; an entry without a timestamp is an error rather than a guess.
- `src-tauri/src/modules/github/types.rs`: the answer is its own payload, with the same `kind` vocabulary as the CI one, so a failed read can never be mistaken for "nothing new".
- `src-tauri/src/modules/github/commands.rs`: the read itself - one request per repository, open items only, asked on demand rather than for the whole list.
- `src-tauri/src/modules/github/mod.rs`, `src-tauri/src/lib.rs`: the module declared and the command registered.
</details>

<details>
<summary><strong>2026-10-29</strong></summary>

**The settings window always opens in the middle of the screen it is on**

- `src-tauri/src/lib.rs`: opening settings now centres the window every time - both when it is built and when it is shown again after having been dragged somewhere. The placement is the same on every platform instead of a macOS-only calculation against the main window.

**Two more probes: a pull request's corner, and coming back to the sessions list**

- `scripts/dev/probes/issue-detail-corner.mjs` (new): compares the boxes of a pull request detail's "open on GitHub" button and the panel's close button. Measured on the installed build: 1162 and 1174 - a 12-pixel gap.
- `scripts/dev/probes/sessions-return.mjs` (new): leaves the sessions list for the file tree and comes straight back, sampling the panel once per animation frame so a single empty frame is caught, and reports whether anything said "no sessions". Measured on the installed build over three round trips: every frame carried sessions, none said the list was empty.

**Switching back to the sessions list no longer says it is empty**

- `src/modules/launcher/components/LauncherPanel.tsx`: the panel keeps the last list it read at module scope and starts from it, so the sidebar's remount - leaving for the file tree and coming back - draws the sessions it had instead of starting from nothing. It also tracks whether a read has finished at all.
- `src/modules/launcher/components/SessionList.tsx`: an empty list says "reading" until the first read lands, and "no sessions" only after it.
- `src/modules/remotes/IssueDetail.tsx`, `src/modules/remotes/ReleaseDetail.tsx`: the same corner as the run detail - the row's last button stops short of the panel's close button.

**A probe for the corner where a run's two buttons meet**

- `scripts/dev/probes/run-detail-corner.mjs` (new): opens a run's own detail - the remote list, the first repository that has a run, that run's detail - and compares the boxes of the row's "open on GitHub" button and the panel's close button, reporting what sits at the point where they would meet. Measured on the installed build: GitHub's right edge at 1098, the close button's left edge at 1110 - a 12-pixel gap.

**A run's first row keeps clear of the panel's close button**

- `src/modules/remotes/RunDetail.tsx`: the row that carries "back" and "open on GitHub" stops short of the panel's top-right corner, where the shared dialog draws its close button.
- `src/modules/remotes/runDetailHeight.test.ts`: pins the gap rather than the corner.

**A run's record opens from the column that shows the result**

- `src/modules/remotes/RemoteReposView.tsx`: a remote repository row no longer opens the runs panel from a click anywhere on it, and no longer carries a pointer cursor. The CI column's own button is the way in, with the row's menu offering it as before; hovering still checks, which is not a click.
- `src/modules/remotes/remoteRowClick.test.ts` (new): pins that the row carries no such click and no pointer cursor.

**A probe for a run's detail sitting inside the window**

- `scripts/dev/probes/run-detail-height.mjs` (new): reads the open run panel's own box against the window's, finds the log body and asks whether it scrolls inside it, and with `--close` presses the panel's close button and reads whether the panel is gone. Measured on the installed build with a 712-line log: a 768x720 panel from 111 to 831 in a 941-high window, its log scrolling inside a 720x331 box with 15088 pixels of content, and the close button leaving no panel behind.

**A run's detail is a panel with a height, not a page that keeps growing**

- `src/modules/remotes/RunDetail.tsx`, `src/modules/remotes/RunListDialog.tsx`: the run detail is capped to the window and scrolls inside itself - the job list gets a fixed share and the log takes what is left. The viewport percentage that used to sit on the log body is gone.
- `src/modules/remotes/runDetailHeight.test.ts` (new): pins which element owns the height and which owns the scroll.

**A probe for a toast that can be read twice**

- `scripts/dev/probes/toast-copy.mjs` (new): reads the toasts on screen - whether their text can be selected, whether they carry a close button and an action - then drags across the title with real mouse events and reads `window.getSelection()`. `--copy` presses the action and looks for its confirmation. It refuses to run with no toast on screen rather than reporting a pass on nothing. Measured on the installed build, on the error a folder name with a slash raises: the text was selectable, a real drag selected 23 characters and left the toast in place, and the action turned the toast into its confirmation while the clipboard held the whole sentence.

**A toast can be read twice, and a failed write is no longer silent**

- `src/components/ui/sonner.tsx`: a toast now carries a close button and its text can be selected; a drag across the text selects it instead of dismissing the toast, and the action that copies is offered per message rather than by making the whole stack draggable.
- `src/modules/explorer/lib/useFileTree.ts`, `src/modules/i18n/messages.ts`: creating a file or a folder, renaming, and deleting each now say what failed, and each offers to copy that sentence.
- `src/modules/explorer/lib/fileTreeFailures.test.ts` (new): pins that each of the three writes says something and keeps the console line beside it.

**A probe for a project row, end to end**

- `scripts/dev/probes/project-row.mjs` (new): opens the projects panel from the header, closes the source column, hovers a project's name and reads that nothing appeared, then presses it and reads the layout again - the column must be open and a terminal must have opened. Measured on the installed build: hovering drew no popper; pressing took the column from zero width to 260 and the tabs from 2 to 3; pressing again with the column open left it at 260 rather than closing it.

**A project row no longer opens a card, and points the source panel at itself**

- `src/modules/projects/ProjectsView.tsx`: the hover card that appeared beside a project's name is gone, with the body it drew and the props only it used. Opening a session from one of those rows was the card's only entry point; the row's own menu and the sessions panel both still offer it.
- `src/app/App.tsx`, `src/app/components/WorkspaceSurface.tsx`: pressing a project name now also points the source-control column at that repository and opens the column if it was closed. The callback moved up beside the panel hooks it needs, and the terminal it opens is no longer skipped.

**The review's findings, fixed**

- `src/modules/launcher/components/SessionList.tsx`: the popup carries the class every other floating panel in this window carries, so on the glass theme it takes the same pane tint as the menus beside it. The comment about how the row's two triggers compose now also says that the popup writes its own state attributes onto the row.
- `src/settings/sections/GeneralSection.tsx`: the density control shows the interface's own words for the chosen value rather than the stored `standard`.
- `src/modules/settings/store.ts`: the fallback for an unrecognised value is read from the default rather than written out a second time.
- `src/modules/i18n/messages.ts`: the English description of the compact list is split into two sentences instead of one long list.
- `scripts/dev/probes/session-list-density.mjs`: the standard density's check now requires no popup at all rather than no more than before, a run cannot check a density without hovering, the readings are judged from the last one taken while the list was certainly on screen, and an empty reading is a failure rather than "no rows, everything correct".

**A probe for what a session row draws in each density**

- `scripts/dev/probes/session-list-density.mjs` (new): reads the density the list says it drew, then each row's lines, its native title and the popups on screen - and, given `--hover`, puts the pointer on a row for real and reads what appeared while it is still there. `--expect=standard|compact` checks each density's consequences, and `--click-row` presses the row to prove a compact one still opens a session. It names the window by its whole address rather than by a prefix. Measured on the installed build: the default drew two-line rows and no popup on hover; compact drew one-line rows with no native title, one three-line popup carrying the directory, and the row still opened a session; a restart kept it compact; and switching back brought the two-line rows and the silent hover back, with the main window following the settings window each time without a restart.

**The compact row's popup is painted in the window's own surface**

- `src/modules/launcher/components/SessionList.tsx`: the popup takes a menu's surface - the theme's own popover colours with a border and a shadow - instead of the shared sheet's inverted two-colour pill. Measured on the installed build, the same popup reads `#2b3239` on `#f2f5f7` under the acrylic theme, both of which are that theme's own values.

**A compact session row keeps its numbers on hover**

- `src/modules/launcher/components/SessionList.tsx`: a row draws one of two densities. The compact one is a single line - the agent's icon, the title, the running light - and the numbers line moves into a popup that also carries the session's directory. The browser's own title tooltip is set on the standard row only. Both triggers of a row - the context menu's and the popup's - end on the same element, so their slots are chained and the row sits at the end of the chain. A compact row still opens, and still offers the same menu; the popup is mounted only in the compact density. The file's own comment about what a row carries was corrected.

**One line for a session's numbers**

- `src/modules/launcher/lib/sessionStats.ts`: the row's three facts joined into a single line, for the popup a compact row shows, built from the same three label functions the row itself draws with. The separator is the one the row already puts between its segments.

**A row in the settings window for it**

- `src/settings/sections/GeneralSection.tsx`, `src/modules/i18n/messages.ts`: a session-list group holding one row, a two-option choice between the standard list and the compact one, with the description saying what moves where. It reads and writes the preference, so the change reaches the main window through the same broadcast every other setting uses, without a restart.

**A session list can be drawn compact or standard**

- `src/modules/settings/store.ts`: a preference for how much a session row says at rest - `sessionListDensity` - whose default is the two-line row every install already shows. Only the one word reads as compact: a file edited by hand, or a value some later version wrote, draws the standard list.

**A probe for what a launch opens with**

- `scripts/dev/probes/start-with-one-tab.mjs` (new): counts the tabs the window drew and reads the place the active one landed. `--title=<name>` requires the single tab's name, and `--where` types `pwd` as real key presses and prints the last lines of the interface's own readable copy of the terminal. Measured on the installed build, one launch at a time: three tabs on disk (the last one active, in another directory) and the window drew one, on the desktop; a folder argument still landed there (`/c/Users/cxj/Desktop/agent2api`); and with the default environment set to WSL, the same single tab landed on `/home/cxj`.

**A launch starts with one tab of its own**

- `src/modules/tabs/lib/useTabRestore.ts`: starting up no longer takes the previous session's tab list. It loads the preferences and adopts the default workspace environment, and the single tab the window opened with is the whole content. Nothing of where the last session was - its tabs, their directories, or the environment its active tab sat in - carries over. The tab list is still written back; it is never read on the way in, so the reading side of that storage (and the older format it could migrate) is left in place, tested and unused.
- `src/app/App.tsx`: stopped handing the restore what it needs to rebuild a tab list, and the two comments that described waiting for one now describe what that wait is for - a resolved workspace before a file or a folder argument opens anything.

**The launch directory is the one this launch was given**

- `src/lib/launchDir.ts`: a start with no directory argument has no directory now, instead of falling back to the directory Verta itself was started from. The terminal is handed no working directory, and the environment decides - the desktop on Windows, the distro's home under WSL. A folder argument is untouched and still opens.

**Two comments corrected to say what the code does**

- `src/modules/explorer/lib/agentActions.ts`: a folder path that cannot say which env it belongs to keeps the window's answer *or the distro the window last used* - the comment now names both halves of that answer.
- `src/modules/launcher/lib/sessionStats.ts`: the doc comment quoted `12.3 k` and `1.2 M`, neither of which is a string this code produces. It quotes what it produces.

**Two probes corrected, one of them because it could not pass**

- `scripts/dev/probes/exception-watch.mjs`: an uncaught exception is what fails it now, and `console.error` or an error-level log entry is printed as context rather than counted against it. The header says which is which.
- `scripts/dev/probes/startup-timing.mjs`: whether the interface is up is judged by the window's own drag-region marker rather than by counting elements, and a CDP error rejects instead of leaving the caller to read a result off a message that never had one.

**The recovery panel keeps the window's own controls**

- `src/app/components/AppErrorBoundary.tsx`: the panel that replaces a broken interface now carries a drag region and the window's controls, and paints its own surface. On Windows the frame draws none of those (`decorations: false`), so the close button and the drag region live inside the application.
- `src/app/components/appErrorBoundary.wiring.test.ts`: both pinned, read as text like the rest of that file.

**The door a session goes out of when it never started tells the interface too**

- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts`: the path that gives up on a session whose initialisation failed now tells the surface that was drawing it that the model is gone. The teardown is one named function now, so the two doors out of a session read the same way.
- `src/modules/terminal/ghostty/disposeSessionResources.test.ts`: the giving-up door pinned beside the disposal one - the notification, and the rest of what it hands back.
</details>

<details>
<summary><strong>2026-10-28</strong></summary>

**A probe: how long the interface takes to arrive**

- `scripts/dev/probes/startup-timing.mjs` (new): run before the application, it reports when the page target existed, when the interface was in the document, and the page's own navigation entries, and it reads a launch timestamp from a file.
- Measured with it: from the process starting to the interface being in the document, 3.6s cold and 1.0s warm; the application's own share, navigation start to the document being ready, was 0.8 to 1.0s both times.

**A probe: everything the interface threw**

- `scripts/dev/probes/exception-watch.mjs` (new): attaches to the window's own log domains - uncaught exceptions, console errors, log errors - and exits non-zero if it saw any, so it works as a check and not only as a readout; `Log.enable` replays the entries the browser had already collected.
- Measured with it, with every terminal's renderer forced to fail (`--disable-gpu --disable-software-rasterizer`, where the webview reports `WebGL2 is unavailable in this webview`): switching through every tab and closing one left the window intact - 389 to 539 elements, the root element never emptied, and not one uncaught exception in seventy-five seconds of watching. Each pane reported its own failure instead ("could not start the terminal", with a retry). The three `console.error` lines it saw are the failure path itself.

**One broken component no longer takes the window with it**

- `src/app/components/AppErrorBoundary.tsx` (new): the application is mounted inside a boundary, which catches what a render, a commit or a passive effect throws. The panel reads the current language, but it loads nothing and holds nothing that could throw in turn, and the reload it offers is the user's move rather than its own.
- `src/app/components/appErrorFallback.ts` (new): turning whatever was thrown into the line the panel shows. A component usually throws an `Error`, but a rejected promise can carry a string and code can throw anything at all; an error with no message is shown by its name rather than as a blank line.
- `src/main.tsx`: wraps the application in it. `src/modules/i18n/messages.ts`: what the panel says, in both languages.
- `src/app/components/appErrorFallback.test.ts`, `src/app/components/appErrorBoundary.wiring.test.ts` (new): the first pins what the panel says about each kind of thrown value; the second pins the wiring, read as text the way the motion budget test reads the stylesheet.

**Nothing subscribes to a terminal model that is already gone**

- `src/modules/terminal/ghostty/modelLiveness.ts` (new): one answer to whether a model is still worth holding on to. No model at all is not live, a model that says it has been disposed is not live, and a model that cannot answer the question is treated as live.
- `src/modules/terminal/ghostty/TerminalAccessibleOutput.tsx`, `src/modules/terminal/TerminalPane.tsx`: that question is asked before the model is subscribed to, and before it is drawn from at all, so a session that let go of its model between a render and an effect cannot throw out of that effect. The same question replaces the check the accessible output already made while updating its text.

**A disposed session tells the interface its model is gone**

- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts`: handing back a session's resources now also tells the surface that was drawing it that the model is gone, on all three paths that dispose a model, including the one that gives up on a session that never started.
- `src/modules/terminal/ghostty/disposeSessionResources.test.ts` (new): that the teardown hands back each part and says so, and that it holds up for a session that never got as far as having a model or a surface.

**A probe: what a folder's context menu offers**

- `scripts/dev/probes/explorer-agent-menu.mjs` (new): right-clicks a row in the file tree for real - a synthesized `contextmenu` is not what a menu listens for - and reads the menu that was actually drawn, item by item. It tests a folder and a file, and it takes each row's kind from the filesystem rather than from the interface. `--open=<tool>` goes on to click an entry and report the tab it started.
- Measured with it on the installed build: right-clicking a folder offers the agents first, one row of icons above everything the menu used to show, and right-clicking a file offers none of them while every entry it did offer is unchanged. Clicking the pi entry on a folder started a tab named after that folder.

**A folder can be opened with an agent**

- `src/modules/explorer/lib/agentActions.ts` (new): the entries a folder's menu offers for the agents it can be handed to, built from the supported-tools list, so a third agent appears everywhere by being added there. The wording is the same key the local project row already says. A surface that cannot start a session gets no entries at all.
- `src/modules/explorer/FileExplorer.tsx`: right-clicking a folder offers those agents as one row of icons at the top of its menu, the same shape and the same table the local project row uses. A file gets none. A surface with no way to start a session draws nothing here.
- `src/app/App.tsx`: picking one starts a session whose directory is that folder and whose title is its own name, in that folder's own env, by the same command path the local project row sends - so a folder in WSL starts its agent in its distro rather than on the local filesystem, and a path that cannot say which it is keeps the window's own answer.

**The launcher's grouping button names the mode rather than the verb**

- `src/modules/i18n/messages.ts`: that button reads `agent` where it read the Chinese label for "by agent", and `Agent` where it read `By agent`. It is a toggle that shows which of the two arrangements is in force.
- `src/modules/launcher/components/LauncherPanel.tsx`: the comment beside it names the mode the same way.

**A session's token count reads in thousands, in both languages**

- `src/modules/launcher/lib/sessionStats.ts`: the middle band of the token count is thousands now rather than the Chinese myriad, so 170,000 tokens read as `170K tokens` rather than as `17.00k tokens`. `src/modules/i18n/messages.ts`: that band is one label in both languages, so the row says the same number whichever language it is drawn in.

**A probe: what the session list's running light is doing**

- `scripts/dev/probes/marquee-state.mjs` (new): reads the light a session row draws - the bar's own colour, the colour of the part that moves inside it, and that part's animation name, timing and play state - beside the window's two markers and the dot the tab strip draws for the same session. The part that moves is a child of the part that carries the marker, and the rules that stop and start it are selected by an attribute on `<html>`. `--expect=focused|unfocused|hidden` checks the reading against the state the window was in and exits non-zero when they disagree.
- Measured with it on the installed build: the bar is 24x4 with its colour held back for the track and carried whole by the sweep, which steps through `verta-marquee` in 16 steps. All three colours are drawn - a question sky `oklch(0.685 0.169 237.323)`, work in flight orange `oklch(0.705 0.213 47.604)`, an agent at rest emerald `oklch(0.696 0.17 162.48)` - and every row's colour is the colour its own tab chip draws for the same session. With the window merely unfocused the sweep runs; with the window out of the way it stops outright. And on the tray: with the window in front a turn that ended on another tab put nothing in Windows' store and nothing on the icon, while with the window out of the way the same turn put exactly one notice there (titled with the session) and a sixteen-pixel green dot on the icon. A question asked with the window out of the way still says which question it is.
- The probe's own checks: the stepped timing is only required while the animation is on (`animation: none` drops the timing function back to its initial value), the play state is not counted (`animationPlayState` stays `running` once the animation has been switched off), and the colour check allows the one collision the vocabulary asks for - a turn that has just ended beside an agent sitting at its prompt - while a genuine drift in the table is still caught.

**Only a window nobody can see counts as the user being away**

- `src/app/App.tsx`: the set of leaves being looked at is emptied when the window cannot be seen, rather than when it has no focus, so a turn ending on another tab with the window in front of the user is drawn on that tab and is not news.
- `src/app/hooks/useTrayStateDot.ts`: the icon's dot asks the narrower question too, so the icon says nothing about what was on screen while the window was up.
- `src/app/hooks/useAgentNotifications.ts` and `src/app/hooks/useAgentAttentionFlash.ts`: both ask whether the window can be seen before they interrupt. Both read the window's own marker, and both record a wait they deliberately did not announce, so that closing the window later does not announce it then either. Their rules are untouched.
- `src/app/hooks/useAgentNotifications.test.ts`, `src/app/hooks/useAgentAttentionFlash.test.ts`: each pins the question its hook asks, read as text the way the motion budget test reads the stylesheet.
- `src/app/hooks/useTrayStateDot.test.ts`: the snapshot of what is already waiting, which is what makes news mean news, and the two questions pinned apart as text, the way the motion budget test reads the stylesheet.

**The session list marks a state with a running light**

- `src/modules/launcher/components/SessionList.tsx`: a row draws a bar with a highlight crossing it in the state's own colour, instead of the dot the tab strip draws, and only where there is an agent.
- `src/modules/terminal/AgentStateDot.tsx`: a second drawing of the appearance tables rather than a second set of them, so the bar, the highlight crossing it and the dot all take their colour from one table and the test beside it fails if any of them drifts. `src/modules/terminal/index.ts` exports the new one. The tab strip and the header badge keep their breathing dots unchanged.

**An agent at rest is green, and green no longer says whether it was looked at**

- `src/modules/terminal/AgentStateDot.tsx`: three colours over four states. A question is blue, work in flight is orange, and an agent that is neither - a turn that has just ended, or one that has been sitting at its prompt - is green, and stays green until the next turn starts. The colour a state is drawn in is one exported table with the classes written out beside it, and the test beside it keeps the two in step. The ending latch still exists and still drives the tray icon and the notifications; it is no longer what the dot is coloured by.
- `src/modules/terminal/agentStateAppearance.test.ts` (new): the colour of each state, that only three exist, and that every state is drawn as an indicator that breathes.

**A window that can be seen keeps its indicators moving**

- `src/styles/globals.css`: what stops a state indicator is being unseen, not being unfocused. `data-window-hidden` - the window hidden, minimized or fully occluded - stops them outright; a window that is merely unfocused keeps them running. Everything else in an unfocused window still pauses. A new `verta-marquee` keyframe and its class give the session list a highlight crossing a bar, repeated with the stepped timing the motion budget requires.
- `src/styles/motionBudget.test.ts`: the two markers' rules pinned apart from each other, with the running light pinned as stepped and as stopped under reduced motion, and the marker pinned as reaching the indicator's descendants rather than only the indicator.

**Nobody can see the window is its own answer, separate from the window having no focus**

- `src/modules/theme/windowActivity.ts`: the window now publishes two markers where it published one. `data-window-inactive` keeps its meaning exactly - unfocused, hidden or occluded, and the switch every CSS animation pauses on - and `data-window-hidden` is new: nobody can see the window at all. The narrower one is what the tray, the notifications and the set of leaves being looked at now ask. `src/modules/theme/WindowActivityBridge.tsx`: carries the hook for the new marker beside the hook for the old.
- `src/modules/theme/windowActivity.test.ts`: both derivations pinned on their own, the two markers going up and down separately over one sequence of inputs, and the unseen listeners hearing only about their own transitions.

**A question that leaves the screen is not a turn that ended**

- `src/modules/terminal/lib/agentJudge.ts`: an ending is kept for a working turn only. A question that goes quiet - the card answered, dismissed, or taken back by the agent - is reported as rest rather than as an ending, both in the state the judge reaches from the screen by itself and in the one it reaches when the screen stops naming an agent at all, which latches nothing and announces nothing.
- `src/modules/terminal/lib/agentJudge.test.ts`: a card that goes idle and one that leaves the screen entirely are both expected to report rest rather than an ending.

**A window is named exactly, not by substring**

- `scripts/dev/probes/eval.mjs`: a `--match` that ends in a slash names a window exactly rather than matching a substring of its URL. Partial names still match as substrings.
</details>

<details>
<summary><strong>2026-10-27</strong></summary>

**The tray dot comes off when the window is looked at**

- `src/app/hooks/useTrayStateDot.ts`: what is painted on the icon, and what was already waiting the last time the window was looked at, are held across the effect's runs instead of inside one of them; looking at the window now takes the dot off.
- Corrected: the tray is now measured by scanning the whole strip.

**The two panes of the projects tab put their controls on the same line**

- `src/app/components/WorkspaceSurface.tsx`: the inset both panes sit inside is written once and used by both, so the local-projects pane no longer carries the extra `pt-1` and the two filter rows start at the same offset.

**An ending is news only until it has been looked at, and an agent at rest is orange**

- `src/modules/terminal/lib/agentActivity.ts`: a second latch beside the one for waiting - a turn that ended while the user was not on that tab. The dot goes back to orange the moment the tab is looked at, or as soon as the next turn starts there. Cleared by the same tick that clears the waiting latch, and dropped with the session.
- `src/modules/terminal/AgentStateDot.tsx`: two states, one colour. An agent with a turn in flight and one sitting at its prompt are both orange and say which they are in their label; blue is a question, and green is an ending that nobody has looked at. A fourth state is drawn again rather than folded away: a session that has only been opened is not drawn as one that just finished.
- `src/modules/tabs/lib/tabAgentStatus.ts`, `src/modules/launcher/lib/sessionActivity.ts`, `src/modules/launcher/components/LauncherPanel.tsx`: the latch travels with the rest of the store slice into both folds, so a tab chip and a session row say the same thing about one session.
- `src/app/hooks/useTrayStateDot.ts`: the icon's dot is read from those two latches and only while the window is out of the way - a question nobody has looked at, or a turn that ended while nobody was there - and it goes quiet as soon as the window is in front, which is what clicking the tray does.
- `src/app/hooks/useTrayStateDot.ts` again: what counts as news is what arrived *after* the window was last being looked at. Bringing the window up clears the icon, and a session the user never got round to visiting does not light it again the next time the window goes out of the way. A session that does either thing while the window is in front is not news for the icon.

**The judge believes an ending only once the screen has stopped working**

- `src/modules/terminal/lib/agentJudge.ts`: a screen that stops showing work is no longer reported as an ending on the first read - the state has to hold for a few reads first (`IDLE_SETTLE_MS`, three ticks).
- `src/modules/terminal/lib/agentRules.ts`: opencode's working rules gained the footer's own interrupt hint (`⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt`), and its count of shells that are still running, both read from the footer line alone. A footer with neither reads idle exactly as before, and the idle rule now also refuses any screen that says the turn can be interrupted.
- `src/modules/terminal/lib/agentRules.test.ts`, `src/modules/terminal/lib/agentJudge.test.ts`: the captured screens kept verbatim, and the settling pinned: one missed frame reports nothing at all, a settled idle reports `finished` rather than `idle`, and a question is still reported on the read it appears in.

**A recorder for the state dots, and the screen behind each verdict**

- `scripts/dev/probes/state-dot-watch.mjs` (new): records every detector signal with the millisecond it arrived, every change to the store's phases, agents and latch, and every change to each tab's and each launch-list row's own dot as its computed colour, opacity and animation state. It also records the judge's verdict on every screen it can identify an agent from, with the rule that won and the rows that rule read. Entries are streamed out one at a time rather than collected into a single long evaluation.

**An opened pi session is not a starting one**

- `src/modules/terminal/lib/agentRules.ts`: the rule that reads pi's startup banner as work stops matching once pi's own status line is on screen - once its token counters with their arrows are drawn. A session still starting shows the banner and counters at zero with no arrows at all.
- `src/modules/terminal/lib/agentRules.test.ts`: the captured screen of a starting session still reads as work, and the live screen of an opened one reads as idle.

**An unfocused window keeps its state dots legible**

- `src/styles/globals.css`: the three state dots stop breathing outright while the window is not being looked at, instead of being paused along with every other animation. Stopped instead, they are solid, and an unwatched window still costs no frames.
- `src/styles/motionBudget.test.ts`: pins that exception, beside the one a closing layer already has.

**Measured on the screen: the three colours, the tray's two, and the tools that read them**

- Measured in development, reading the strip's own computed style rather than its classes, with the same pi screens the judge's tests are built from: work in flight is `orange-500`, a question is `sky-500`, a turn that has ended is `emerald-500`, all three carry the breathing animation with its stepped timing and running, and a fourth state does not exist - the screen that used to draw a quiet dot now draws the green one, and a session with no agent on it draws nothing at all. The header badge shows the waiting count and draws that one dot; nothing on the screen counts sessions that are merely working.
- The bar that marks a question the user has not looked at yet is the same blue as the dot that means a question, and it clears when the session is brought in front while the dot stays blue.
- `scripts/dev/probes/tray-attention.mjs`: a stage for the other colour the icon can carry - the window in the tray and the session's turn simply ending, with nothing asking - and its measured result: 16 pixels of `emerald-500` while nothing of Verta is on the screen, then 16 of `sky-500` with a question instead, and zero pixels of red or amber either way.
- `scripts/dev/probes/eval.mjs`: without `--match` it now picks the window that *ends* in the development server rather than any window that contains it.
- `scripts/dev/probes/tab-agent-dot.mjs`: reads the colour and the breathing as computed style as well as the classes; its steps are named after the three states; and it makes the directory it writes its screenshot into.
- `scripts/dev/probes/tab-agent-unseen.mjs`: reports the unseen bar's colour as well as that it is there.
- `scripts/dev/probes/state-dot-watch.mjs`: a single reading as well as a watch (`--once`), for the case nobody can drive - what the screen looks like when the session is not being used - and the raw bottom rows beside the filtered ones. It also records the ending latch, which is what the green dot is made of.

**A session has three states, they breathe, and the tray says the same two things**

- `src/modules/terminal/AgentStateDot.tsx`: a session has three states and no fourth - work in flight is orange, a question it is waiting on is blue, a turn that has ended is green - and all three breathe. One component draws all of them, so an icon, a tab and a session row can never describe one session two different ways.
- `src/styles/globals.css`: the breathing animation, stepped like every other forever-running one in this stylesheet (the motion budget), and switched off under reduced motion along with the rest.
- `src/modules/terminal/lib/agentActivity.ts`: the fold that decides a tab's state drops the fourth, quiet one, and such a session keeps its agent's name so the tab keeps the brand icon. The counter the old tray dot used goes with it.
- `src-tauri/src/modules/tray.rs`: the tray dot carries one of those two colours - blue while some session is asking, green once some session's turn has ended - and the red is gone. The icon is repainted only when the answer changes.
- `src/app/hooks/useTrayStateDot.ts` (new; replaces `useTrayAttentionDot.ts`): derives that answer from the sessions the store knows, a question outranking an ended turn and nothing at all while everything is only working.
- `src/modules/header/AgentActivityBadge.tsx`: the count of sessions working is gone. The count of sessions waiting stays, and draws the same dot the tab does.
- `src/modules/tabs/TabChip.tsx`: the bar that marks a question the user has not looked at yet is the same blue as the dot that means a question.
- `src/modules/terminal/index.ts`: exports the state dot, which the header badge now draws rather than copying its classes.

**A notification reads the session's own screen, not one leaf's**

- `src/modules/notifications/lib/attentions.ts`, `src/app/hooks/useAgentNotifications.ts`: the question a notification carries is read from whichever of the session's leaves still has a screen, the leaf the session is drawn in first.

**A wait flashes the taskbar once, and it is judged by its latch**

- `src/modules/terminal/lib/agentActivity.ts`: the shared flash rule takes the latch itself instead of a yes/no about whether there is one, and a wait answers to it rather than to the phase changing. Telling one wait from the next, and acting on each exactly once, is left to the caller, which is the one that remembers the latch it has already acted on.
- `src/app/hooks/useAgentAttentionFlash.ts`: the hook remembers the wait it has already flashed, so a session blocked for minutes flashes the taskbar button once rather than on every store write.
- `src/modules/notifications/lib/notificationRule.ts`: passes the new argument when it reads the shared rule for the "a turn finished" case.

**A toast reads the question out of the card**

- `src/modules/notifications/lib/attentions.ts`: the excerpt a waiting notification carries is the card's own question line rather than the last few rows joined together, and the user's own shell is no longer read as the agent's words. The first question in the bottom region wins, and the excerpt is that card's question line rather than the options or key hints printed under it.

**A wait is announced from its latch, not from its phase changing**

- `src/modules/notifications/lib/notificationRule.ts`: a wait is announced from the store's latch rather than from the phase changing. A question asked in a session nobody is looking at puts a notification into Windows' own store under the app's identity, with the question itself as its body.

**The waiting dot is small and red**

- `src-tauri/src/modules/tray.rs`: the waiting dot on the tray icon is half the radius it was and Tailwind `red-500` instead of the amber the in-app markers use. Its test now also pins that the dot stays in its corner.

**The window tells the app when it goes to the tray, and the installer registers the app with the shell**
- `src-tauri/src/modules/window_presentation.rs`: a window that has been hidden is now part of the same report the terminal renderers use, and the Rust side says so when the close button sends the window to the tray and when the tray brings it back. It works on every platform.
- `src-tauri/src/lib.rs`: the window's close-to-tray path, and the tray's own "show" path, report that change; the page can also report a hide or show it performed itself (`src/modules/terminal/ghostty/windowPresentation.ts`, `src/modules/control/useControlBridge.ts`).
- `src-tauri/installer-hooks.nsh`: the installer registers the app's identity with the shell, and the uninstaller removes it; the Start Menu shortcuts already carried the identity. The identity is in place for the name and icon a toast is drawn with.
- Measured, three times over, on the installed build: sending the window to the tray the way its close button does makes the app report itself inactive and empties the set of sessions it counts as being looked at, then a question written into the session the user had left open is latched as unseen with the bell counting it and the tray icon carrying the dot (69 amber pixels in the measurement box); bringing it back the tray's way clears all of that.
</details>

<details>
<summary><strong>2026-10-26</strong></summary>

**A question asked while the window is in the tray is not lost**

- `scripts/dev/probes/tray-attention.mjs` (new): the window is focused, put in the tray, and only then is pi's question written into the session that was last in use; the probe reads back what noticed - the tab's marker, the latch behind the bell, the bell itself - and the tray dot is read off the screen with the picture tools. A second stage is the counter-case (same question, window in front, that tab active: read, but not announced), and a third brings the window back and clears up. The notification itself cannot be shown: Windows shows none for a development build (measured).
- Measured, in that order: with the window in the tray and the question asked on the last tab, the wait is latched (`unseen` has it, the bell counts 1) and the tray icon carries 69 amber pixels while nothing of Verta is on the screen; the same question with the window in front latches nothing and leaves the bell empty; bringing the window back clears the latch, the bell and the dot, and the probe's tab closes with the user's own tab back in front.
- Also measured: the renderer keeps its cadence in the tray (86 beats over 21 seconds of hiding, median gap 251ms, worst 260ms, ~50 frames a second) and paints again after being shown - a tab opened right after the window came back is drawn in full.

**The tray icon says when something is waiting**

- `src/app/hooks/useTrayAttentionDot.ts` (new): the waiting dot on the tray icon. It stands for the same latch the bell's list is built from - a session waiting on the user that has not been looked at - and the store is read only when the answer changes, so a judge tick does not repaint the icon. Looking at the wait takes the dot away, and so does turning the switch off.
- `src/app/App.tsx`: the dot runs with the same switch as the notification layer; the in-app surfaces (the tab's marker, the bell, the header's count) stay on whatever they are set to.
- Measured on this machine, with the dot's own command never called by hand: a question asked in a session left behind another tab takes the tray icon from no amber at all to 69 amber pixels in the same 9x9 box the manual paint put them in, and looking at that wait takes it back to none.

**System notifications, and a click that goes back to the session**

- `src/app/hooks/useAgentNotifications.ts` (new): the notification layer. It watches the activity store's phases, asks the rule below what a change is worth, and sends one system notification whose body is the question at the bottom of that session's screen; each wait is announced once. The click is listened for before anything is sent, since the plugin only routes a click when a listener exists at the time the notification is made, and a click raises the main window and goes to the tab the session is drawn in now. A refused permission, a failed send and a failed click are each a log line.
- `src/modules/notifications/lib/notificationTap.ts` (new): what a click carries - the session it is about, read strictly out of the payload that was stored with the notification. That payload crosses a JSON boundary, so an id which comes back as anything but a number is refused rather than read as 0.
- `src/modules/notifications/lib/attentions.ts`: where a session is drawn right now, taken from the leaf-to-pty mirror rather than from the latch, so a notification clicked after its wait was already looked at still lands on the session it named. Its leaf comes along because the body of a waiting notification is the screen under it.
- `src/app/App.tsx`: the layer runs with its preference, and its jump is the same tab selection the tab strip uses.
- `scripts/dev/probes/notification-tap.mjs` (new): the measurement in development, where the notification itself cannot be seen - a burst of six of them puts nothing on the screen, because Windows only shows an installed app's notification, and the plugin's click arrives through a channel in Rust that a page cannot feed. What it does show: a session left waiting behind another tab is read by the judge (its dot), is latched as unseen (the bell lists it and counts it, and looking at it clears both), the send path fails at nothing, and the command a click calls to bring the window back is wired.

**The notification plugin, and the switch that turns it on**

- `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`: the official notifications plugin, registered the way the others are and carrying the permission its commands need, plus its frontend package (`package.json`). Nothing sends a notification yet.
- `src/modules/settings/store.ts`, `src/settings/sections/GeneralSection.tsx`, `src/modules/i18n/messages.ts`: the preference behind that plugin - on by default, with its own switch beside the taskbar reminder in the Windows-only part of General, and both wordings plus the two toast strings. Turning it off stops both surfaces it drives (the notification and the tray dot) and leaves the taskbar flash exactly as it was set. Checked on the machine: the row is in General with that wording, starts on, and flips.
- `scripts/dev/probes/eval.mjs`: can be pointed at any of the app's windows now (`--match=settings.html`), not only the main one.

**A waiting dot on the tray icon**

- `src-tauri/src/modules/tray.rs`: the tray icon's waiting dot and the two commands behind it - one that paints the dot onto the app's own window icon (or clears it back) and hands the result to the shell, and one that brings the main window back the way a click on the tray icon does, which the page calls when a system notification is clicked. The dot is drawn at run time onto the icon's RGBA, so there is no second icon asset to keep in step with the first, and its colour is the amber the tab's marker and the bell's count already use. Measured on this machine: the tray area carries no amber at all before, 69 amber pixels in a 9x9 box on the icon's top-right with the dot on, and none again once it is cleared.
- `src-tauri/src/lib.rs`: the two new commands.
- `scripts/dev/probes/png-count-color.ps1` (new): count the pixels of one colour inside a region of a screenshot, with the box they fall in. A badge on a tray icon is a few pixels in a picture thousands of times its size, so the region's dominant colours do not move when it appears, and counting the colour settles "is the dot there" and "is it gone again".

**A window that is not in front is not being looked at**

- `src/app/App.tsx`: which sessions count as looked at is the active tab's leaves, and none at all while the window is not in front. Measured before wiring it: hiding a focused window tells the app within 40 ms. A wait that starts while the window is behind latches, which is what the tab's marker, the bell's list and the two notification layers all read, and when the user comes back the same tracker clears it within a judge tick. The bell's list and the header's count include waits that started while the window was in the background.
- `src/modules/terminal/lib/agentActivity.test.ts`: the store's meaning pinned - with no leaves in front at all, a wait on the active tab still latches.

**Which phase changes are worth a system notification**

- `src/modules/notifications/lib/notificationRule.ts` (new): the whole decision of what a phase change is worth telling the user about - a question an agent is waiting on that the user has not looked at, and a turn that stopped painting work while the window was not in front. It is built on the taskbar flash's own rule, so the two cannot disagree about what a change means; it adds that a toast is a real interruption and that the store's latch is what says whether this is the same wait as the one already announced or a new one.
- `src/modules/notifications/lib/notificationRule.test.ts` (new): those decisions, including a wait that is announced once and not again, and a turn that ends in front of the user.

**A window hidden in the tray does say that nobody is looking at it**

- `scripts/dev/probes/renderer-throttle.mjs`: every tick now also stamps `data-window-inactive`, the app's own answer to "is anyone looking at this window?", and the transition list keys on it as well. Measured with the window in focus (obtained the one way Windows grants it, by asking right after showing the window): hiding it reports the focus loss to both of the app's sources within 40 ms - `dom-blur` at +24 ms, the window's own focus event at +39 ms - and the attribute goes true; showing it again brings both back.
- A process that is not in front cannot put itself in front on Windows: `set_focus` is honoured only right after the window has been shown, and another window's console takes it back within about a second.
- `scripts/dev/probes/eval.mjs` (new): run one expression in the app's own page - what the DOM says right now, or one of the app's own Tauri commands. Calling a command from the page works exactly as the app calls it.
- `scripts/dev/probes/click-desktop.ps1` (new): click one point of the desktop with real input, the only way a script can bring a window forward, and what the notifications acceptance clicks a toast with, since the web view does not draw it.
- Recorded and not changed: the tracker starts out assuming the window is being watched and is corrected by the first focus event it is told about.

**The renderer keeps its cadence while the window is hidden in the tray**

- `scripts/dev/probes/renderer-throttle.mjs` (new): a recorder bolted onto the running page stamps a `setInterval`, a `requestAnimationFrame` counter, the document's visibility and the state dot the strip draws; the stages hide the window, show it again, feed the judge one of pi's captured screens while it is hidden, and read the log back. Measured with the window hidden (`isVisible` false, read back from Rust): the interval keeps its exact cadence - 162 ticks in 40.2 s, median gap 251 ms, worst gap 265 ms - and painting continues at 33 fps, because hiding a window does not tell the WebView2 it is hidden (`document.visibilityState` stays `visible`). A screen fed into a terminal while the window was hidden still moved that tab's dot from `working` to `attention`, so the notification layer does not need a Rust-side timer.
- Recorded and not changed: a pane that has never been painted starts no terminal session at all (no pty, no size), and a window that another window covers is never painted; a tab opened in that state stays empty until the window is raised and painted once.

**The close guards and the taskbar flash ask the screen, not the process list**

- `src/modules/terminal/lib/agentActivity.ts`: `isLeafAgentBusy` (whether the agent on a leaf is working or waiting on an answer, read from the activity store) and `flashForPhaseChange` (the taskbar flash's whole decision, as a pure function so it can be tested).
- `src/app/hooks/useAppCloseGuard.ts`, `src/app/hooks/useTabCloseGuards.ts`: a terminal counts as running when its agent is busy on screen, checked before the shell's "has a child process" query is asked at all; that query is still asked afterwards, since a command typed into a plain shell is something it does see.
- `src/app/hooks/useAgentAttentionFlash.ts`: the flash reacts to the store's phases instead of polling. `finished` is the judge reporting that an agent which was working has stopped, and `attention` (while the user has not looked at it) is a question it is waiting on.
- `src/modules/terminal/lib/agentAttention.ts` (removed, with its test): the silence heuristic is gone.
- `src/app/App.tsx`: the opening cover no longer consults the process query, not even for its byte-count fallback.
- `src/modules/terminal/lib/agentRules.ts`: two more pi rules, both captured live - pi's `Startup is still in progress` line, and its banner, which is the window before that. The judge read both as an agent sitting idle at its prompt.
- `src/modules/terminal/lib/agentActivity.test.ts`, `src/modules/terminal/lib/agentRules.test.ts`: the two new decisions and those two screens.
- `scripts/dev/probes/agent-lab.mjs`: stages for this - the app's own phase and dot (`--stage=state`), a click on the active tab's close button (`--stage=close`), and the same click with the guard's preference turned on, read and turned back (`--stage=close-guarded`).
- `scripts/dev/probes/crop-png.ps1` (new): cut one region out of a screenshot, for looking at chrome the web view does not draw.

**pi sessions now have a state: idle, working, and waiting on you**

- `src/modules/terminal/lib/agentRules.ts`: pi's identify pattern and its rules, written from live screens captured on this machine in **both** configurations (as the user runs it, and with `--no-extensions`). The family is identified by the pair of full-width rules pi draws around its input, the only bottom-of-screen signal the two configurations share (they agree on no footer string at all: `(auto)` against `AC`, different token counters, different model lines); it does not match the working label, which a whimsical extension generates. Work is a spinner frame in those rules (braille without extensions, the extension's own set with them), waiting is the `ask_user` card's option rows and key hints. No approval rule is written: a destructive command ran without a prompt.
- `src/modules/terminal/lib/agentRules.test.ts`: the captured screens for idle, working and waiting on the user, in both configurations, plus the counter-examples that keep them from over-firing (a shell that printed an ASCII separator line, a prompt echo that names the question tool, an answer that contains the word the bare interface uses for work).
- `scripts/dev/probes/agent-lab.mjs` (new): opens a terminal of its own, walks it to a scratch directory, starts an agent with whatever flags it is given, records every distinct screen frame with the millisecond it appeared while the caller types at it (`--stage=say`, `--stage=key`), writes the whole screen verbatim (`--stage=dump`), and reads back what the app's own judge decided, phase and dot (`--stage=state`).

**The session list says which of its sessions is running, and lifts the ones waiting on you**

- `src/modules/terminal/AgentStateDot.tsx` (new): the state dot, its four colours and its wording, lifted out of the tab strip so the session list can draw the same mark.
- `src/modules/tabs/TabChip.tsx`: draws that shared dot instead of its own copy of the colours and the labels.
- `src/modules/tabs/lib/useTabs.ts`, `src/modules/tabs/lib/serialize.ts`: a terminal tab records the session it resumed (`sessionId`), and the value is stored and restored with the tab. Nothing else about the tab changes.
- `src/modules/launcher/lib/sessionActivity.ts` (new): joins the stored sessions to the live activity store through the tab that resumed them (the store is keyed by pty, the list by session), folds a session's panes with the same rule the tab strip uses, and lifts the sessions that are waiting on the user to the top - within the section they belong to, and stably, so nothing else moves.
- `src/modules/launcher/components/LauncherPanel.tsx`, `src/modules/launcher/components/SessionList.tsx`: the panel reads the activity maps, marks each running row with its dot, and orders the list waiting-first. The order is left alone while rows are being picked for deletion, and the row carries `data-session-id` the way a tab carries `data-tab-id`.
- `src/app/App.tsx`: opening a session from the list hands its id to the new tab, and the panel is given the tabs it resolves the ids against.
- `src/modules/launcher/lib/sessionActivity.test.ts` (new): the join (a session split across two panes, two tabs opened for one session, a tab that is not a resumed session, a tab whose leaves have no pty yet) and the ordering (stable elsewhere, untouched when nothing is waiting).
- `scripts/dev/probes/launcher-session-state.mjs` (new): opens a session from the list and reads the list back at each step - the dot while the agent works and the row staying put, the amber dot and the row moving to the top when it starts waiting, the rest of the order unchanged, then closes its own tab and puts the user's tab back.

**The opening cover waits for the agent's own screen, not for a byte count**

- `src/modules/terminal/lib/launchLine.ts` (new): "is the command we wrote still on the screen", read from the leaf's own screen text with the whitespace squeezed out, so a line the shell wrapped still matches.
- `src/app/App.tsx`: the cover lifts once the leaf's screen holds the agent's own content and no longer holds the launch line, or once the leaf has moved to the alternate screen. A byte threshold alone is satisfied by pi's banner - several kilobytes painted on the normal screen while the command line sits above it - so the byte rule is kept only for a screen that cannot answer. The shell's own "has a child process" query is not used here: Windows records a process's parent when it is created, and an agent started through a launcher that exits immediately is recorded against a pid that no longer exists.
- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts`, `src/modules/terminal/lib/terminalSessionApi.ts`, `src/modules/terminal/index.ts`: the alternate-screen accessor the above needs.
- `src/modules/terminal/lib/launchLine.test.ts` (new): the echoed line, a line the shell wrapped, the banner that arrives below it, the agent's own screen, and a tool's name mentioned in the middle of a row.
- `scripts/dev/probes/agent-screen-takeover.mjs`, `scripts/dev/probes/session-opening-lift.mjs`, `scripts/dev/probes/terminal-shot.mjs`, `scripts/dev/probes/process-tree.ps1` (new): what an agent does to the screen second by second, what is on screen the instant the cover goes, a picture of the pane printed beside the model's own text for the same leaf, and the process list with a marker for a recorded parent that is not among the running processes.

**The opening transition really hides the terminal now**

- `src/modules/terminal/TerminalStack.tsx`: the area the window's shared render canvas lives in is hidden together with the panes while the opening transition covers them; the GPU renderer draws a pane into a canvas that sits *next to* those containers rather than inside them.
- `scripts/dev/probes/terminal-pixels-where.js` (new): prints where the terminal's pixels actually live and what is hidden at the time. `scripts/dev/probes/session-opening-frames.mjs` (new): clicks a session in the list and photographs the terminal area every 250 ms, keeping the frames the transition was up for. Measured on the terminal area's top strip while the animation was up: a luma delta of 164 before (the prompt and the command) against 4 after (the pane's own surface).
</details>

<details>
<summary><strong>2026-10-25</strong></summary>

**The input method's candidate window opens at the cursor**

- `src/modules/terminal/ghostty/input/inputPlacement.ts` (new): which cell of the grid the terminal's hidden input belongs on, clamped to the grid and never a box with no size.
- `src/modules/terminal/ghostty/input/inputPlacement.test.ts` (new): the cursor's own cell, a cursor off the grid, a fractional cursor and a nonsense one, and a grid that has no cells yet.
- `src/modules/terminal/ghostty/webgl/WebGlTerminalSurface.ts`, `src/modules/terminal/ghostty/gpu/WebGpuTerminalSurface.ts`: both surfaces move the hidden input onto the cursor cell on every frame, and write the style only when the cell changed, so an input method's candidate list opens at the cursor rather than at the pane's top-left corner. The GPU surface also subtracts the shift the drawn grid carries while a resize gesture is in flight.

**A layer that floats over the interface is tinted glass, like a pane**

- `src/styles/globals.css`: the `verta-float` rule: the tint is `--popover` at the theme's pane opacity, so a menu reads as a tinted layer rather than a solid slab and the theme's opacity setting moves panes and menus together. No blurred layer: alpha blending costs no backing store, while a blur costs one and is reallocated on every window-resize step.
- `src/components/ui/dialog.tsx`, `src/components/ui/popover.tsx`, `src/components/ui/dropdown-menu.tsx`, `src/components/ui/command.tsx`: the class on the layers that float, both dropdown menu content variants included, instead of painting `--popover` at full opacity.
- `VERTA.md`: the compositing budget bullet names the floating layers' tint as the exception to opaque popovers.

**Fit to window scales the picture to the pane, up as well as down**

- `src/modules/editor/EditorPane.tsx`: the picture viewer watches the room it has with a `ResizeObserver` and hands the fitted size to the picture itself, so fitting fills the pane in both directions instead of stopping at the picture's own size. The fitted rectangle is floored and clamped to that room, so a rounding error cannot push the picture past the pane and raise a scrollbar, and the checkerboard stays inside the picture rather than covering the pane around it.

**The repository settings dialog's fields are all the same height**

- `src/modules/remotes/RepoAdminDialog.tsx`: the rename and description fields take the height and text size the dialog's other fields and its sibling dialogs already use, instead of the shared input default (36px, 36px, 28px across the dialog's three fields).

**A menu opens over a blurred layer, like the command palette**

- `src/components/ui/dropdown-menu.tsx`: every menu opens over the same layer the dialog overlay gives the command palette, a third of black with an 8px blur, with the layer up only while a menu is open. It sits one step below the menu and above the interface, `z-40`, and pointer events pass through; the layer follows the menu's own open state, uncontrolled menus included.
- `src/styles/compositingBudget.test.ts`: the file joins the allowlist.
- `VERTA.md`: the compositing budget bullet records that a menu's scrim is a layer for as long as that menu is up.

**A tab switch no longer re-renders the parts of the window that did not change**

- `src/modules/launcher/components/LauncherPanelLazy.tsx`: the session panel is memoised at its lazy boundary.
- `src/modules/launcher/components/SessionList.tsx`: the list and each row are memoised. A row carries a context menu, a tooltip and the popper layers behind them, which is a dozen Radix components per row.
- `src/modules/launcher/components/LauncherPanel.tsx`: the row-actions object, the row toggle and the rename callback are stable values now, since a fresh object on every render is what a memoised row compares against. The rename callback moved below the refresh it uses.
- `src/components/ui/sonner.tsx`: the toaster is memoised, since sonner reads the document direction with `getComputedStyle` on every render of its own component.
- `src/modules/command-palette/CommandPalette.tsx`, `src/modules/updater/UpdaterDialog.tsx`: memoised, since both are mounted whether or not they are open and both render a dialog's worth of Radix layers when they render.

**A popover opens over the same blurred layer a menu does**

- `src/components/ui/floating-scrim.tsx` (new): the layer a floating surface sits on, extracted from the menu so menus and popovers share one recipe: a third of black with an 8px blur, `z-40`, pointer events passing through, and up only while the surface is.
- `src/components/ui/popover.tsx`: every popover mounts that layer, so the commit card in the commit graph no longer reads as a small slab pasted onto the interface. Its open state is mirrored the way the menu's is, so controlled and uncontrolled popovers both drive the layer, and the layer is placed inside the popover's portal so it leaves with it.
- `src/components/ui/dropdown-menu.tsx`: the menu's own copy of the layer is gone; it mounts the shared one.
- `src/styles/compositingBudget.test.ts`: the allowlist entry moves from the menu file to the shared layer file.
- `VERTA.md`: the compositing budget bullet records the scrim as a menu's and a popover's, not a menu's alone.

**The commit history and commit diff pages take the pane's tint instead of a solid sheet**

- `src/modules/git-history/GitHistoryPane.tsx`, `src/modules/editor/GitDiffPane.tsx`: neither page paints `bg-background` on its own root any more, so in a glass theme the acrylic shows through them the way it does through the explorer, the source-control panel and the editor. The pane supplies the colour (`--background` when the theme is opaque, its tint when the theme asks for glass), so nothing changes for an opaque theme.

**A pane reporting the same state again no longer rewrites the tab list**

- `src/modules/tabs/lib/useTabs.ts`: `updateTab` applies its patch through a new `applyTabPatch`, which hands the same tab back when the patch changes nothing, so the tab list keeps its identity; `focusPane` and `focusNextPaneInTab` take the same rule. `setLeafCwd` already carried it.
- `src/modules/tabs/lib/applyTabPatch.test.ts` (new): a patch that changes nothing, one that changes a field, the terminal custom-title reset, the auto-pin when a preview editor turns dirty, and a preview tab's title derived from its url.

**One tab in the strip is one memoised component**

- `src/modules/tabs/TabChip.tsx` (new): a chip is its own component, memoised, holding the trigger, the language menu, the context menu and the in-place rename field, so only the two chips a switch touches render. `showAllLanguages` lives here too, since only the open menu reads it.
- `src/modules/tabs/TabBar.tsx`: the strip maps the new chip and keeps what is genuinely its own: the scroll box, the pill, which chip is being dragged and which one is being renamed. The pointer plumbing is one stable object (`ChipDrag`) whose handlers read the drag ref and the latest callbacks; the tabs' icon types, the drop indicator and the rename field moved to the chip file.
- `VERTA.md`: the tabs bullet names the chip and why it is a component of its own.

**The strip's "+" menu and the status bar stop re-rendering with the window**

- `src/modules/tabs/NewTabMenu.tsx`: memoised. It carries a submenu, its separators and a popper layer per submenu.
- `src/modules/statusbar/StatusBar.tsx`: memoised. Its own inputs (the cwd, the file path, whether the active terminal is private) do not change when the active tab moves between an editor, a picture and a terminal, and its breadcrumb is one item per path segment and its pills carry tooltips.
- `src/app/App.tsx`: the four openers the header is handed are stable callbacks now instead of arrows written in the JSX (`onNewPreview`, `onNewEditor`, the command palette's list opener, the settings window opener).

**The source control panel's header stops re-rendering on every git refresh**

- `src/modules/source-control/SourceControlPanel.tsx`: the branch selector, the ahead/behind counts and the three remote actions are one memoised component (`ScmHeader`) whose inputs are primitives and stable callbacks. The refresh, fetch and pull callbacks read the latest summary through a ref, which gives them a stable identity for the memo; the refresh button's spinner still follows the panel's loading state alone, since the disabled flag also covers a running remote action.

**The dialogs that are mounted but closed stop re-rendering with the window**

- `src/app/components/CloseDialogs.tsx`: memoised. The five close confirmations are mounted whether or not one is pending, and their inputs are the tab list and the pending-close states the close guards own.
- `src/modules/editor/NewEditorDialog.tsx`: memoised, since it is mounted closed and its inputs (whether it is open, the folder it creates in) do not change on a tab switch.
- `src/app/App.tsx`: the new-file dialog's `onCreated` is a stable callback instead of an arrow written in the JSX.

**The cell-pitch probe finds its ruler instead of the shell prompt**

- `scripts/dev/probes/terminal-cell-pitch.mjs`: the ruler is written long enough to wrap, and the row is chosen by which row has the most equally spaced strokes instead of which row has the most contrast, so the prompt on the same row (or the theme's own vertical gradient) cannot be measured in place of the ruler. A candidate row also has to carry real ink. The wrapped continuation row is the clean one, and the canvas-per-column figure the report prints is not the pitch, since the backing store is deliberately wider than the grid. The terminal tab is found by looking for a mounted terminal surface rather than by its label.

**The sheet over an opened session picture follows the theme**

- `src/modules/terminal/ghostty/GhosttyImageOverlay.tsx`: the veil that dims the session behind a picture opened from it is the pane's background at high alpha instead of a fixed 75% black. It is plain alpha, so it stays inside the compositing budget (no `backdrop-filter`), which the probe checks.

**The picture veil is verified without an agent attachment**

- `scripts/dev/probes/image-preview-veil.mjs` (new): the probe raises the veil the way the component does, through React's own dispatcher for the preview hook, found by walking the fiber tree to the overlay by display name and taking the last hook of that component carrying a `dispatch`. What is drawn afterwards is the component's real markup, so what is measured is real: the veil's computed colour, that it covers the pane, that the picture is loaded, that it carries no `backdrop-filter`, and that it is gone once dismissed. The light theme is simulated by writing `--background`, since swapping the theme for real would write the user's settings. Photographs of both themes come out with `--shots`.

**The window geometry the plugin remembers is restored, and what a returned size does**

- `scripts/dev/probes/window-state-restore.mjs` (new): the probe opens a window whose record exists but which has not been created in this session (Settings, whose own builder asks for a height the record does not have) through the header button, measures it and destroys it again, leaving the session as it was. The width and the position come back as recorded, and the height comes back taller, which is tao adding a hidden shadow offset on every `set_inner_size` for an undecorated window that keeps its shadow. Settings is the only window in the app that asks for no `shadow`.
- `VERTA.md`: the Window styling notes record that the restore is a Rust call rather than an IPC command, that the file is written on a clean exit, and the shadow offset a borderless window has to opt out of; the Tauri capabilities note says a plugin that only works from Rust hooks needs no entry.

**The settings window stops growing taller every time it opens**

- `src-tauri/src/lib.rs`: the settings window is created without a shadow on Windows, as the main window already is (`shadow: false` in `tauri.windows.conf.json`) and the screenshot overlay is (its own `.shadow(false)`). tao's `set_inner_size` adds the hidden `window_rect - client_rect` offset back onto the size it is asked to set for an undecorated window that keeps its shadow, and the window-state plugin saves and restores a client size: the file here said `900x1119`, the first open of the session came up `900x1149`, the next one `900x1179`, and the clean exit after that wrote `900x1149` back to the file. With the shadow gone the offset is not added, and the window opens at the height the file holds, repeatedly.
- `scripts/dev/probes/window-state-restore.mjs`: the height has to match the record as strictly as the width does, instead of being allowed to sit an offset above it.
- `VERTA.md`: the Window styling notes say every borderless window opts out of the shadow, and what happens to a window-state restore if one does not.

**The two sentences the other side writes follow the language**

- `src/modules/updater/useUpdater.ts`: the one line the updater itself wrote ("update source not configured yet") is a key now. Errors from the updater or the network ride the same field as the text they arrived as, and the lookup falls back to the key, so one field carries both, the shape `themeFiles.ts` already uses for a parser message.
- `src/settings/sections/AboutSection.tsx`: the failure line resolves that key instead of printing the field.
- `src/modules/lsp/lib/exitReason.ts` (new): the memory-budget sentence the language-server side writes (`session.rs`) becomes a key with its two numbers, read back out of the sentence; anything else, a crash code or stderr text, is shown as it arrived. The pattern is pinned by a test.
- `src/modules/lsp/lib/useLspExtension.ts`, `src/modules/lsp/lib/sessionManager.ts`, `src/modules/lsp/components/LspStatusPill.tsx`: that mapping is handed down with the rest of the copy (the crash and the pill both render outside a hook that has the message table), and the store keeps what the other side said, so a language switch does not need the session restarted.
- `src/modules/i18n/messages.ts`: two new strings, in both languages.
- Verified on the running app for the updater one: this build has no update source, so pressing "check for updates" in Settings > About lands on that path, and the line reads the localized string. The language-server one cannot be raised by hand (it needs a server to exceed its memory budget) and is covered by the mapping's tests instead.

**A saved screenshot carries the app's name, not the word every tool writes**

- `src-tauri/src/modules/screenshot/geom.rs`: a region capture is written as `Verta-<stamp>.png` instead of `Screenshot-<stamp>.png`, since the folder it lands in (`Pictures/Screenshots`) also collects Windows' own captures. The `-2`, `-3` suffix for a second shot in the same second and the `-overflow` fallback are unchanged, and the two unit tests pin the new prefix.

**The path in the status bar collapses by the room it has, not by a breakpoint**

- `src/modules/statusbar/lib/breadcrumbFit.ts` (new): how many of a trail's middle segments fit, from the measured widths of the leading part, the "more paths" button, each middle and the trailing folder or file plus the gap between boxes. It knows nothing about the markup, so it is a pure function with its own test.
- `src/modules/statusbar/CwdBreadcrumb.tsx`: the trail renders the middle segments that fit and puts the rest behind the "more paths" button, decided from that measurement instead of a 768px breakpoint. What a collapsed segment costs is measured from one off-screen copy of every middle segment, since a collapsed segment is not painted and cannot be measured where it would be; the leading and trailing parts come from the row itself. The room is the row's width minus the pills beside the breadcrumb, and the row is watched as well as the list.
- `VERTA.md`: the statusbar note records that the trail's layout is measured, and that the off-screen copy and the row are the two things it reads.

**A hidden window's visibility is something the page can ask about**

- `src-tauri/capabilities/default.json`: `core:window:allow-hide` and `core:window:allow-is-visible`. Closing the main window with close-to-tray on hides it and the tray icon is the whole route back, but a WebView2 page target stays listed for a hidden window and `document.visibilityState` does not change; the two commands make both halves of that route reachable.
- `scripts/dev/probes/tray-return.mjs` (new): the icon answers its labels (that call rebuilds its menu, so it fails when there is no icon), and a hidden main window comes back through the same call a click on the icon makes. The probe invokes what the click and the menu item invoke, and hides and shows in one page turn because the page lives in the window it is hiding.
- `scripts/dev/probes/close-quits.mjs` (new): with a settings window hidden and the main window then closed, the app leaves in 335ms when close-to-tray is off. With the preference on, the same close hides the window and the process stays; the probe refuses to run in that state rather than writing the preference itself. With close-to-tray on, a closed settings window is a hidden one, and a hidden window keeps its page target, so the page list is not how to tell whether anything is on screen.
</details>

<details>
<summary><strong>2026-10-24</strong></summary>

**The terminal cell pitch follows the font, not the pane**

- `src/modules/terminal/ghostty/gpu/TerminalFit.ts`: `gridDeviceSize` states the device-pixel rectangle a grid of cells covers, and the viewport fit takes its pixel size from the same function.
- `src/modules/terminal/ghostty/gpu/TerminalFit.test.ts`: the rectangle is the cells' own and never the canvas', it agrees with the viewport fit the surface sizes the pane with, and it stays a whole number of device pixels per column.
- `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts`: the WebGL renderer draws the grid into its own rectangle instead of the whole canvas, so the GL viewport, the glyph offset and size attributes and the resolution uniform all use the grid, and the cell pitch no longer follows the canvas width. Hit testing, selection and the block overlays were already in font cells.
- `scripts/dev/probes/terminal-cell-pitch.mjs` (new): measures the spacing of a ruler of strokes in a screenshot, once with the sidebar shown and once hidden, and fails when the two pitches differ.

**A working directory that lost its drive letter is never used**

- `src-tauri/src/modules/pty/shell_init.rs`: a working directory is only handed to the shell when it is absolute (a drive or UNC path, or a leading slash), since Windows resolves a drive-less path against whichever drive the app's own process sits on.
- `src/modules/tabs/lib/serialize.ts`: a restored tab drops a stored working directory that no longer fits its environment, and the label still comes from what was stored.
- `src/modules/tabs/lib/serialize.test.ts` (new): drive, UNC and distro paths survive, a drive-less one is dropped, and the label is kept.
- `src/modules/terminal/lib/osc-handlers.ts`: the OSC 7 report puts back the drive letter the URI authority swallowed (`file://HOSTF:/dir`).
- `src/modules/terminal/lib/osc-handlers.test.ts`: the two glued-drive cases.

**The session-start transition belongs to its tab, and it paints no slab**

- `src/app/components/sessionOpening.ts` (new): the transition is up only while the leaf it was opened for still sits in the tab on screen.
- `src/app/components/sessionOpening.test.ts` (new): that rule, including the tab closed right after clicking.
- `src/app/App.tsx`: the transition is held as the leaf it was opened for plus a generation token rather than a bare flag with a blind fallback timer, and the wait ends on the renderer's own painted frame (`whenLeafPaints`) rather than on output bytes.
- `src/modules/terminal/lib/terminalSessionApi.ts`, `src/modules/terminal/index.ts`: `whenLeafPaints` reports when a leaf's surface has presented a frame, with a cap so a stalled renderer cannot hold the transition up for ever.
- `src/app/components/SessionOpeningOverlay.tsx`: `sessionTransitionEnabled` is exported, and the layer paints no background of its own, so the middle of a glass window shows the pane surface instead of a slab.
- `src/app/components/WorkspaceSurface.tsx`, `src/modules/terminal/TerminalStack.tsx`: the panes are hidden with `opacity: 0` while the transition covers them, which leaves the pane surface visible. Hiding them with `visibility` unmounted the renderer's canvas, so the pane came back blank when the transition lifted.
- `src/styles/globals.css`: the near-opaque background rule for the transition layer is gone.
- `src/modules/preview/PreviewPane.tsx`: the preview pane stops laying down opaque backgrounds of its own (the pane, and the sheet behind a loaded page), the same fix the side preview column and the markdown preview already carry.

**The local project list: pick a folder, fetch when checking, and pull one row**

- `src-tauri/src/modules/projects/pull.rs` (new): the refusal rule for a pull, with its tests. A branch is only pulled when its upstream carries the same name, and both the command and the frontend ask that one question; a differently named upstream is refused by naming both branches.
- `src-tauri/src/modules/projects/commands.rs`, `src-tauri/src/modules/projects/types.rs`, `src-tauri/src/modules/projects/mod.rs`, `src-tauri/src/lib.rs`: `projects_status` takes `fetch` and runs a fetch per row first, recording a failure in the new `fetch_error` field; `projects_pull` fast-forwards one project and answers with the branch it pulled.
- `src/modules/projects/lib/pull.ts` (new), `src/modules/projects/lib/pull.test.ts` (new): the same rule in the frontend in message-key form, so a row can disable its button and say why.
- `src/modules/projects/lib/pickDir.ts` (new): the native folder picker, imported lazily so the dialog plugin stays out of the start-up path.
- `src/modules/projects/ProjectsView.tsx`: the two paste-a-path inputs become one Choose folder button, a check fetches first, and every row carries a pull button that names what it would pull, a mark when that row's fetch failed, and a disabled state with the reason when the branch cannot be pulled.
- `src/modules/projects/lib/types.ts`, `src/lib/native.ts`: the wire gains `fetchError` and `projectsPull`, and `projectsStatus` takes the fetch flag.
- `src/modules/i18n/messages.ts`: the pull strings, the fetch warning, the folder picker and the reworded empty hint, in both languages, and the paste-a-path strings they replace.
- `scripts/dev/probes/projects-pull-acceptance.mjs` (new): a lab repository behind its own bare remote, checking that the row reports being behind once the check has fetched, that a differently named upstream is refused both in the interface and by the command, and that the per-row pull then leaves the row clean.

**Both lists gain an owner column, and their columns can be sorted**

- `src/lib/ownership.ts` (new), `src/lib/ownership.test.ts` (new): whether a row belongs to the signed-in account, read from the account name and the repository slug or the folder name; a name that cannot be told apart answers unknown.
- `src/components/ui/sort-header.tsx` (new): the sortable header cell and the sort state both tables cycle, taken out of the project list so the two lists share one.
- `src/modules/projects/lib/rows.ts`, `src/modules/remotes/lib/rows.ts`, with their tests and types: the owner column, and sorting by repository, owner, visibility, language, pushed and description. Pushed sorts on the raw timestamp, and visibility sorts public first rather than on the translated label.
- `src/modules/projects/ProjectsView.tsx`, `src/modules/remotes/RemoteReposView.tsx`: the shared header cells and the owner cells in both tables. The project list reads the account once per panel visit.
- `src/modules/i18n/messages.ts`: the owner labels and the two column headers, in both languages.

**Repositories can be created, renamed, described and switched from the list**

- `src-tauri/src/modules/github/repo_admin.rs`: the repository name rules checked locally (GitHub's limits and characters), the arguments a create is made with, and the slug read back from what gh prints instead of assumed, each with tests.
- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/native.ts`: `github_repo_create` and `github_repo_rename`, the latter answering with the new slug.
- `src/modules/remotes/lib/repoAdmin.ts`, `src/modules/remotes/lib/repoAdmin.test.ts`, `src/modules/remotes/RepoAdminDialog.tsx`: the same name rules in the frontend, so the rename field says what is wrong before gh is asked, and GitHub's own refusal is shown under the field.
- `src/modules/remotes/NewRepoDialog.tsx` (new): the create form, with visibility, a description, and the gitignore and license templates gh knows.
- `src/modules/remotes/DescriptionDialog.tsx` (new): one field, seeded from the row.
- `src/modules/remotes/RemoteReposView.tsx`: a New repository button, the row menu following a rename to the new slug, a description cell that opens the one-field dialog, and a visibility cell that switches, asking first only in the direction that goes public.
- `src/modules/i18n/messages.ts`: the create, rename and description strings, in both languages.
- `scripts/dev/probes/create-rename-acceptance.mjs`, `scripts/dev/probes/description-edit-acceptance.mjs`, `scripts/dev/probes/visibility-toggle-acceptance.mjs` (new): the three flows driven through the interface against the real account, with the GitHub side checked outside the scripts.

**A release's title and notes can be edited from its detail**

- `src-tauri/src/modules/github/releases.rs`, `src-tauri/src/modules/github/types.rs`, `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: `github_release_edit` sends both fields every time, so emptying one really clears it, and it goes through the REST call because `gh release edit` cannot take a body the way it arrives; the id is checked locally first.
- `src/modules/remotes/lib/releases.ts`, `src/modules/remotes/lib/releases.test.ts`: a release's stored title is kept apart from the name shown.
- `src/modules/remotes/ReleasesDialog.tsx`, `src/modules/remotes/ReleaseDetail.tsx`: an edit form in the detail, and the permission read that decides whether to offer it, cached per repository.
- `src/lib/native.ts`: `githubReleaseEdit` and its result type.
- `scripts/dev/probes/release-edit-acceptance.mjs` (new): opens a release, edits it, and checks the toast and the re-read detail.

**The remote repository list moves in beside the local projects**

- `src/app/App.tsx`, `src/app/components/WorkspaceSurface.tsx`: the projects panel gains a two-stop strip with a measured highlight and owns both lists, and the tab is renamed to the list on screen. The header button opens the panel on the local list, and switching between the two lists inside the open panel is left alone.
- `src/modules/tabs/lib/useTabs.ts`, `src/modules/tabs/TabBar.tsx`, `src/modules/tabs/lib/tabLabel.ts`, `src/modules/tabs/NewTabMenu.tsx`: the remote-repositories tab kind is gone, along with the planner that opened it, and the panel renames its own tab instead.
- `src/modules/header/Header.tsx`, `src/modules/command-palette/commands.ts`, `src/modules/command-palette/commands.test.ts`, `src/modules/i18n/messages.ts`: one header button and one palette item for the panel, with the remote list's keywords folded into it, in both languages.
- `scripts/dev/probes/auth-acceptance.mjs`, `scripts/dev/probes/issues-acceptance.mjs`, `scripts/dev/probes/permission-acceptance.mjs`, `scripts/dev/probes/releases-acceptance.mjs`, `scripts/dev/probes/repo-admin-acceptance.mjs`: the header button title they look for is the new one.

**An opened image no longer lays down a slab of its own**

- `src/modules/editor/EditorPane.tsx`: the viewer that fills the pane for an image, a video, an audio file or a PDF stops painting `bg-background` itself, the same fix the side preview column, the markdown preview, the preview pane and the editor area already carry. Measured on the running app with the repository's own `opaque-surfaces.js`: the viewer was the only opaque surface large enough to cover a pane (59% of the window) and is gone.

**A picture opened in the editor really does show its own pixels**

- `src/modules/editor/EditorPane.tsx`: original size says `max-w-none`, so a picture wider than the pane is drawn wider than it in that mode; the scrollport that holds the picture centres with `safe center`, which keeps the leading edge of a wide picture inside the scrollable range. Measured on the running app: a 1079 x 811 picture was 844 x 635 in both modes before, and is 844 x 635 fitted and 973 x 732 at original size after, with both edges reachable in the scrollport.

**The projects panel opens on the statuses it last read**

- `src/modules/projects/lib/statusStore.ts` (new): the statuses of the last check, kept in the `statuses` key of `verta-projects.json`, with a pure validator so a hand-edited or half-written file reads as "nothing remembered" instead of raising.
- `src/modules/projects/lib/statusStore.test.ts` (new): the validator refuses what is not a snapshot and keeps the entries that are, the snapshot comes back from disk, the same statuses are not written twice, and a project that left the list has its status dropped on disk as well.
- `src/modules/projects/ProjectsView.tsx`: the panel starts from what it remembers and checks right after; the file is still read, and a read that lands after a check has run loses to the check's own stamp. A project that is not in the list yet does not count as "no projects", so the list loading never wipes the remembered statuses. A batch that fails keeps the rows and reports the failure above them, and a project removed from the list has its status forgotten.
- `scripts/dev/probes/panel-state-restore.mjs` (new): proves this on the running app. A marked snapshot is put in the store, the panel's tab is closed and opened again, and the marker has to be on screen while the batch of git reads is still out; the store is then put back and the panel's own check has to settle the rows.

**The repository list opens on the list it last read**

- `src/modules/remotes/lib/listStore.ts` (new): the last `ready` repository list, in `verta-remotes.json`. A read that describes this machine rather than the account (gh missing, nobody logged in) is held in memory only, so the next window still opens on the last real list and then finds out for itself.
- `src/modules/remotes/lib/listStore.test.ts` (new): only a `ready` payload is remembered, a state of this machine is never written to disk, and the same object handed to the store twice is written once.
- `src/modules/remotes/RemoteReposView.tsx`: the list is drawn from what it remembers and the gh read runs right after it; a read that came back saying something about the machine, or that failed outright, is reported above the rows it already has rather than replacing them.

**The grid is drawn where the host's CSS space starts**

- `src/modules/terminal/ghostty/gpu/TerminalFit.ts`: `gridViewportRect` states where a renderer's grid sits inside its own canvas. WebGL measures a viewport's origin from the canvas' bottom-left and the backing store keeps a canvas bigger than the grid, so the origin is not `0`.
- `src/modules/terminal/ghostty/gpu/TerminalFit.test.ts`: the surplus stays below the grid, an exactly-sized canvas and a smaller one both keep the grid at the top, and the origin lands on whole device pixels.
- `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts`: the viewport is the grid's own rectangle, placed at the canvas' top-left, so a prompt starts at the first row and an inline picture lands on the mosaic printed for it.

**The remembered statuses live in the file only**

- `src/modules/projects/lib/statusStore.ts`, `src/modules/remotes/lib/listStore.ts`: one layer, the file. `forgetStatuses` reads the file, drops the entry and writes it back.
- `src/modules/projects/ProjectsView.tsx`, `src/modules/remotes/RemoteReposView.tsx`: a snapshot is written when a read comes back rather than by an effect watching the state, so seeding the rows from the file no longer writes the same bytes back. A project list that has not been read yet counts as "nothing to say", so it cannot wipe the file with an empty snapshot.
- `src/modules/projects/lib/statusStore.test.ts`, `src/modules/remotes/lib/listStore.test.ts`: what was kept comes back, a missing file reads as nothing remembered, only a `ready` list is ever written, and a project that left the list is dropped on disk as well.
- `scripts/dev/probes/panel-state-restore.mjs`: the acceptance reads the file instead of a memory copy, and its proof is the store's own copy being on screen in the tick where a check is still out (measured on the running app: on screen at 2.7s against a check that came back at 28s), with the store put back afterwards.

**A confirm window and the other floating layers that were left solid take the pane's tint**

- `src/components/ui/alert-dialog.tsx`: a confirm window (`AlertDialogContent`) carries `verta-float`, the recipe the dialog it is opened from already had, instead of painting `bg-popover` at full opacity. The recipe changes only a layer's colour, and only under `html[data-theme-glass]`, so every other theme paints exactly what it painted before.
- `src/components/ui/context-menu.tsx`, `src/components/ui/select.tsx`, `src/components/ui/hover-card.tsx`: the same class on a right-click menu's content and its submenu, on a dropdown's content and its two scroll strips, and on a hover card (`dropdown-menu.tsx`, `dialog.tsx`, `popover.tsx` and `command.tsx` already carried it).
- `VERTA.md`: the compositing note names the families that carry the recipe, and leaves the HUD as the one floating surface that stays opaque.
- Verified on the running app under the glass theme: the confirm window behind a run list's delete action, a right-click menu on a project row, the session hover card, and the dropdown in the new-repository dialog all compute `oklab(0.313312 -0.00584386 -0.0147395 / 0.28)`, the same value the run list's own panel already had, each with `backdrop-filter: none`; every one was opened and closed without reaching the network. A photograph of the confirm window shows the run rows through it.

**A closed layer does not stay painted while the window is in the background**

- `src/styles/globals.css`: `html[data-window-inactive]` pauses every animation, and Radix unmounts a closing layer on `animationend`, so the exit animation of a layer that is leaving (`[data-state=closed]`) is now the one exception and is left running; a closed menu, dropdown or dialog is no longer left painted over the interface with its scrim while the window stays in the background.
- `src/styles/motionBudget.test.ts`: the test that locks the pause states the exception.
- `VERTA.md`: the animation-cost note records both.
- Verified on the running app, since the native focus feed cannot be driven from a probe: with `data-window-inactive` set on the document (the attribute `windowActivity` sets) a project row's dropdown opened (its entry animation paused, as before) and the layer was gone 224 ms after Escape, with every other animation on the page still computed `paused`. Photographed: nothing left on screen.

**Every floating layer that paints solid is measured against one that does not**

- `scripts/dev/probes/floating-layer-tint.mjs` (new): opens a dropdown, a right-click menu, a hover card, a dropdown inside the create-repository window and the confirm window behind a run list's delete action, and compares each one's computed background with the first of those, refusing to run under a theme that is not glass rather than changing the user's setting. It is the first probe here that photographs the interface, and that needed an occluded WebView2 to be caught after a pointer move over the page, since it keeps its last frame. Measured: every one of the five computes `oklab(0.313312 -0.00584386 -0.0147395 / 0.28)`, with no `backdrop-filter`.

**A repository's list is read once when it is opened again**

- `scripts/dev/probes/repo-list-refresh.mjs` (new): opens one repository's run list, another's and then the first one again, closing each through the panel's own close button, and prints the epoch-millisecond marks around every open. The panel's snapshot cache is cleared first through the app's own `resetListSnapshots`.
- `scripts/dev/probes/gh-process-watch.ps1` (new): records every `gh` process start while that runs.

**A terminal with no usable working directory opens on the Desktop, verified**

- `scripts/dev/probes/desktop-fallback.mjs` (new): asks the shell itself where it is, for the three cases the fallback has to tell apart, each one a real terminal spawned through the product's own `pty_open` and closed again: no working directory at all, one that does not exist, and one that does, which is the control. The command goes into the session and the answer is read from the file the shell writes, so the evidence is the process rather than what the interface believes. Measured: the first two answer with the Desktop and the third keeps the directory it was given.
- No product change came out of this. A terminal tab opened with a directory that does not exist comes up on the Desktop, and the file tree, the status-bar trail, the tab title and the block prompt label all read the Desktop, because the shell reports its own directory and the front end follows it. Every GitHub read in the app shells out to `gh`, so the two together answer "did this panel ask GitHub again" without reading anything out of the app. With an empty cache, the first repository's open read its run list and had 20 rows in 2317 ms, the other repository's open read its own and had 20 rows in 2351 ms, and opening the first one again produced no `gh` start at all and had its 20 rows in 516 ms. The watcher polls at 60 ms, since a WMI process-start trace comes back "Access denied" without elevation on this machine.

**An agent's state is judged in the front end, and its rules are pinned to real screens**

- `src/modules/terminal/lib/agentState.ts` (new): the judge, and only the judge: plain text in, a detection out, no IO, no clock and no terminal. `AgentState` is `working` / `blocked` / `idle` / `unknown`; a rule carries the shape herdr's manifests use (id, state, priority, region, the four confidence flags, the patterns and their counter-examples). Three things make tail matching usable: a **region** (the bottom non-empty lines by default), **negative patterns** and **`skipStateUpdate`** (for a screen that is real but is not live state, like a transcript view). The matcher is this module's own rather than a regular expression, since every rule these families need is a substring, a prefix or a character set. The confidence flags are derived from the rule's state unless a rule overrides them.
- `src/modules/terminal/lib/agentRules.ts` (new): the four families' rules, with the evidence for each in the file header. A family is **identified first** by its own chrome and only then judged. `opencode` is pinned to pty output captured from this machine (`scripts/dev/ptydump`, the spinner frames, the `Thinking` status word and the `ctrl+p` / `· Tokens` footer); its permission card was not in those captures, so that one rule is written from the tool's prompt style and is marked in the file as still to be confirmed. `claude` and `codex` are herdr's published rules and neither tool is installed here. `pi` is named with no identify pattern and no rules at all.
- `src/modules/terminal/lib/agentState.test.ts`, `src/modules/terminal/lib/agentRules.test.ts` (new): 30 tests, one per claim the judge makes. A screen per state, a question printed far above the bottom (must not count), a question and a spinner on the same screen (priority), a pasted line stopped by a counter-example, a skipped screen, a priority tie going to the earlier rule, a shell prompt that is not an agent, a shell echoing `codex --help` (must not identify as that tool), a spinner inside plain command output, every spinner frame kept out of idle, the multi-byte caret compared as one character, unique rule ids, and every rule carrying exactly one confidence flag.

**Where an agent's state is judged moved, and it is not the backend**

- `src-tauri/src/modules/agent_sessions/state.rs`, `manifests.rs`, `tap.rs` (deleted), `mod.rs`: the judge added a commit earlier today is taken out again and now lives in the front end, where the screen is; `readTextRange` is what the block overlay uses to read a row range back as text, so reading it costs no IPC. A ring of raw bytes holds what the terminal received, not what is on screen. Nothing downstream depended on the Rust module yet.

**An agent's state is read from the tail of its terminal**

- `src-tauri/src/modules/agent_sessions/state.rs` (new): the judge, and only the judge: plain text in, a detection out, no IO and no clock. `AgentState` (working, blocked, idle, unknown) uses the wire names the frontend store listens for; rules carry the shape herdr's manifests use (id, state, priority, region, the `visible_*` flags, patterns and their counter-examples). A **region** (the bottom non-empty lines), **negative patterns** and **`skip_state_update`** make tail matching usable. The matcher is this module's own rather than a regex engine. `strip_ansi` lives here too: the tap keeps the bytes the terminal needs, the judge gets what a person sees.
- `src-tauri/src/modules/agent_sessions/manifests.rs` (new): the four families' rules, with the evidence for each in the file header. A family is identified first, by its own chrome, and only then judged. `opencode` and the plain shell are pinned to PTY output captured from this machine (`scripts/dev/ptydump`, spinner frames, `Thinking`, the footer hints); `claude` and `codex` are herdr's published rules and neither tool is installed here; `pi` is identified with **no rules at all**.
- Verified by unit tests: 29 of them, over a screen per state, a question printed far above the bottom (must not count), a question beating a spinner (priority), a pasted line stopped by a counter-example, a skipped screen, a shell prompt that is not an agent, a shell echoing `codex --help` (must not identify as the tool), unique rule ids, and every state rule carrying the flag its state implies. `cargo clippy --all-targets -j 2 -- -D warnings` clean, `cargo test --lib` 763 passed with 10 more in the second binary.

**The screen judge is wired to the activity store, and measured against a real terminal**

- `src/app/hooks/useAgentStateJudge.ts` (new): reads each terminal leaf's visible screen every half second, identifies the agent and judges its state, and applies the results to the activity store that the tab icons are drawn from. Every terminal tab is watched, not only the ones opened for an agent. Nothing in a tick crosses the IPC boundary.
- `src/modules/terminal/lib/agentJudge.ts` (new): the step between a screen read and a signal. It holds what was last said about a leaf, announces the agent and its first state together, and maps the judgement onto the store's vocabulary (a blocked screen is the store's `attention`, and `idle` after a busy state is its transient `finished`, which the store turns into a "done" mark). The clock is a parameter and the module is pure.
- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts`, `src/modules/terminal/lib/terminalSessionApi.ts`, `src/modules/terminal/index.ts`: `leafScreenTail` hands over the visible screen as text through `readTextRange` (the same call the block overlay reads a block's output with), with no escape sequences left to interpret. It reads the whole viewport rather than its bottom rows, because a fresh shell's prompt is the first row and the rest is blank.
- `src/modules/terminal/lib/agentActivity.ts`: `applySignal` is exported and an `idle` signal maps to the `idle` phase, so the judge's signals go through the one place a signal is applied.
- Verified on the real machine by `scripts/dev/probes/agent-state-judge.mjs`: it opens a plain terminal through the product's own shortcut, prints each of the three screens a state is made of (the footer, the spinner and the permission card the rules were written from, each behind a clear so the screen repaints the way an agent's interface does), and reads the store. Measured: `null` at a bare prompt, then `idle`, `working`, `attention`, `finished` on the way back, `idle` once the store's own timer ran, and `finished` again when the screen stopped showing the agent. 42 unit tests over the judge and its rules, `pnpm test` 2108 passed, `pnpm build` clean.
- Two measurements from that probe shaped the design. **The process query cannot answer "did the agent leave" on Windows**: `pty_has_foreground_process` and `pty_has_foreground_job` both report true for a shell sitting at its prompt, because on Windows the pid the pty spawns is Git's `bin\bash.exe`, a stub that keeps the real `usr\bin\bash.exe` as its child for as long as the tab lives. So the judgement stays on the screen, with a 2 second grace period before a chrome that stopped being identified counts as an agent that left. **A terminal that has printed little puts its text at the top of the viewport**, so the reader takes the whole viewport and the rules' own region decides what part of it matters.

**A tab shows what its agent is doing**

- `src/modules/tabs/TabChip.tsx`: a state dot on a terminal tab's chip, next to the label: amber and pulsing for a session that is waiting on the user, sky while it works, green for a turn that just finished, and a quiet grey for an agent sitting at its prompt. The pulse is the finite one the stylesheet already defined for a waiting approval. The dot carries a per-state `aria-label` and no role of its own, the way the editor tab's unsaved dot does.
- `src/modules/tabs/lib/tabAgentStatus.ts`: `selectTabAgentStatusFromLeaves` and `ptyIdsForLeaves`. The leaves-to-ptys step goes through the store, which is the only thing that changes when the judge reports an agent.
- `src/modules/terminal/lib/agentActivity.ts`: the store keeps a leaf to pty map for that, written only when the pair actually changes.
- `src/app/hooks/useAgentStateJudge.ts`: writes that map as it works, and drops a leaf's entry when the leaf is gone.
- `src/modules/i18n/messages.ts`: the four state labels, in both languages.
- Verified on the real machine by `scripts/dev/probes/tab-agent-dot.mjs` (new), which opens a plain terminal of its own, puts each screen on it and reads the tab strip's own DOM: no dot at a bare prompt, then the idle state (grey), working (sky), attention (amber, carrying the pulse class) and finished (green) once the screen stopped showing the agent. The two tabs the user had open never carried a dot, and the probe's tab was closed again. 19 tests over the store map and the selector, `pnpm test` 2113 passed, `pnpm build` clean.

**The header says how many sessions want you**

- `src/modules/header/AgentActivityBadge.tsx` (new): the count across every terminal, next to the tab strip, with the same two dots a tab carries: amber for sessions waiting on the user, sky for sessions with a turn in flight, each followed by its own label (`header.agentWaiting` / `header.agentWorking`). Nothing is rendered when nothing is running.
- `src/modules/terminal/lib/agentActivity.ts`: `countAgentPhases`, the count behind it. It only counts waiting and working sessions; `finished` and `idle` are for the tab's own dot.
- `src/modules/terminal/index.ts`: exports it.
- `src/modules/header/Header.tsx`: mounts the badge after the tab strip.
- `scripts/dev/probes/tab-agent-dot.mjs`: reads the badge's own DOM as well, so the same probe covers both surfaces. Measured: one working session, then one waiting session, and no badge at all at a prompt, after a turn settles or with nothing running.
- One process note worth keeping: adding an export to a barrel file (`modules/terminal/index.ts`) while the dev server is hot-reloading left one update serving a stale barrel, which broke the running window and needed a reload. A fresh load has the export.

**A tab says when a session started waiting while you were elsewhere**

- `src/modules/terminal/lib/agentActivity.ts`: `unseen` holds the ptys that entered `attention` while the user was not looking at them, and `foregroundLeaves` holds the leaves of the tab the user is on (leaves, not ptys, because a session can be created or resumed after its tab is already the active one). `acknowledgeAttention`, which overwrote the live phase with `idle`, is gone; the phase stays `attention` until it is answered, and `markAttentionSeen` clears the latch instead. `applySignal` arms the latch on an attention signal that is not foreground and clears it on any other state, `isForegroundPty` answers "is the user looking at this session" through the leaf map, and `countUnseenAttention` is there for the notification centre.
- `src/modules/terminal/lib/pty-bridge.test.ts`: the attention case asserts the new pair, a waiting tab whose latch clears without the state changing.
- `src/modules/tabs/lib/tabAgentStatus.ts`: `selectTabAgentUnseen`, derived like the status so a tab re-renders for its own latch and nothing else.
- `src/modules/tabs/TabChip.tsx`: a 2px amber bar on the chip's leading edge for an unseen wait, next to the state dot rather than instead of it.
- `src/app/App.tsx`: the effect that called `acknowledgeAttention` with a hand-rolled leaf to pty mapping is replaced by one that hands the active tab's leaves to the store.
- Verified on the real machine by `scripts/dev/probes/tab-agent-unseen.mjs` (new): a session of the probe's own that works while its tab is active (dot, no bar), is left waiting after switching to another tab (dot plus the 2px bar, count 1), then is looked at again (bar gone, dot and count unchanged), then is left waiting again without the bar re-arming. The probe put the user's active tab back and closed its own. 34 tests over the store, the selectors and the signal path, `pnpm test` 2121 passed, `pnpm build` clean.

**Waiting sessions collect in one list in the header**

- `src/modules/notifications/lib/attentions.ts` (new): `pendingAttentions`, built from the tabs (label and leaves) and the activity store (the latch and the leaf to pty map): a row leaves the list when the latch clears, never on a timeout, newest first. `questionExcerpt` reads what the session is asking from the bottom of its screen rather than from a stored copy.
- `src/modules/notifications/NotificationBell.tsx` (new): a bell in the header with the count, opening a list of the sessions that are waiting and have not been looked at, each row the tab's label, how long it has been waiting (`relativeTime`) and the question from its screen. Clicking a row activates that tab, which is also what marks the wait as seen. The bell is only there while something is on the list.
- `src/modules/header/Header.tsx`: mounts the bell next to the search field, wired to the same tab selection the strip uses.
- `src/modules/i18n/messages.ts`: `notifications.title` / `notifications.empty` / `notifications.jump`, in both languages.
- Verified on the real machine by `scripts/dev/probes/agent-notifications.mjs` (new): no bell at a bare prompt, then a bell with count 1 for a session that started waiting while another tab was in front; opening it lists one row reading the session's label, its relative time and the card's text; clicking the row brings that tab to the front and empties the list; the probe's tab was closed and the user's active tab put back. 10 tests over the list and the excerpt, `pnpm test` 2131 passed, `pnpm build` clean.

- `scripts/dev/probes/close-guard-process-query.mjs` (new): reads the two native answers to "is a command still running in this shell" next to what a terminal's screen actually shows. Measured on this machine: one visible terminal, its screen a bare prompt, and `pty_has_foreground_process` and `pty_has_foreground_job` both answer true, because on Windows the pid the pty spawns is Git's `bin\bash.exe`, a stub that starts `usr\bin\bash.exe` as its only child and keeps it for as long as the tab lives. No product change comes out of this: it is measured, not fixed, because the fix is on the Rust side.
- What it costs today: the close guard's "a terminal is still running" prompt is asked on every window close when `confirmCloseRunningTerminal` is on, which it is by default, whatever the terminal is doing. The same query is what `useAgentAttentionFlash` uses for "the child went away, so it is done".

**An idle terminal is no longer reported as busy on Windows**

- `src-tauri/src/modules/pty/foreground.rs`: the Windows side of "does this shell have child processes" steps past a shell that only started another shell first, since Git spawns the shell through `bin\bash.exe` whose only child is `usr\bin\bash.exe`. The walk follows a single shell child until it lands on the process the user is typing into; it stops at a child that is not a shell and at two or more children, and it is capped at eight steps. `process_list` takes the one ToolHelp snapshot and materialises it, so the walk can look at the list more than once.
- Tests in the same file cover the stub chain, a command under the shell, a shell the user started by hand, several children, a shell started directly, and the cap.
- `scripts/dev/probes/close-guard-process-query.mjs`: the probe drives a terminal of its own through the states a user puts one in, through the app's own `submitToLeaf`, and reads the guard's helper and both commands underneath it next to what the screen shows. It also reads every terminal that is already open. Measured on this machine: bare prompt false, `ping.exe` running true, idle again after Ctrl+C.
- Verified on the real machine: open terminals at a prompt read false, `ping.exe` and `node` running read true, and the prompt the command comes back to reads false again. `cargo clippy --all-targets -j 2 -- -D warnings` clean, `cargo test --lib -j 2` 740 passed.
- Known limit, recorded rather than fixed here: a command whose image is an MSYS one (`sleep`, `yes`, `git`, `less`) is started through a transient process that exits at once, so Windows reports its parent as a pid that is already gone and the command is not a child of the shell; the query misses it and the guard stays quiet. Native commands (the agents, `node`, `pnpm`, `python`) hang off the shell's own fork and are seen.
</details>

<details>
<summary><strong>2026-10-23</strong></summary>

**A notification-area icon keeps the app reachable, and closing the window can hide it there**

- `src-tauri/src/modules/tray.rs` (new): the notification-area icon. A left click brings the main window back and focuses it; the right-button menu shows the window or asks the page to quit. The menu labels arrive from the frontend, which owns the message table, so the menu is in the interface language from its first paint. A second command mirrors the close-to-tray preference into an atomic, readable from the Rust side where the preferences store cannot be reached.
- `src-tauri/Cargo.toml`, `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`: the `tray-icon` feature is on, the module and its commands are registered, and the main window's close request hides the window instead of ending the process while the preference is on.
- `src/app/hooks/useTray.ts` (new): sends the menu labels again whenever the language changes, mirrors the preference into Rust, and forwards the tray's quit request to the page.
- `src/app/hooks/useAppCloseGuard.ts`: the close listener stops the close in both cases and then decides, and it hands out `requestAppQuit` for the tray to call. Stopping the close is required: with that listener registered, Tauri withholds the close, and a handler that does not stop it lets the JS side destroy the window.
- `src/app/hooks/useTaskbarPresence.ts` (deleted), `src/app/hooks/useAgentAttentionFlash.ts`, `src-tauri/src/modules/taskbar.rs`: the permanent taskbar button and the preference behind it are gone. The flash for a waiting or finished agent is unchanged.
- `src/modules/settings/store.ts`, `src/settings/sections/GeneralSection.tsx`: a close-to-tray preference replaces the permanent-button one, on by default.
- `src/modules/i18n/messages.ts`: the tray menu labels and the preference, in both languages.
- Verified on the running app: with the preference on, the close button leaves the window hidden and the process running, three times in a row, and the hidden window can be brought back; with it off, the close button ends the process.

**Issues can be deleted**

- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: a new `github_issue_delete` command removes an issue through `gh api --method DELETE repos/{slug}/issues/{number}`, with the same local validation and error classification the other write commands use.
- `src/lib/native.ts`, `src/modules/remotes/IssueDetail.tsx`, `IssuesDialog.tsx`: the action bar gets a Delete button, only on a plain issue; a pull request still only closes. It goes through the confirmation dialog the other writes use, and once it lands the detail closes and the list reloads.
- `src/modules/i18n/messages.ts`: four strings, in both languages.

**A keyboard shortcut for the screenshot**

- `src/modules/shortcuts/shortcuts.ts`, `src/app/App.tsx`: `Alt+A` grabs a region, next to the header button. It sits in the General group, so it appears in Settings, Shortcuts, General with the others.
- `src/modules/i18n/messages.ts`: one string, in both languages.
- `src/modules/shortcuts/shortcuts.test.ts`: asserts the binding is Alt+A.
- `src/app/App.tsx`: `startScreenshot` moved above the shortcut table, where the binding is wired.

**The source-control and remotes panels follow the interface language**

- `src/modules/source-control/SourceControlPanel.tsx`: the repository and branch label was built in a `useMemo` whose dependency list left out `t`; `t` is a dependency now, so the label re-renders with the language.
- `src/modules/launcher/lib/relativeTime.ts`, `src/modules/remotes/lib/rows.ts`, `issues.ts`, `releases.ts`, `runs.ts`: `relativeTime` takes the language as a required argument now, so a caller that forgets it fails to compile instead of rendering in a default language. Every time column (remote repositories, issues and pull requests, releases, CI runs) follows.
- `src/modules/remotes/RemoteReposView.tsx`, `IssuesDialog.tsx`, `ReleasesDialog.tsx`, `RunListDialog.tsx`, `RunDetail.tsx`: they read the language from `useLanguage()` and pass it into those builders.
- Six new tests assert the English wording of each builder. The existing assertions are unchanged apart from the extra argument.
- Verified on the running app with the interface set to English: the source-control selector reads Source Control, and the repository list shows English wording and dates. Repository descriptions stay exactly as GitHub returns them, being data rather than interface copy.

**PR review: approve and request changes**

- `src-tauri/src/modules/github/commands.rs`, `issues.rs`, `lib.rs`: a new `github_pr_review` command posts a review through `gh api --method POST repos/{slug}/pulls/{n}/reviews`, with `approve` / `request_changes` mapped to GitHub's `APPROVE` / `REQUEST_CHANGES` and an optional comment. The verb is validated locally the way the merge path validates its method, and any failure carries what `gh` said. Two unit tests cover the mapping and the payload (a blank comment is left off the payload rather than sent as an empty string).
- `src/lib/native.ts`, `src/modules/remotes/IssueDetail.tsx`, `IssuesDialog.tsx`: the PR block gets a Review group with Approve and Request changes beside the merge controls, shown only while the pull request is open. Both go through the same confirmation dialog the merge uses, plus an optional comment box.
- `src/modules/i18n/messages.ts`: ten strings, in both languages.
- Verified on the running app against a throwaway pull request in this repository: both actions were driven from the real UI and both landed on GitHub (one approved review and one changes-requested review, each carrying the typed comment).

**PR detail lists the checks one by one**

- `src-tauri/src/modules/github/types.rs`, `issues.rs`: `CheckSummary` carries the rows it was already counting (`CheckItem`: an id, a name, the state, a link), and the per-row verdict moved into a single `CheckRow` value that both the rows and the counts go through, so the list and the summary cannot disagree. No new request: the pages that were already fetched supply them. The `partial` rule is untouched (a page short of `total` still reports `partial`, never a pass), and three tests cover the list, the fallback name and that rule.
- `src/lib/native.ts`, `src/modules/remotes/IssueDetail.tsx`: the PR block lists the checks under the summary badge in a scrollable list, with the same colours the badge uses. Read only, no actions.
- `src/modules/i18n/messages.ts`: six strings, in both languages.
- Verified against a public pull request that has checks (read only, nothing written): seven rows came back for a total of seven, every row carried a link, and the row states matched the summary counts exactly.

**PR detail lists the commits**

- `src-tauri/src/modules/github/commands.rs`: `read_issue_detail` asks the pulls endpoint speculatively (a plain issue 404s, and that is ignored). When it comes back, one more `gh api "repos/{slug}/pulls/{n}/commits"` runs and the result is attached. Any failure there leaves the list empty instead of failing the page, as the comment fetch already does.
- `src-tauri/src/modules/github/types.rs`, `issues.rs`: `PullRequestCommit` (sha, first line of the message, author, html url) and `IssueDetail.commits: Option<Vec<...>>`, following the convention `checks` set (None means unavailable, Some of an empty list means this PR has none). The author falls back to the git name when a commit is not linked to an account, and an entry without a sha is dropped. Two unit tests cover both.
- `src/lib/native.ts`, `src/modules/remotes/lib/issues.ts`, `src/modules/remotes/IssueDetail.tsx`: the PR block lists the commits under the check summary, one per line with the short sha, the first line of the message and the author. One page of a hundred is read; when the cap is reached the heading says so and carries the count.
- `src/modules/i18n/messages.ts`: two strings, in both languages.
- Gates are green: cargo test --lib 715 passed with the two new cases, clippy with -D warnings, tsc, biome and the build. Verified on the running app against a throwaway PR in this repository (two commits, opened for the check and closed right after): the detail payload carries both, each with the sha, the first line of the message, the author and the commit url, and the check summary sitting next to it is unchanged.

**Opening a folder from Explorer does something now**

- `src/lib/launchDir.ts`: `get_launch_dir` drains its state, so that one call is the only place that can tell a folder passed as an argument apart from the remembered workspace; it keeps that flag now.
- `src/app/App.tsx`: a folder argument opens a terminal on it once the spaces restore is done, unless a terminal is already open there, the same way a launch file is opened. The Explorer verb in `installer-hooks.nsh` runs `verta.exe "%V"`, so right-clicking a folder lands in that folder instead of only setting where the next session would start.

**Lint: the baseline warnings are gone**

- Twenty-five files under `src/` carried the 67 warnings that came in with the upstream baseline import (`1cd3921`). They are all cleared, so `pnpm lint` reports nothing at all now. Twenty-two were real fixes: optional chains, template strings, `indexOf`, two `while ((m = re.exec(t)))` loops written as `for` loops, three `reduce` blocks that accumulated into an object written as `Object.fromEntries`, a dependency in `GitDiffPane` that could not change on its own, and a `{}` in `settings/store.ts` narrowed to `Record<string, never>`.
- Forty-five carry a `biome-ignore` with the reason, which the repository already used in seven places: seventeen `useExhaustiveDependencies` (adding the entry would re-run the effect on every render), the a11y warnings on chips and rows that live inside a button, and three `noArrayIndexKey` on lists whose items have no identity of their own and are never reordered.
- No interface changed. `tsc`, the build, the 1981 frontend tests, `cargo clippy --all-targets -D warnings` and the Rust tests are green.

**Theme validation messages come from the message tables**

- `src/modules/theme/validateTheme.ts`: the validator returns a message key plus its values (`ValidationFailure`) instead of whole English sentences; the path building, the accepted ranges and the order in which fields are checked are unchanged.
- `src/modules/theme/themeFiles.ts`: the invalid-JSON case returns the key too, while a parser message is still passed through verbatim, being runtime data rather than copy.
- `src/settings/sections/ThemesSection.tsx`: the import error resolves the key when it renders, so it follows the language.
- `src/modules/theme/validateTheme.test.ts`: the assertions that pinned the sentences now pin the keys.
- `src/modules/i18n/messages.ts`: fifteen new strings, in both languages.
- Verified on the running app by feeding a broken theme file straight to the import input: the dialog shows the localized message for an id that is not kebab-case.

**Window titles and one tooltip follow the language**

- `settings.html`, `screenshot.html`: the static titles carry the neutral app name now, and the settings window sets its own title from the message table at runtime so it follows the language (`capabilities/default.json` covers that window with `allow-set-title`). The screenshot overlay keeps the title Rust gives it in `src-tauri/src/modules/screenshot/mod.rs` (`capabilities/screenshot.json` gives it events only, and the window is frameless, out of the taskbar and invisible in practice).
- `src/modules/tabs/lib/useWindowTitle.ts`: the main window title joins the project and the tab with a middle dot instead of an em-dash.
- `src/modules/statusbar/CwdBreadcrumb.tsx`: the more button in the collapsed path has its own tooltip string instead of the show-hidden-folders one.
- `src/modules/i18n/messages.ts`: three new strings (the two window titles and the more-paths tooltip), in both languages.

**Helper windows do not outlive the main window**

- `src-tauri/src/lib.rs`: the settings window and the screenshot overlay hide instead of destroying, so they can be reopened without rebuilding the webview. The handler that ends them when the main window goes now destroys both windows and exits, on every platform but macOS, which keeps an app alive with no window open by convention. It acts on `Destroyed`, so it fires when the window is really gone rather than when its close button was pressed.

**Repo panels reuse a recent read instead of asking again**

- `src/modules/remotes/lib/listSnapshot.ts` (new): a small time-boxed cache keyed by what was read (repo, plus the state filter for issues), so a list is served again while it is younger than two minutes (ten for the permission answer, which changes when the user changes it rather than while they browse). The panels drop a key when they change something themselves.
- `src/modules/remotes/RunListDialog.tsx`, `src/modules/remotes/IssuesDialog.tsx`, `src/modules/remotes/ReleasesDialog.tsx`: reopening the same repo paints from that read instead of spending the requests again; the run list still reports to the row's CI badge from the cached payload. Issues carries the filter in the effect's dependencies, since the cache is keyed by it.
- `src/modules/remotes/lib/listSnapshot.test.ts` (new): keys stay apart, entries expire at the TTL, forgetting forces a re-read, and a stored falsy value is still a hit.

**Taskbar: a flash when an agent needs you**

- `src-tauri/src/modules/taskbar.rs` (new): flashes the window's taskbar button: until the window comes to the front for "an agent is asking", a fixed handful of times for "finished". Whether the window gets a button at all is the shell's call, not a setting.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`: the module and its command registered.
- `src/modules/terminal/lib/agentAttention.ts` (new): decides "waiting for an answer" and "finished" from the two things visible outside an agent's full-screen UI: the leaf's cumulative output bytes and whether the shell still has a child process. Four seconds of silence with the child alive is a wait; the child disappearing is a finish.
- `src/app/hooks/useAgentAttentionFlash.ts` (new): samples the tabs that were opened for an agent, once a second, and flashes the taskbar button.
- `src/modules/settings/store.ts`, `src/settings/sections/GeneralSection.tsx`: a preference for the flash, on by default. The switch is only shown on Windows, where it does something.
- `src/modules/i18n/messages.ts`: its label, in both languages.

**CJK text keeps its own font when the font changes**

- `src/lib/fonts.ts`: the fallback chain ends in an explicit CJK run before the generic `monospace`: Windows (Microsoft YaHei UI / YaHei / DengXian / Sarasa Mono SC), macOS (PingFang SC / Hiragino Sans GB), Linux (Noto Sans CJK SC / Noto Sans Mono CJK SC / Source Han Sans SC / WenQuanYi Micro Hei). Code fonts such as Cascadia Mono carry no Han glyphs, and the terminal stack and the editor family are both built from this one chain.
- `src/lib/fonts.test.ts`: reads the chain from the module instead of keeping a copy, and asserts the CJK faces are named and come after the Latin pick.

**Explorer drag: Ctrl copies, and the pane header accepts drops**

- `src/modules/explorer/lib/useExplorerDnd.ts`: the modifier is read while the pointer moves (so the ghost can say which mode is armed) and read again at drop time; `Ctrl` / `Cmd` copies through a new `onCopy` callback, a plain drag still moves.
- `src/modules/explorer/FileExplorer.tsx`: `onCopy` goes through the same `fs_copy` path and conflict handling as paste and refreshes the destination; the header row of the pane is now a drop target that resolves to the root, so items can be dragged back up when the root's rows are scrolled away. The drag ghost shows the copy mode.
- `src/modules/i18n/messages.ts`: one key for the copy label on the drag ghost.

**Comments across the code base are in English**

- The whole source tree, `src/`, `src-tauri/src/` and `scripts/`, had its comments translated to English. Code, string literals, identifiers and data (benchmark payloads, language names, the string tables) are untouched; only the prose in comments changed.
- `CHANGES.md`: this file is in English now.
- A second pass finished the leftovers: 26 files still carried a comment in the old language. `src/modules/theme/themes/themeNames.ts` had a whole block (the names-versus-descriptions rule), the rest were one or two explanatory lines in twenty test files, and there were the four in `.gitignore`, the block in `screenshot.html`, one in `src-tauri/Cargo.toml` and two trailing comments in the Rust crate (`screenshot/encode.rs`, `workspace.rs`). Only the prose in comments changed, no string, identifier or fixture data.

**Session-list copy moved into the message tables**

- `src/modules/i18n/messages.ts`: added the strings the session list still hardcoded (empty list, sub-agent badge, the five context-menu items, the copy-succeeded toast, rounds / tokens / relative time), in both languages.
- `src/modules/launcher/components/SessionList.tsx`, `src/modules/launcher/lib/sessionStats.ts`, `src/modules/launcher/lib/relativeTime.ts`, `src/modules/launcher/components/LauncherPanel.tsx`, `src/modules/projects/ProjectsView.tsx`: now go through the message tables; the formatting functions take an extra locale argument (a default is used when none is passed, and the pure formatting logic is still callable directly).
- Wording unchanged in both locales (verified on the running app); no string leaks through when the locale is switched.

**Theme page item renamed to "session start transition"**

- `src/modules/i18n/messages.ts`: the title goes from "session open transition" to "session start transition", and the description's "open a session" follows (English `Session start transition`). The item is about the moment a session starts, not about the act of clicking it open.

**A session can no longer be deleted once its project directory is gone**

- `src-tauri/src/modules/agent_sessions/opencode.rs`: deletion goes through opencode's own command, which has to run inside the directory recorded on the session (it locates the session by working directory). The recorded directory is used when it still exists and a temporary directory when it does not, so a session whose project was deleted can still be deleted instead of failing at the OS layer (Windows: "The directory name is invalid").

**Session opening transition: four animations, chosen on the theme page in settings**

- `src/modules/settings/store.ts`: new preference `sessionTransition` (`ripples` / `pulse` / `orbit` / `bars` / `none`, default `ripples`), plus `coerceSessionTransition` to fall back to the default for an unrecognized older value.
- `src/app/components/SessionOpeningOverlay.tsx`: draws a different animation per preference: ripple spread / concentric pulse / orbiting glow / bar bounce; with `none` the whole layer is not drawn (the command written into the terminal stays visible as before).
- `src/styles/globals.css`: styles for the three new animations, under the same constraints as the ripple (transform / opacity only, fixed iteration count, not played under `prefers-reduced-motion`).
- `src/settings/sections/ThemesSection.tsx`: the theme page gains a "session start transition" dropdown.
- `src/modules/i18n/messages.ts`: one key, in both languages.

**The delete-session dialog no longer names opencode / pi**

- `src/modules/i18n/messages.ts`: `launcher.deleteBody` drops the "(opencode N, pi N)" part, and the two notices no longer name the tool, only the consequence (child sessions / artifact directory go with it).
- `src/modules/launcher/components/LauncherPanel.tsx`: those two notices are appended **only when a session of that kind is actually part of this batch**, and the two now-unused count placeholders are gone.

**Opening a session no longer shows the command being typed into the terminal; it shows a centered transition instead**

- `src/app/components/SessionOpeningOverlay.tsx` (new): a centered transition layer: three ripples spread outward in sequence, the app icon in the middle, with the icon jolting as it appears (shrink, overshoot, settle).
- `src/app/App.tsx`: both places that open a session (clicking one in the session list, and "open with an agent" on a project row) cover the terminal with this layer while opening the tab; it is removed **after the agent UI has painted**: the leaf's cumulative output bytes are sampled once before writing the command, and the layer is removed when both "the shell has a child process (`leafHasForegroundProcess`)" and "another 900 bytes were painted" hold, capped at 8 seconds with a hard fallback at 8.5 seconds. The criterion is **cumulative** output rather than quiet duration, since a live TUI repaints constantly.
- `src/app/components/WorkspaceSurface.tsx`: the layer is drawn **inside the terminal layer** and covers only that area, not the whole screen, so the sidebar, tab bar and status bar stay visible.
- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts` + `src/modules/terminal/lib/terminalSessionApi.ts`: the terminal side tracks one more counter, cumulative output bytes per leaf (`leafOutputBytes`), feeding the criterion above; it is cleared when the session is destroyed.
- `src/styles/globals.css`: styles for the transition layer. Only transform / opacity are animated, soft edges come from radial gradients, and the ripple iterations are fixed rather than an infinite loop. One ripple cycle is 1.9 seconds and the icon jolt is 0.85 seconds; no animation plays under `prefers-reduced-motion`.

**The side-by-side preview column no longer lays down its own 60% background**

- `src/modules/editor/SidePreview.tsx`: the column no longer hardcodes `bg-background/60`; the background is left to the panel it sits in, and the boundary with the editor is the border on the left.

**Markdown "rendered / source" and the "preview" button at the editor's bottom right merged into one three-way control**

- `src/modules/markdown/MarkdownViewToggle.tsx`: the control goes from two states to three (rendered / source / preview), single-select; the "preview" state is only drawn on the editor side (side-by-side preview belongs to the editor, and it is not present when a whole page is rendered).
- `src/modules/editor/EditorPane.tsx`: the "preview" button at the bottom right is removed: document files (Markdown) are handled by the control above, while files with no view toggle such as images keep the original button. The control now receives the side-by-side preview on/off state so it can be drawn in the same group.
- `src/modules/editor/EditorStack.tsx`: Markdown tabs wire the side-by-side preview toggle into the control; choosing "rendered" or "source" collapses the side-by-side preview first, so the three states really are single-select.

**Settings window texture uses the same values as the main window and covers the whole page**

- `src/styles/globals.css`: `.settings-shell` in the settings window takes `--frame` directly instead of an 82% background of its own: same values as the main window (`--frame`, 55% when Mica is on), the texture covers the entire settings page, and the cards and switches themselves stay solid and readable; with Mica off both go solid together.

**Light appearance: Carbon Fiber's honeycomb texture shows through, Verta stays black**

- `src/modules/theme/themes/pattern-base.ts`: the light-side texture was **white lines with `multiply`**; it now uses dark ink lines with `multiply`, with strength set against the dark side (dark: white lines lift about 22 per channel, light: ink lines knock down about 15).
- `src/modules/theme/themes/verta.ts`: both appearances now share the same near-black palette, and the editor stays dark too: picking this theme is black, regardless of appearance.

**Session tabs: draw the icon of the matching agent instead of always drawing the terminal icon**

- `src/modules/tabs/lib/useTabs.ts`: terminal tabs record an extra `agent` (which agent this tab was opened for); both entry points that create session tabs accept it.
- `src/app/App.tsx`: opening a session passes the session's own tool; the "open with an agent" project row does the same.
- `src/modules/tabs/TabBar.tsx`: the tab icon draws that agent's brand mark when the tab records an `agent`, and the terminal icon as before when it does not (plain terminal, command block, private terminal).
- `src/modules/tabs/lib/serialize.ts`: `agent` is persisted and restored with the tab, so the icon survives a restart.

**Descriptions of the three new themes: one line each, like the others**

- `src/modules/theme/themes/verta.ts`, `src/modules/theme/themes/acrylic.ts`, `src/modules/theme/themes/pattern-base.ts`: all three descriptions are now one short phrase about how the theme looks, like every other entry in the theme list.
- `src/modules/theme/themes/themeNames.ts`: the matching entries in the other language are shortened too, and the style rule is written into the file header (a description states only how it looks; origin and implementation stay in comments inside the theme file).

**Shortcut for closing a tab (terminals included): a binding the terminal does not swallow, and the settings page draws every binding**

- `src/modules/shortcuts/shortcuts.ts`: `tab.close` gains an additional default binding, `Ctrl/⌘+Shift+W`, because with focus in the terminal the plain `Ctrl+W` never reaches the app (the shell consumes it as `^W`) and this is also the chord Windows Terminal uses to close a tab. Configs that only bound the plain one are unchanged.
- `src/settings/sections/ShortcutsSection.tsx`: every binding of a row is drawn now, separated by `/`, instead of only the **first** (`sidebar.toggle` / `view.zenMode` already had two).
- `src/settings/sections/ShortcutsSection.tsx`: the tokens of one binding are keyed by the token itself instead of the array index.

**Glass themes: the editor area and Markdown preview no longer cover the panel's tint**

- `src/modules/editor/EditorStack.tsx`, `src/modules/markdown/MarkdownPreviewPane.tsx`: `bg-background` removed in both: their parent is the panel (`.verta-pane`), which already paints `--background` under opaque themes (appearance unchanged) and paints its own tint under glass themes.

**The two hints at the bottom of the command block**

- `src/modules/i18n/messages.ts`, `src/modules/terminal/block/ShellInput.tsx`: the "`{shortcut}` switch to AI" part of the input block placeholder is removed, since **nothing** in the repository binds that chord (`Ctrl+U` exists neither in the shortcut table nor in the terminal keymap); the `fmtShortcut` interpolation goes with it.
- `src/app/components/WorkspaceInputBar.tsx`, `src/modules/i18n/messages.ts`: the hint in plain mode goes through the key `term.typeDirectly`, in both languages.

**Preview page and commit graph: no longer carry their own color schemes**

- `src/modules/preview/PreviewPane.tsx`: the preview page background follows the theme (`bg-background`) instead of the hardcoded `bg-white` that painted as soon as the address bar holds a URL. Colors of the previewed page itself are unchanged.
- `src/modules/git-history/lib/graph.ts`: the commit graph lane colors come from the theme's own terminal palette (`var(--terminal-ansi-*)`) instead of a hardcoded palette (blue-400 / purple-400 / amber-400 …): every theme fills in those 16 colors, so the graph recolors with the theme. The rail is still drawn with `var()` as before.
</details>

<details>
<summary><strong>2026-10-22</strong></summary>

**Themes: default theme renamed to Terax, plus new "Verta", "Acrylic" and "Carbon Fiber"**

- `src/modules/theme/themes/verta-default.ts`: only the display name goes from `Verta Default` to `Terax`; `id` stays `verta-default`, and the colors stay in `styles/globals.css`.
- `src/modules/theme/themes/verta.ts`, `src/modules/theme/themes/acrylic.ts`, `src/modules/theme/themes/pattern-base.ts`: three new themes, each with a dark and a light variant, listed first on the settings page. Verta is black and white after the app icon; Acrylic uses the native Windows 11 acrylic material, with the desktop really showing through; Carbon Fiber is a graphite base with a fine honeycomb grid and solid, opaque panels.
- `src/modules/theme/themes/themeNames.ts`: new, the localized theme names and descriptions, covering the existing themes too (proper names such as Dracula / Nord stay untranslated).
- `src/modules/theme/types.ts`, `applyTheme.ts`, `validateTheme.ts`: themes gain two optional blocks, "surface layer" (base color, texture, opacity, blend mode) and "glass" (frame and panel opacity, highlight strength, whether the desktop shows through too); custom theme JSON accepts both.
- `src/modules/theme/SurfaceLayer.tsx`, `src/styles/globals.css`: one more element at the very bottom of the UI dedicated to drawing the surface layer; it is not displayed in themes without a texture, does not block anything, and covers the settings window as well.
- `src-tauri/src/modules/vibrancy.rs`, `src/modules/theme/vibrancy.ts`, `src/modules/theme/WindowVibrancyBridge.tsx`: the window background material gains an `acrylic` option (Windows' `DWMSBT_TRANSIENTWINDOW`), declared by the theme itself rather than turned on manually in settings.
- `src/settings/sections/ThemesSection.tsx`, `src/settings/components/LspInstallDialog.tsx`, `src/modules/i18n/messages.ts`: "blur" in the theme settings and "checking… / check again" in the language server dialog were hardcoded English and now follow the UI language.

**Session list: everything in one block sorted by time by default, or grouped by agent**

- `src/modules/launcher/lib/sessionGroups.ts`: new, the grouping and sorting rules (section order follows the tool order, and tool names missing from the list are still listed).
- `src/modules/launcher/components/LauncherPanel.tsx`: an "all / by agent" toggle under the search box, defaulting to "all".

**Session round count and "last conversation time": read the current opencode tables**

- `src-tauri/src/modules/agent_sessions/opencode.rs`: messages are read from the `session_message` table, falling back to the old `message` table only when the new one is absent; the round count counts user messages rather than every message; sessions whose messages were cleared but whose tokens remain get an estimated round count from the tokens; tokens are no longer computed as 0 when every field is empty.
- `src-tauri/src/modules/agent_sessions/wsl.rs`: the equivalent query inside a distro changed the same way.
- `src/modules/launcher/lib/sessionStats.ts`: last conversation time refined to "just now / N minutes ago / 1·3·6·12 hours ago / yesterday / day before yesterday / concrete date".

**Session list: rows show rounds / tokens / last conversation date, context menu copies and renames**

- `src-tauri/src/modules/agent_sessions/stats.rs`: new, the pure logic of session statistics (how pi's usage folds into tokens, and "unknown" rather than 0 when there is none).
- `src-tauri/src/modules/agent_sessions/opencode.rs`, `pi.rs`, `wsl.rs`, `types.rs`, `mod.rs`: the list also carries rounds, tokens and last conversation time (null when unavailable); new `agent_sessions_rename` command (opencode rewrites the `title` column, pi appends a `session_info` line, neither touches any other field).
- `src/modules/launcher/components/SessionList.tsx`, `components/LauncherPanel.tsx`: rows no longer show the path but "N rounds · tokens · last conversation date"; the context menu offers copying the absolute path / relative path / session id and renaming in place.
- `src/modules/launcher/lib/sessionStats.ts`, `lib/sessionPaths.ts`: new; the former holds the display rules for the three numbers (ten thousand and above folded to a ten-thousand unit), the latter computes the path relative to the workspace.

**Pi session name: a long session reads its last name**

- `src-tauri/src/modules/agent_sessions/pi.rs`: the name is no longer looked for only in the first 8 MB of the file; it searches backwards from the end of the file and takes the last name.

**Settings window: closing and reopening reuse the webview**

- `src-tauri/src/lib.rs`: on a close request the settings window does `prevent_close()` + `hide()` and is reused on the next open, instead of rebuilding the whole webview on every click on Settings. It is still destroyed per the original logic when the main window is hidden or exits.

**Issues / PR: lock the head sha before merging, page through more than 100 checks, a few list fixes**

- `src-tauri/src/modules/github/commands.rs`: the PR merge carries the head sha of the PR as it was when the confirmation dialog opened (the `sha` field); when the merge request is rejected because the PR moved, GitHub's raw text is surfaced. `check-runs` above 100 entries are fetched page by page (up to 10 pages) and counted once all are in.
- `src-tauri/src/modules/github/issues.rs`: new `head_sha_problem` (empty is allowed, a given value must be 40 hex digits), `summarize_check_pages` (state computed once over the merged pages, still `partial` when pages are missing), `checks_page_path` / `checks_have_more` / `count_check_runs`.
- `src/lib/native.ts`, `src/modules/remotes/IssuesDialog.tsx`: the head sha is carried from the detail into the merge; list requests are numbered so a slow response does not overwrite newer results when switching "open / closed"; the empty state speaks to the current filter ("only open ones", "only closed ones", "none at all").
- `src/modules/remotes/lib/issues.ts`: a keyword containing `#` still searches by number (`#20` equals `20`).
- `src/modules/command-palette/commands.ts`, `src/modules/command-palette/types.ts`, `src/modules/i18n/messages.ts`: the disabled reasons in the command palette were hardcoded English (`Last tab` / `Pane limit` / `No workspace root`) and are now i18n keys.

**GitHub panel: a partly seen check list is no longer green, and the merge-blocked reason is a code**

- `src-tauri/src/modules/github/commands.rs`: fetching `check-runs` passes `per_page=100` explicitly, so a list of 40 checks is read in full rather than the first 30 of it.
- `src-tauri/src/modules/github/issues.rs`: `parse_checks` records `truncated` (fewer entries received than `total_count`); `check_state` gains a `partial`: **when only part was seen and the part that was seen is all green it no longer reports `pass`** (a seen failure, or something still running, still takes precedence as `fail` / `pending`). `merge_block_reason` is renamed `merge_block_code` and returns a reason code (`merged` / `closed` / `draft` / `conflict` / `computing` / `unknown`) instead of a sentence.
- `src-tauri/src/modules/github/types.rs`: `CheckSummary` gains `truncated`; `merge_blocked_reason` is renamed `merge_blocked`, its content being the reason code.
- `src/lib/native.ts`, `src/modules/remotes/lib/issues.ts`: wire and mapping follow; `mergeBlocked()` passes the reason code through, `checkTone` accepts `partial` (a neutral colour, not green).
- `src/modules/remotes/IssueDetail.tsx`: the merge-blocked sentence comes from the reason code through i18n rather than being painted straight from the backend.
- `src/modules/i18n/messages.ts`: new `remotes.issues.checks.partial` and `remotes.issues.mergeBlocked.*`, six keys, in both languages.

**Acrylic theme: terminal background can be transparent, and the settings window switches window material too**

- `src/modules/terminal/ghostty/gpu/terminalVisuals.ts`, `gpu/ScreenUniform.ts`, `gpu/WebGpuTerminalSurface.ts`, `gpu/WebGpuWindowCanvas.ts`, `gpu/WebGpuTerminalRuntime.ts`, `gpu/shaders.ts`: the terminal background supports transparency. When a theme writes `terminal.background` as a colour with alpha, the terminal canvas clears to that alpha (the canvas alpha mode follows the panel's theme background); the two shaders output premultiplied and the glyph pipeline's blend state follows, with identical results while opaque. **Colours the app itself sets (TUI blocks, selection, search hits, underlines) stay opaque** and are unaffected by theme transparency; the placeholder background before the terminal's first frame is no longer painted solid under transparent themes either.
- `src/modules/theme/themes/acrylic.ts`: terminal background fully transparent (glass covers the terminal area), panel and frame tints thinned by one step, name and description switched to English.
- `src/settings/SettingsApp.tsx`: the settings window now renders the component that switches the window background material, so it follows the same material as the main window.
- `src/styles/globals.css`: the settings window root no longer hardcodes `--background`; when the window can show what is behind it (native material / glass theme) the root takes `--frame` and the `.settings-shell` block takes the panel tint, the same layering as `#root` in the main window.

**Acrylic material: a blur with an adjustable tint**

- `src-tauri/src/modules/vibrancy.rs`, `src-tauri/Cargo.toml`: acrylic uses `ACCENT_ENABLE_ACRYLICBLURBEHIND` instead of DWM's `DWMSBT_TRANSIENTWINDOW`: it blurs the real content behind the window, with the tint and opacity supplied by us and the theme's `glass` tint layered on top. That attribute is undocumented, so its address is taken from `user32.dll` at runtime and Mica is the fallback when it cannot be resolved; `windows-sys` gains `Win32_Graphics_Dwm` and `Win32_System_LibraryLoader`.

**Window corners: no square-cornered material showing through**

- `src-tauri/src/modules/vibrancy.rs`: switching the window material also sets `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`, so the material leaves no square patch outside the four corners.
- `src/styles/globals.css`: the window corner radius is extracted into `--window-radius: 8px`, aligned with DWM's `DWMWCP_ROUND`.

**Theme names and descriptions: Acrylic / Carbon Fiber use English names**

- `src/modules/theme/themes/themeNames.ts`, `themes/acrylic.ts`, `themes/pattern-base.ts`: Acrylic and Carbon Fiber use English names (the same rule as proper names such as Dracula, since they refer to the material itself), the descriptions follow the UI language, and the acrylic description describes the effect.

**Shortcuts: "close tab" is findable from both search entry points**

- `src/settings/sections/ShortcutsSection.tsx`: the shortcut list search compares what is visible on screen (translated labels and group names) and also the chord itself (`Ctrl+W`), instead of the untranslated keys, so it works in both languages.
- `src/modules/shortcuts/shortcuts.ts`, `src/modules/shortcuts/index.ts`: new `SHORTCUT_ALIASES` (search aliases, not drawn in the UI): close-tab accepts the words people use for that row in either language (terminal, delete, close, tab, pane, `terminal`, `close` and the like), beyond its title "close tab or pane".
- `src/modules/command-palette/CommandPalette.tsx`, `commands.ts`: the command palette's fuzzy match folds this alias set in by `shortcutId`, so both entry points share one set of aliases.
- `scripts/dev/cdp-key.mjs`: it supports chords like `Ctrl+W` and any letter or digit, where it used to accept only 6 named keys; `--match` selects the page.

**WebGL fallback: premultiplied alpha, so a transparent terminal background works without WebGPU**

- `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts`: this fallback path creates its `webgl2` context with alpha and premultiplied; the clear colour is given premultiplied from the theme's `backgroundAlpha` (with the default background no rectangle is drawn, so the clear colour is the terminal background itself); both fragment shaders output premultiplied and blending uses `ONE`. With alpha 1 this is exactly equivalent to before, so opaque themes are unaffected.
- `src/modules/terminal/ghostty/webgl/WebGlTerminalSurface.ts`: the root element's placeholder background becomes `transparent` when the theme is translucent, matching the WebGPU path.
- `VERTA.md`: the sentence about the WebGL fallback having an opaque block now describes the premultiplied alpha behaviour.

**Tabs: the project list tab is now called "local projects"**

- `src/modules/i18n/messages.ts`: `tabs.new.projects` goes from "projects" to "local projects", mirroring the other tab "remote repositories". This single key drives both the tab title and the item in the tab bar's "+" menu, so both change together.

**Preview pane and the "new file" dialog hooked up to i18n**

- `src/modules/preview/PreviewPane.tsx`: the two empty-state sentences, the `Preview suspended` sentence and the `Reload` button go through `preview.empty.*`, `preview.suspended.*` and the existing `preview.reload`. The rounded `Ports` chip inside the empty-state body is split into a before and an after segment (`preview.empty.before` / `.after`) wrapped around it.
- `src/modules/preview/PreviewAddressBar.tsx`: the `Ports` label in the address bar goes through `preview.ports`.
- `src/modules/editor/NewEditorDialog.tsx`: the title reuses `explorer.newFile`, the description and the two validation messages gain `editor.newFile.*`, cancel and create reuse `scm.common.cancel` / `scm.common.create` as the other dialogs do, and "no workspace root" reuses the command palette's `cmd.noWorkspaceRoot`. The validation messages store **keys** rather than sentences (so switching language while the dialog is open follows along); raw error strings thrown back by the backend are still shown verbatim.
- `src/modules/i18n/messages.ts`: the 9 new keys above, in both languages.

**Close dialogs: copy of the five dialogs hooked up to i18n**

- `src/app/components/CloseDialogs.tsx`: the copy of the five confirmation dialogs (unsaved files, processes still running in a terminal, file already deleted, close to the right / close other tabs, quit the app) goes through `closeDialog.*`, with titles reusing `tabs.unsaved` / `tabs.closeRight` / `tabs.closeOthers` and cancel reusing `scm.common.cancel`. The message table has no plural rules, so the two builders (`appCloseMessage` / `closeManyMessage`) return only `{ key, params }` while the sentences and fragments (`closeDialog.frag.*`) live in the table.
- `src/modules/i18n/messages.ts`: 29 new keys, in both languages.

**The source control panel's target is recorded per workspace root**

- `src/modules/source-control/repositoryTarget.ts`: the pinned repository is now recorded per **workspace root** (environment + root path), the same approach as `useFileTree`'s scopeKey in the explorer, so changing project within one environment moves the changes list and the commit graph with it; new `repositoryTargetScope` does that assembly.
- `src/app/App.tsx`, `src/modules/source-control/index.ts`: use the new scope key; `isRepositoryContextCurrent` now only re-checks that the environment has not changed.
- `src/modules/source-control/repositoryTarget.test.ts`: three cases now assert "bucketed by root", plus a new case for changing project in the same environment.

**The screenshot overlay window can read its preferences**

- `src-tauri/capabilities/screenshot.json`: `store:default` is added (matching the main window), so the overlay window can read preferences to colour the selection, handles and action bar per the current theme; the description now states that it listens for the arm event and reads preferences.

**UI copy long tail: tab names, source control panel, Git history panel**

- `src/modules/tabs/lib/useTabs.ts`: the fallback tab name strings (the commit history title `History · {branch}` / `Git History`, `preview` when naming a preview tab by url fails, and `shell` / `blocks` for terminal and command block tabs) are generated with `t(...)` before being handed to the planning functions: `planCommitHistoryOpen` takes `{ repoRoot, title }`, the same approach as `planProjectsOpen`, so the planners stay pure. The three fallback strings are computed at the top of the hook, since `t` is shadowed by the tab array inside `setTabs((t) => ...)`.
- `src/modules/tabs/lib/serialize.ts`, `useTabRestore.ts`: the preview fallback name on restore is language-dependent too (only the url is persisted and the name is computed at restore time); restore reads the copy through a ref so it does not re-run on a language switch.
- `src/modules/tabs/lib/planCommitHistoryOpen.test.ts`: three cases changed to "the title is supplied by the caller", plus a new case asserting the planner does not invent a title.
- `src/modules/source-control/SourceControlPanel.tsx`: 21 strings hooked up to `t()` (branch dropdown, status, commit box, file list, context menu and discard confirmation). The `to commit` line under the commit box is "commit", and `Commit with {shortcut}.` is in the table too (the shortcut itself is a key name and is not translated). Existing `scm.*` keys were reused wherever possible.
- `src/modules/git-history/GitHistoryPane.tsx`, `lib/remoteWebUrl.ts`: 34 strings hooked up to `t()` (table headers commit / subject / author / date / changes, loading and empty states, `Copy SHA` / `Copied`, the author fallback name, the file-count sentence and the `View on GitHub` button group). `normalizeError` takes one more parameter, an already-translated fallback, and `hostLabel` takes an optional set of strings (English by default, so the pure functions and the unit tests are unaffected).
- `src/modules/i18n/messages.ts`: new `tabs.preview` / `tabs.shell` / `tabs.blocks`, 29 `gitHistory.*` and 18 `scm.*` keys, in both languages.

**UI copy long tail (second round): explorer, source control hook layer, settings page and shell, terminal and editor, updater / LSP / preview**

- `src/modules/explorer/**` (18 keys): the search results context menu no longer shows the hardcoded `Reveal in Finder` on Windows; both call sites branch on platform, `IS_MAC ? t("explorer.revealFinder") : t("explorer.revealManager")`, matching how `SourceControlPanel` does it. The search empty state and "showing partial results", the delete and drag-and-drop item counts, the clipboard and paste / copy / move failure toasts, and the duplicate-name replace confirmation all went into the table.
- `src/modules/source-control/useSourceControlPanel.ts`, `useRepositoryTargeting.ts` (11 keys): the four `pushHint` variants on the push button tooltip, the feedback bars after commit / push, "N unstaged files" in the discard confirmation, two toasts, and the fallbacks of the two `normalizeError` calls, which now take an already-translated fallback parameter following `GitHistoryPane`. The spot in `useSourceControl.ts` that must not re-run on a language switch reads the copy through a ref.
- `src/settings/sections/*`, `src/settings/components/LspInstallDialog.tsx`, `src/components/WindowControls.tsx`, `src/modules/statusbar/CwdBreadcrumb.tsx` (39 keys): font weight and cursor shape dropdowns, the recording indicator, theme import failure, the eight states of the update button on the about page, the formatter selection, the LSP install dialog, the window controls' `aria-label` and tooltips, and the breadcrumb (home directory / no directory / no subfolders).
- `src/modules/terminal/**`, `src/modules/editor/lib/useDocument.ts` (21 keys): the terminal cannot-display / cannot-start / session-kept error states, block copy and find, the input placeholder (**double spaces preserved exactly**), the output paused / failed / waiting toasts, and the save conflict dialog. Only those four toasts are translated in `lib/pty-bridge.ts`; invoke command names, protocol fields and the `"running" | "stalled" | "failed"` status enum are untouched. That module is not a component, so it gains an optional `notices` parameter through which the hook passes the current language's strings.
- `src/modules/updater/UpdaterDialog.tsx`, `src/modules/lsp/**`, `src/modules/markdown/**`, `src/components/chat-code.tsx` (46 keys): the eight states of the update dialog, the LSP status card and the crash / exit / start-failure toasts, `LspSessionLabels` for document extensions (module-level code, so a parameter carries the copy), the markdown preview's loading / binary / too-large states and the "rendered / source" toggle, and chat-code's generating / sent / run.
- `src/modules/i18n/messages.ts`: 135 new keys, in both languages. Existing keys were reused wherever possible (`explorer.revealFinder`, `explorer.loading`, `scm.unknownError`, `lsp.stopped`, `common.copyCode` and others); strings like "Retry" stay local to each module per the "each module emits its own keys" convention.
- Two strings that used to carry an em-dash are now hyphens: `Check failed - retry` in the settings update failure and markdown's `Binary file - cannot render as markdown.`
- Explicitly **not translated** (dead strings with no consumer, protocol surface, or technical diagnostics): `statusLabel` and `stagedEmptyText` / `unstagedEmptyText` in `useSourceControlPanel.ts` (nothing reads them), the ghostty renderer's internal diagnostic strings, `pty-bridge`'s protocol fields and status enum, the unreachable fallback placeholder in `block/lib/shellEditor.ts` (`ShellInput` always passes `placeholderText`), tool proper names, and unit symbols like `ms` / `px`.

**UI copy long tail (third round): repository-wide scan to fill the gaps**

This round is scan-driven across nine shapes: bare JSX text, string literals and JSX expressions in `title`/`aria-label`/`placeholder`, `toast(...)`, English sentences in template strings, English strings in object arrays, native `alert`/`confirm`, `sr-only`, static HTML, and strings on the Rust side that reach the UI.

- `src/modules/tabs/TabBar.tsx`: `Rename` / `Close` in the tab context menu go through the existing `tabs.rename` / `tabs.close`, where they were hardcoded (the same menu already used `tr(...)` for "close to the right" and "close others"). Verified on the running app: the menu now reads rename tab, close tab, close all to the right, close other tabs.
- `src/app/components/WorkspaceInputBar.tsx`: the branch chip's `` title={`Branch: ${branch}`} `` becomes `t("workspace.branchChip")` (that chip only appears on command block tabs).
- `src/modules/preview/PreviewAddressBar.tsx`: `` setNotice(`No server listening on :${port}.`) `` becomes `t("preview.noServerOnPort")`.
- `src/app/hooks/useAppCloseGuard.ts`, `useWorkspaceSwitcher.ts`: the window close failure toast and the native long prompt before switching workspace; the latter reads the copy through a ref, so the callback's identity does not change on a language switch, following the precedent in `useTabRestore.ts`.
- `src/modules/editor/EditorStack.tsx`, `GitDiffPane.tsx`: `renderedHint="Save to preview"`, diff preview unavailable / binary / file too large / loading diff. The translation function inside `EditorStack` is named `tr`, because `t` is already taken by the tab object in `.map((t) => …)`.
- `src/modules/editor/EditorPane.tsx`: 14 spots: the language server format success / failure toasts, `Binary file` / `File too large` / `Hide preview` / `Show preview` / `Original size` / `Fit to window`, `Loading…` / `Open anyway` / image unreadable. **Only the copy lines were touched.** The key-name parser (`Mod-s` / `Ctrl-g`) and the extension table are not translated.
- `src/components/ui/*` (shadcn primitives): `breadcrumb`'s `sr-only` "More" and `aria-label="breadcrumb"`, `dialog` / `sheet`'s `sr-only` "Close", the **visible** `Close` button in `dialog`, and `command`'s two default parameters. This is a one-time exception hand-editing primitives, with `spinner.tsx` already using `t("common.loading")` as precedent; `command.tsx` drops the default values and falls back with `?? t(...)` in the component body, leaving the signature unchanged. `VERTA.md` records this exception as a rule.
- `src/modules/i18n/messages.ts`: 29 new keys, reusing `tabs.rename` / `tabs.close` / `palette.title` / `editor.hidePreview` / `editor.showPreview` / `editor.preview.title`.
- Two things noted in this round and **left for the next one**: ① several groups of **synonymous keys** in `messages.ts` (`editor.hidePreview` alongside `editor.preview.hide`, and `preview.show` / `preview.hide` / `preview.label`), whose deduplication spans several files; ② English coming from the backend (Rust's `Added` / `Modified` status labels, theme validation strings, the updater's `status.message`, LSP stderr) and the two window titles.

**UI copy wrap-up: synonymous keys and English coming from the backend**

- `src/modules/i18n/messages.ts`: the "editor preview toggle" group of synonymous keys is folded into one pair: `SidePreview.tsx` uses `editor.preview.hide`, while `EditorPane.tsx` used `editor.hidePreview` / `editor.showPreview`, now unified as `editor.preview.hide` / `editor.preview.show`, and three dead keys **referenced by nothing in the repository** are removed (`preview.hide` / `preview.show` / `preview.label`).
  The other ninety-odd groups of synonymous keys are all kept: they follow the "each module emits its own keys" convention (7 instances of "cancel", 5 of "retry", 4 of "refresh", 5 of "close"), and many are **dynamic keys** (`` t(`shortcut.${id}`) ``, `` t(`cmd.${id}`) ``) that a static script judging "unused" would misclassify as dead, because those keys are assembled from template strings at the call site rather than written out. The audit script's conclusions (`.superpowers/keys-audit.mjs`, reusable) are recorded for later reference.
- `src/modules/editor/EditorPane.tsx`: those two `tr(...)` calls follow to the new keys (`tr` is the translation alias in that file).
- `src/modules/git-history/GitHistoryPane.tsx`: the file row's `title` now maps the status from Rust (`Added` / `Modified` / `Deleted` / `Renamed` / `Copied` / `Unmerged` / `Untracked`) to `gitStatus.*`, and **values the map does not match pass through as is**. **Not a byte changed on the Rust side**: the labels in `status_label_for` / `parser.rs` stay, and the frontend no longer depends on them.
- ⬜ **Not done** this round, left for the next one: ① the validation strings in `src/modules/theme/validateTheme.ts`, which returns whole English sentences that `validateTheme.test.ts` asserts, so changing them changes the return contract and the tests; ② the updater's `status.message` (a string from the plugin) and the LSP stderr tail (diagnostic data); ③ the two **window titles** (`Verta` and `Settings` joined by an em-dash).
</details>

<details>
<summary><strong>2026-10-21</strong></summary>

**Tabs: drop "spaces" and keep a single tab list**

- `src/modules/spaces/**` (14 files), `src/modules/i18n/spaceName.ts`: the whole spaces module and `spaceName` are
  deleted; `src/modules/spaces/lib/serialize.ts` and `activeSpace.ts` moved into the tabs module.
- `src/modules/tabs/lib/useTabs.ts`: `Tab.spaceId`, `DEFAULT_SPACE_ID`, the per-space deduplication in the various
  `plan*` functions (open file / markdown / git diff / commit history / project list / remote repositories), space
  deletion and cross-space moves are removed; deduplication, closing and drag reordering act on one list.
  `nextActiveInSpace` is renamed `nextActiveTab`, and private tabs are still not persisted.
- `src/modules/tabs/lib/serialize.ts` (moved over from the spaces module, minus `spaceId`), plus new `tabStorage.ts`
  and `useTabRestore.ts`: the tab list is stored as a single `state` key in `verta-tabs.json`. On the first launch
  with the new format, the `state:<space id>` of the then-active space is read from the old `verta-spaces.json`,
  written into the new file and that key is deleted, leaving the old file on disk. Restore still returns each tab
  to its own environment (leaves record the environment, tabs that only recorded a cwd are inferred from the path),
  a cwd is authorized before the terminal opens, `usePreferencesStore.init()` is still called in exactly one place,
  and disk writes are still held back until restore finishes.
- `src/app/App.tsx`: space state, `SpaceSwitcher`, the six handlers that only fed it, the three space shortcuts, the
  five space commands in the command palette and "clicking a project row = switch to a space rooted at that project"
  are removed. A project row now switches to that project's environment (host / distro) and opens a terminal at the
  project root.
- `src/modules/header/Header.tsx`: the title bar slot reserved for the switcher is removed.
- `src/modules/source-control/repositoryTarget.ts`, `useRepositoryTargeting.ts`: the repository pinned in the right
  panel is recorded per **environment** (host / a given distro) rather than per space.
- `src/modules/control/lib/context.ts`, `useControlBridge.ts`: `space_id` is kept but fixed to `default`;
  `verta-cli identify` prints it.
- `src/modules/i18n/messages.ts`: the 14 space keys in both Chinese and English (`spaces.*`, `shortcut.nextSpace` /
  `prevSpace` / `openSpaces`, `cmd.spacesOverview` / `newSpace` / `switchToSpace` / `currentSpace`, `cmdGroup.Spaces`,
  `shortcutGroup.Spaces`) are deleted.
- `src/modules/shortcuts/shortcuts.ts`, `src/modules/command-palette/commands.ts`, `types.ts`,
  `CommandPalette.tsx`: the space shortcut group, the space commands and `spaceName` are removed.

**Area screenshot: no screen freeze like the system tool, and the capture happens on save**

- `src-tauri/src/modules/screenshot/mod.rs`: does **not freeze the screen**; the overlay window is transparent and
  only lays down a light gray wash, so the screen stays live while the selection is drawn. The capture moves to
  **the moment save is clicked**: the overlay is hidden first and the capture waits until it has really left the
  screen, so the gray wash, selection box, handles and action bar do not end up in the image; the whole thing runs
  on a blocking thread. The window is still **created once and kept** (each use only shows it: about 0.4 seconds to
  build the webview the first time, just over 0.1 afterwards); on failure the window is shown again with the
  selection intact, so it can be adjusted and saved again.
- `src-tauri/src/modules/screenshot/capture.rs`: new `virtual_screen_bounds()`: the capture and the overlay window
  take their extent from the same place, so selection coordinates line up; `RawShot` no longer carries an origin.
- `src-tauri/src/modules/screenshot/encode.rs`: the BMP preview encoder is deleted; only the PNG that gets saved
  remains.
- `src/modules/screenshot/ScreenshotOverlay.tsx`: **canvas and frozen frame removed**. A 25% light gray wash covers
  the screen; as soon as a selection is drawn the wash goes away and a shadow around the selection darkens the
  outside, the inside being a fully transparent hole that shows the live screen. A corner-radius slider (0-40,
  default **15**, WYSIWYG) and two icon buttons for save / cancel sit at the bottom right of the selection; stroke,
  handles and buttons take theme colors. After releasing the mouse the selection stays adjustable: drag the whole
  block, resize with the eight handles. Enter saves, Esc cancels, unchanged.
- `screenshot.html`, `src/screenshot/main.tsx`: this window **must be transparent**: both spots paint the background
  transparent and add the `.light` / `.dark` classes. If the window's own script crashes, it calls
  `screenshot_failed` to hide itself instead of leaving an unclickable gray layer in front of the user.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: `screenshot_begin` no longer returns the captured image;
  `screenshot_pending` / `screenshot_pixels` are deleted; the completion copy (no more "it is in the clipboard
  too") and the Rust-side error strings are reworded in a more formal tone.
- `src-tauri/capabilities/screenshot.json`: the overlay window's permissions shrink to "listen to events only";
  showing and focusing are done by Rust.
- `scripts/dev/probes/`: new acceptance probes: `screenshot-arm-timing-*` (measures "message received to first
  frame"), `capture-desktop.ps1` (captures the whole screen as evidence) and `screenshot-begin-timing.js` (measures
  only "click to gray wash appearing").

**Area screenshot: capture, select, save and clipboard all inside the app**

- `src-tauri/src/modules/screenshot/` (a new module, four files):
  - `capture.rs`: Windows captures the whole virtual desktop with GDI; the BGRA with garbage alpha is filled in as
    opaque RGBA so the saved PNG and the clipboard image are not semi-transparent; other platforms refuse honestly
    instead of pretending to work.
  - `geom.rs`: selection snapping (dragging back and dragging off-screen are handled correctly), cropping by
    selection, file names and local timestamps. All pure functions with unit tests.
  - `encode.rs`: PNG encoding via the `image` crate, with only the `png` feature enabled.
  - `mod.rs`: screenshot state and commands (`begin` shows the overlay window / `finish` hides the window, captures,
    crops, writes to disk, puts it on the clipboard / `cancel` / `failed`). Cropping uses the raw captured pixels,
    and the backend snaps the selection once more.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`: register the module, state and
  commands; windows-sys gains `Win32_UI_WindowsAndMessaging`.
- `src-tauri/capabilities/screenshot.json` (new): the overlay window gets its own **minimal** capability: events
  only, with show and focus done by Rust, and none of the store / dialog / opener permissions it does not need.
- `screenshot.html`, `src/screenshot/main.tsx`, `vite.config.ts`: the frontend entry of the second window (a
  transparent window), one more entry in the multi-page build.
- `src/modules/screenshot/ScreenshotOverlay.tsx` (new): light gray wash, drag a box (with a physical-pixel size
  hint), movable and resizable after release, corner-radius slider, save / cancel icon buttons, Enter to save, Esc
  to cancel; no screen freeze: the screen stays live.
- `src/modules/screenshot/lib/selection.ts` (new): CSS pixel ↔ physical pixel conversion (at 125% display scaling
  the two differ by a devicePixelRatio); rounding is "one column too many rather than one too few". With unit tests.
- `src/modules/header/Header.tsx`: a "screenshot" entry appears to the left of the Git button at the top right.
- `src/app/App.tsx`, `src/lib/native.ts`, `src/modules/i18n/messages.ts`: the completion toast (stating where it
  was saved and whether the clipboard worked, reported separately) and "insert path": clicking it inserts the path
  into the current terminal input line with bracketed paste, with no automatic insert and no Enter; on tabs that
  are not a terminal the button is not offered at all.
- `scripts/dev/cdp-input.mjs` (new) plus `scripts/dev/probes/` (the probes for this area and `capture-desktop.ps1`):
  send real input to a **specific** window and capture evidence for acceptance; `cdp-key.mjs` only ever finds the
  first page and the overlay window is the second, and mouse dragging needs a full press/move/release.

**Pi session list: show the latest session name**

- `src-tauri/src/modules/agent_sessions/pi.rs`: the session name is now found by searching backwards from the end of
  the file in blocks for `session_info`, taking the last name and reading that whole line at the match. The header
  window drops from 8 MB to 1 MB.

**Markdown preview: small images without a size are no longer stretched into a full-width banner**

- `src/modules/markdown/MarkdownImage.tsx`: images without a height are no longer pinned to `height: 260px` with
  `object-fit: contain`; they reserve 260px before load and go back to their own size once loaded (260px is only a
  cap). The sizing decision is a pure function `previewImageStyle`.
- `src/modules/markdown/MarkdownImage.test.ts`: new, covering the four branches.

**Markdown preview: inline images sit on one line again**

- `src/modules/markdown/MarkdownImage.tsx`: image `display` changes from `block` to `inline-block` (with
  `mr-2 last:mr-0`), so several images in one line display side by side with spacing between them.

**Fonts: pick an installed font from a dropdown (terminal and editor share one font)**

- `src-tauri/src/modules/fonts.rs`: new, lists installed font families (Windows GDI `EnumFontFamiliesExW` / Linux
  `fc-list` / macOS `system_profiler`); new command `fonts_list`.
- `src/lib/fontOptions.ts`, `src/settings/components/FontPicker.tsx`, `src/settings/lib/useInstalledFonts.ts`: new;
  the options are "auto-detect" plus installed fonts (the current value is listed and marked even when it is not
  installed), searchable.
- `src/settings/sections/GeneralSection.tsx`, `src/modules/i18n/messages.ts`: the font row becomes a dropdown, and
  the description states that the terminal and the editor share it.
- `src/modules/settings/store.ts`: the default for `terminalFontFamily` changes from empty to `Cascadia Code`
  (stored values are untouched).
- `src/lib/fonts.ts`: the terminal font stack is "selected font → auto-detected Nerd Font (icons) → fallback chain".
- `src/modules/editor/lib/useApplyEditorFontFamily.ts`, `src/modules/editor/lib/extensions.ts`: the editor font goes
  through the `--editor-font-family` variable.
- `src-tauri/Cargo.toml`: `windows-sys` gains the `Win32_Graphics_Gdi` feature.

**GitHub: account and sign-in**

- `src-tauri/src/modules/github/auth.rs`: new. Parses `gh auth status --json hosts` (picks the active account, splits
  scopes, does not crash on missing fields), and rejects obviously wrong pasted tokens locally.
- `src-tauri/src/modules/github/gh.rs`: extracts `command()` (arguments passed one by one, interactive prompts off,
  proxy applied, console hidden); new `spawn` / `pump` / `run_with_stdin`; new `AUTH_TOKEN_TIMEOUT_SECS` /
  `AUTH_WEB_TIMEOUT_SECS`.
- `src-tauri/src/modules/github/types.rs`: new `AuthStatusPayload` / `AuthActionPayload` / `AuthLoginProgress`.
- `src-tauri/src/modules/github/commands.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_auth_status` /
  `github_auth_login_token` / `github_auth_login_web` (streams the one-time code gh prints to the UI in real time,
  cancellable) / `github_auth_login_web_cancel` / `github_auth_logout`, plus `AuthLoginState`.
- `src/lib/native.ts`: new wrappers and wire types for those five.
- `src/modules/remotes/lib/auth.ts`: new. Folds the sign-in state into what the UI needs, detects a missing
  `delete_repo` authorization, and pre-checks a pasted token locally.
- `src/modules/remotes/AuthDialog.tsx`: new. Current state / browser authorization (live output of the one-time code,
  cancellable) / paste a PAT (the input is cleared immediately on submit) / sign out (the confirmation states the
  consequences first).
- `src/modules/remotes/RemoteReposView.tsx`: the account in the page header becomes an entry point; a prompt block
  for "not signed in / gh not installed" gains an entry point too; the list is re-read when the panel closes.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `scripts/dev/probes/auth-acceptance.mjs`: new; acceptance script for the account panel (the `--isolated` run
  exercises the "not signed in" flow in a temporary `GH_CONFIG_DIR`).

**GitHub: repository management (edit description / switch visibility / delete repository) and clone locally**

- `src-tauri/src/modules/github/repo_admin.rs`: new. Reads `gh repo view --json description,visibility,viewerPermission`;
  descriptions over 350 characters are rejected locally; recognizes the recoverable "gh lacks the delete_repo
  authorization" failure.
- `src-tauri/src/modules/github/permission.rs`: new `admin_allowed` (only `ADMIN` counts as administrator; an unknown
  or unresolvable level counts as allowed to change).
- `src-tauri/src/modules/github/types.rs`: new `RepoSettingsPayload` (`can_admin` is still true on failure) and
  `RepoActionResult`.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_settings` /
  `github_repo_set_description` / `github_repo_set_visibility` / `github_repo_delete` (60 second timeout; after the
  delete request it re-queries `gh api repos/{slug}` and only a 404 counts as success; when the delete_repo
  authorization is missing, the command to run is included in the error text).
- `src/lib/native.ts`: new `githubRepoSettings` / `githubRepoSetDescription` / `githubRepoSetVisibility` /
  `githubRepoDelete` and wire types.
- `src/modules/remotes/lib/repoAdmin.ts`: new. `canAdmin` (unresolved / unfetchable counts as allowed to change), the
  read-only prompt key, `isPrivateVisibility`, the "type the full name" check for deleting a repository, the
  description length, and the adjacent-path guess for a clone target directory.
- `src/modules/remotes/RepoAdminDialog.tsx`: new. Description saving, visibility switching (each of public / private
  gets its own consequence confirmation) and a danger zone (the delete button only appears once the full repository
  name is typed; after deletion the result is reported back so the list can drop that row); none of the three entry
  points render for non-admins.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "clone locally…" and "repository settings…"; a
  successful description / visibility change updates only that row; the clone and settings dialogs are wired in.
  Fixed: clicking a menu item also triggered the row click (and "repository settings…" therefore also opened the
  runs panel); the click is now intercepted on the menu content.
- `src/modules/remotes/RunListDialog.tsx`: fixed: clicking the confirmation dialog (AlertDialog) no longer closed the
  panel too; it no longer closes while the confirmation is open.
- `src/modules/projects/CloneRepoDialog.tsx`: optional prefilling of the URL and target directory (used when entering
  from a remote repository row).
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `scripts/dev/probes/repo-admin-acceptance.mjs`: new; acceptance script for repository management and cloning.

**GitHub: permission gate**

- `src-tauri/src/modules/github/permission.rs`: new. Reads `gh repo view --json viewerPermission`, treating `TRIAGE` /
  `READ` as not writable; an unknown or unresolvable level counts as writable (the button is still offered and GitHub
  gets to refuse).
- `src-tauri/src/modules/github/types.rs`: new `RepoPermissionPayload`; `can_write` is still true on failure.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_permission`
  command (30 second timeout) and its registration.
- `src/lib/native.ts`: new `githubRepoPermission` and `WireRepoPermissionPayload`.
- `src/modules/remotes/lib/permission.ts`: new. `canWrite` (unresolved / unfetchable counts as writable) and the
  read-only prompt key.
- `src/modules/remotes/RunListDialog.tsx`: checks that repository's permission once on open; when not writable it does
  not render rerun / cancel / delete and adds a read-only note.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the read-only note.
- `scripts/dev/probes/permission-acceptance.mjs`: new; acceptance script for the permission gate.

**GitHub: releases and asset downloads**

- `src-tauri/src/modules/github/releases.rs`: new. Parses the release list, pre-checks asset file names on disk,
  thresholds progress coalescing, renames `<name>.verta-part` only on success (on failure only the temporary file is
  deleted), and keeps a per-id cancel flag.
- `src-tauri/src/modules/github/types.rs`: new `RepoRelease` / `RepoReleaseAsset` / `RepoReleasesPayload` /
  `ReleaseDownloadProgress` / `ReleaseDownloadResult`.
- `src-tauri/src/modules/github/commands.rs`: new `github_releases`; new `github_release_download` (streams gh output,
  45 second stall and 30 minute total timeout, a byte count that does not match the asset size counts as failure,
  progress emitted over `verta://github-download`) and `github_release_download_cancel`.
- `src-tauri/src/modules/github/mod.rs`, `src-tauri/src/lib.rs`: register the new module, the three commands and
  `DownloadState`.
- `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `package.json`, `pnpm-lock.yaml`,
  `src-tauri/Cargo.lock`: add `tauri-plugin-dialog` and `@tauri-apps/plugin-dialog`, with only the
  `dialog:allow-open` permission granted.
- `src/lib/native.ts`: new `githubReleases` / `githubReleaseDownload` / `githubReleaseDownloadCancel` and wire types.
- `src/modules/remotes/lib/releases.ts`: new. List mapping, size and speed copy, percentages, progress smoothing.
- `src/modules/remotes/lib/pickDownloadDir.ts`: new. Directory picking, defaulting to the system downloads folder and
  falling back to the home directory.
- `src/modules/remotes/ReleasesDialog.tsx`: new. List → detail, with progress events claimed by download id.
- `src/modules/remotes/ReleaseDetail.tsx`: new. Asset rows with download / progress / speed / cancel / open containing
  folder, and the body rendered with a lazily loaded Markdown renderer.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "releases…".
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `README.md`: the feature table gains releases and asset downloads.
- `scripts/dev/probes/releases-acceptance.mjs`: new; acceptance script for releases and asset downloads.

**Documentation reconciliation**

- `VERTA.md`: removed the section on the built-in agent; the module list gains `launcher` / `projects` / `remotes` /
  `i18n`, the Rust command list gains `agent_sessions` / `projects` / `github`; tab kinds gain `projects` /
  `remotes`; the Git panel is now documented as the right panel, with the sidebar keeping only sessions and files;
  references to the removed performance scripts are gone; added unsaved draft backups, terminal session images,
  Markdown image sizing and release downloads; the gate command is now `cargo test --lib`; two statements that no
  longer matched the code (image authentication, secret deny-list) are removed.
</details>

<details>
<summary><strong>2026-10-20</strong></summary>

**GitHub: the CI badge follows the runs panel, duplicate entry point removed**

- `src/modules/remotes/lib/runs.ts`: new `ciFromRuns` (folds the runs list into what that one CI badge should show: the newest run is the badge; an empty list is a confirmed "no runs"; a failed query is passed through as is); with unit tests. The runs panel is now the single source for the badge.
- `src/modules/remotes/RunListDialog.tsx`: new `onLoaded`, called once each time the runs list is fetched (including the reconciliation after a delete).
- `src/modules/remotes/RemoteReposView.tsx`: wired to `onLoaded`, so a freshly loaded panel updates that row's badge with its newest run; the duplicate "check CI" item in the row menu is removed (hover auto-query and clicking the badge to query on demand both stay).

**GitHub: delete a run; clicks no longer jump to the browser**

- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: `RunAction` gains a `Delete`, plus a new `github_run_delete` (`gh run delete <id> --repo <slug>`). Rerun / cancel / delete share one path, with the same pre-checks, failure classification and raw-text pass-through. **After deleting, whether that run still exists is re-checked** (`repos/{o}/{r}/actions/runs/{id}`): only an explicit 404 reports success, a run still there is reported as "possibly not deleted", and anything unclear (rate limiting / a flaky proxy / permissions) carries its reason out.
- `src-tauri/src/modules/github/actions.rs`: new `classify_run_probe` (the re-check verdict: gone / still there / unclear) and `RunProbe`, with unit tests.
- `src/modules/remotes/RunListDialog.tsx`: a "delete" item in the row, offered only for finished runs (GitHub does not allow deleting a running one); the confirmation states that logs and results are deleted with it and cannot be restored, and on failure keeps gh's own wording in the confirmation. After the delete is **confirmed by the backend re-check**, the UI drops that row immediately and reconciles in the background; freshly deleted ids are also recorded and filtered out on refresh (only "confirmed deleted" ids are filtered; failed deletes always stay in the list).
- `src/modules/remotes/RemoteReposView.tsx`: clicking a repository row and clicking the CI badge both open that repository's runs panel inside the app ("open in browser" stays only in the row menu).
- `src/modules/remotes/lib/runs.ts`: new `canDelete` (only finished runs can be deleted) and `withoutRun` (drop a row by id); with unit tests.

**GitHub: run detail inside the app (jobs / steps / logs)**

- `src-tauri/src/modules/github/actions.rs`: new `parse_jobs` (reads `actions/runs/{id}/jobs`, including the step tree), `parse_log` (splits `job\tstep\t<time> body` into three parts; lines whose prefix is not recognized are kept as is, lines are never dropped; the BOM before the first line's timestamp is stripped), `cap_lines` (only the last `MAX_LOG_LINES = 2000` log lines are kept). With 7 unit tests.
- `src-tauri/src/modules/github/types.rs`: new `RepoRunJob` / `RepoRunStep` / `RepoRunJobsPayload` / `RepoRunLogLine` / `RepoRunLogPayload`. The two kinds of log truncation are reported separately: `clipped` (only the tail was kept) and `capped` (a per-request limit was hit and the beginning was received), and the UI words them differently.
- `src-tauri/src/modules/github/gh.rs`: `GhOutput` carries `stdout_truncated`, and `run_with_cap` is split out of `run`; logs get their own 90 second and 8 MB limits (`LOG_TIMEOUT_SECS` / `LOG_STDOUT_CAP`).
- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: new `github_run_jobs` and `github_run_log` (`failed_only` goes through `gh run view --log-failed`).
- `src/modules/remotes/RunDetail.tsx`: new. In-app run detail: job and step tree (a status per step), a log pane (time + step shown only when it changes + coloring by `##[error]` / `##[warning]`), a "failures only" toggle, and a separate notice per truncation kind; "open on GitHub" is a secondary exit.
- `src/modules/remotes/RunListDialog.tsx`: the row's "open browser" becomes "detail", switching views inside the same dialog (no stacked dialogs).
- `src/modules/remotes/lib/runs.ts`: new `logLineTone` (error / warning / group / normal) and `logClock`; with unit tests.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: command wrappers and Chinese / English copy.

**Layout: both gutters are the same width**

- `src/app/App.tsx`: the middle area's padding changes from `pl-0.5 pr-2` to `pl-0.5 pr-0.5`. Both gutters are now 2px + 4px separator + 2px = 7.58px, and the outer margin on both sides of the window still comes from the sidebar's `pl-2` and the right panel's `pr-2`, 8px each.

**GitHub: runs list (with rerun / cancel)**

- `src-tauri/src/modules/github/actions.rs`: new. Parses the runs list `repos/{owner}/{repo}/actions/runs?per_page=N`. Tolerant per entry (entries missing id / status / html_url are dropped, other missing fields are treated as empty); "the response had entries and none of them survived" is reported as a parse failure, not as "no runs". With 7 unit tests.
- `src-tauri/src/modules/github/types.rs`: new `RepoActionRun` / `RepoActionRunsPayload` / `RepoRunActionResult`, an empty list maps to `none` (the same kind set as the CI call); the `failed` "never return an empty error" rule is folded into a small helper, which the CI call uses too.
- `src-tauri/src/modules/github/commands.rs`: new `github_repo_runs` (one repository at a time, count clamped to 1..=50, default 20), `github_run_rerun`, `github_run_cancel` (internally `gh run rerun/cancel <id> --repo <slug>`). The run id is an integer; 0 is rejected locally.
- `src-tauri/src/lib.rs`, `gh.rs`, `mod.rs`: register the three commands and `RUN_ACTION_TIMEOUT_SECS`.
- `src/modules/remotes/RunListDialog.tsx`: new. Lists the latest 20 runs: status badge, workflow · branch · #number, event, raw conclusion, relative time, plus an "open" link. Rerun and cancel both need confirmation; on failure gh's own wording stays in the confirmation (on success the dialog closes first and then refreshes).
- `src/modules/remotes/lib/runs.ts`: new. The per-row view rules (only finished runs can be rerun; cancel only applies before that) and time parsing; with 4 unit tests.
- `src/modules/remotes/lib/ci.ts`: `runState` / `runDetail` / `TONE_CLASS` are extracted for the CI column and the runs list to share; `timed_out` had a red badge but read "finished", and now reads as a failure.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "runs…".
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: command wrappers and Chinese / English copy.

**UI copy: input placeholders that never adapted to Chinese**

- `src/modules/command-palette/CommandPalette.tsx`: the command palette's four placeholders (default / theme / file contents / command history) now go through i18n.
- `src/modules/header/SearchInline.tsx`: "Search" and "Git search" in the header search box now go through i18n (the shortcut suffix is still concatenated as before).
- `src/modules/explorer/FileExplorer.tsx`, `src/modules/explorer/TreeRow.tsx`: the inline placeholders for new file / new folder now use `explorer.newFile` / `explorer.newFolder`.

**GitHub: CI status column (remote repository list)**

- `src-tauri/src/modules/github/ci.rs`: new. Parses the latest run of `repos/{owner}/{repo}/actions/runs?per_page=1`; plus a pre-check on `owner/repo` (empty values, a leading `-`, no slash, multiple segments, out-of-charset values are all rejected locally).
- `src-tauri/src/modules/github/types.rs`: new `RepoCiRun` / `RepoCiPayload`, and one more kind, `none`: "confirmed there are no runs" is kept apart from a failure.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_ci` command (one repository at a time, 30 second timeout), reusing the repository list's "gh not installed / not signed in / other failure" classification and raw-text pass-through.
- `src/modules/remotes/RemoteReposView.tsx`: the repository list gains a CI column. Only the row the pointer is on gets queried; the row menu also has a "check CI" that forces a re-query; clicking the badge opens this run's URL.
- `src/modules/remotes/lib/ci.ts`: new, folds status/conclusion into "what to say, what color, where it links"; with 7 unit tests.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: command wrappers and Chinese / English copy.

**Git panel: branch create / rename / delete, worktrees, commit-level actions**

- `src-tauri/src/modules/git/types.rs`: `MAX_TIMEOUT_SECS` goes up to 900 seconds, and cloning uses its own `CLONE_TIMEOUT_SECS`.
- `src-tauri/src/modules/git/errors.rs`: new `InvalidRefName`; empty names and names starting with `-` are rejected here, and errors show the value quoted so an empty value is visible too.
- `src-tauri/src/modules/git/operations.rs`: new branch create / rename / delete, worktree add / remove, cherry-pick, revert, soft reset, abort cherry-pick/revert, and repository clone. Names, revisions and clone URLs are pre-checked (blocking empty values and `-`-leading argument injection), with the rest of validity left to git; a new directory's parent must exist first and be registered as authorized (the path the user typed is itself the authorization).
- `src-tauri/src/modules/git/commands.rs`, `src-tauri/src/lib.rs`: register the corresponding ten commands.
- `src/lib/native.ts`: wrappers for those commands.
- `src/modules/source-control/SourceControlPanel.tsx`: branch rows and worktree rows become submenus (switch / rename / delete, open / remove), plus two entry points, "new branch" and "new worktree".
- `src/modules/source-control/BranchDialogs.tsx`: five new dialogs. Deleting a branch and removing a worktree are first attempted the normal way; when git refuses, its wording stays in the dialog and a "force delete (-D)" / "force remove" is offered.
- `src/modules/git-history/CommitActions.tsx`: new, cherry-pick / revert / soft reset in the commit detail. On success the dialog closes first and then refreshes; on failure git's wording stays in the dialog and the stuck step can be aborted directly.
- `src/modules/git-history/GitHistoryPane.tsx`: wired to those three actions, re-reading the commit list afterwards.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.

**Projects page: clone a repository**

- `src/modules/projects/CloneRepoDialog.tsx`: new; enter a repository URL and a target directory, and the clone is added to the project list afterwards.
- `src/modules/projects/ProjectsView.tsx`: the projects page gains a "clone repository…" entry point.

**Editor: backup of unsaved content (nothing is lost when editing is interrupted)**

- `src/modules/editor/lib/drafts.ts`: new. After changes, the buffer is mirrored into `verta-drafts.json`: 1 MB per draft, at most 8 drafts, 4 MB total, the oldest dropped when exceeded; keys normalize path separators but do **not** fold case. With 11 unit tests.
- `src/modules/editor/lib/useDocument.ts`: the mirror runs only once typing has stopped for 1.5 seconds; the draft is deleted only on a successful save or when the user chooses to discard; closing a tab (unmount), the window losing focus and closing the window all flush immediately. When a file is opened (including tabs restored after a crash) and the disk content differs from the draft, "restore / discard" is handed to the UI.
- `src/modules/editor/EditorPane.tsx`: a restore notice with the interruption time at the top of the editor; it does not block editing and does not change the file automatically: restoring only puts the content back into the buffer, and saving is up to the user.
- `src/modules/i18n/messages.ts`: Chinese and English copy for this notice.

**Tests**

- `src/modules/terminal/ghostty/AdaptedGhosttyGpu.test.ts`: the hundred-thousand-update stress case gets a 60 second timeout.

**Acceptance scripts**

- `scripts/dev/probes/click-remotes.js`: deleted, an old probe for the remote repository panel.
</details>

<details>
<summary><strong>2026-10-19</strong></summary>

**Git panel: stash**

- `src-tauri/src/modules/git/types.rs`: new `GitStashEntry`, carrying the reference, index, message and branch.
- `src-tauri/src/modules/git/parser.rs`: new `parse_stash_list`, parsing the NUL-separated output of `git stash list`; when no branch can be parsed out of the message it is left empty rather than invented. With three unit tests.
- `src-tauri/src/modules/git/operations.rs`: new `stash_list`, `stash_push` (optional message and `--include-untracked`), `stash_apply`, `stash_pop`, `stash_drop`, all through the existing authorization and timeout wrappers.
- `src-tauri/src/modules/git/commands.rs`, `src-tauri/src/lib.rs`: register the corresponding five commands.
- `src/lib/native.ts`: new `GitStashEntry` type and `gitStashList` / `gitStashPush` / `gitStashApply` / `gitStashPop` / `gitStashDrop`.
- `src/modules/source-control/StashSection.tsx`: new, the stash area at the bottom of the Git panel. Collapsed by default and only read when expanded; a message can be entered and untracked files optionally included; each stash's menu offers apply, apply and drop, and drop. Dropping needs confirmation first.
- `src/modules/source-control/SourceControlPanel.tsx`: the stash area is wired in below the file list, and the panel refreshes after an operation.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the stash area.

**Installer copy**

- `src-tauri/tauri.conf.json`: `shortDescription` and `longDescription` no longer mention an AI-native terminal, voice input or AI agents and now describe the product; NSIS gains Simplified Chinese and the language selection is enabled.
</details>

<details>
<summary><strong>2026-10-18</strong></summary>

**App icon (brand assets)**

- `assets/icon-stroke.svg`: new, a hand-drawn vector app icon (dark rounded base + white V), replacing the upstream icon.
- `src-tauri/icons/**`: the full platform icon set (`.ico`/`.icns`, the Windows Store variants, Android/iOS) regenerated
  from that vector with `pnpm tauri icon`, replacing the upstream artwork.
- `public/logo.png`: replaced with a 256px render of the same vector, used by the page head, the about page and the terminal watermark.

**Remote repository panel (new feature)**

- `src-tauri/src/modules/github/**`: new, one `github_repos` command reading the repositories the account can access through
  the locally signed-in `gh` (pagination, parsing and failure classification as pure functions with unit tests).
- `src-tauri/src/modules/proxy.rs`: new, prepares a proxy address for external programs (explicit argument > environment
  variable > system registry) and injects it into child processes after clearing inherited proxy variables; `gh` already uses it.
- `src-tauri/Cargo.toml`: enables the `Win32_System_Registry` feature on `windows-sys`.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`: register the new module and command.
- `src/modules/remotes/**`: new, the remote repositories tab (row mapping, filtering, four-state notices with unit tests).
- `src/lib/native.ts`: new `githubRepos` and wire types.
- `src/modules/tabs/**`: new `remotes` tab type and `planRemoteReposOpen`, plus the tab bar icon.
- `src/modules/header/Header.tsx`: a remote repositories entry point at the top right.
- `src/modules/command-palette/commands.ts`: one new command, "open remote repositories list".
- `src/app/App.tsx`, `src/app/components/WorkspaceSurface.tsx`: wired to the middle-area tabs.

**Environment for resuming a session**

- `src/modules/launcher/lib/openSession.ts`: new, computes the environment together with the resume command, so a host session no longer
  lands in a distro terminal.
- `src/modules/launcher/index.ts`, `src/app/App.tsx`: switched to that pure function.

**Git panel on the right and the projects entry point**

- `src/modules/sidebar/**`: the Git view is removed from the sidebar (`SidebarViewId` keeps only sessions and files), and a new
  `useRightPanel` manages the right panel's width and collapsed state.
- `src/modules/source-control/**`: panel visibility is decided by "is the right panel expanded" instead of "is Git selected in the sidebar".
- `src/modules/header/Header.tsx`: a right panel toggle at the top right, which also takes over the change-count badge.
- `src/modules/projects/**`, `src-tauri/src/modules/projects/**`: the project list tab, scanning and status queries.
- `src/modules/tabs/lib/useTabs.ts`: new `projects` tab type and `planProjectsOpen`.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.

**Repository cleanup and branding**

- `LICENSE`: the upstream text (Apache-2.0) is kept, with the body unchanged; the copyright lines required for compliance are in another
  revision in this directory.
- The local draft of the upstream artwork (an icon png in the repository root) and the remote pointing at upstream have been removed.
- `src-tauri/src/modules/agent_sessions/opencode.rs`, `src/modules/launcher/lib/resumeCommand.test.ts`:
  test fixtures replaced with neutral paths and titles that no longer reference the upstream author's project directory.
- `scripts/dev/shot-window.ps1`: the comment no longer names another application installed on this machine.

**Feature reduction (built-in agent removed)**

- `src/modules/ai/**`, `src/modules/agents/**`, `src/components/ai-elements/**`: the whole modules are deleted, so upstream's
  built-in AI assistant UI, sub-agent runner and notifications no longer exist. Code block rendering in the terminal is kept.
- `src-tauri/src/modules/agent.rs`, `src-tauri/src/modules/ai_sessions.rs`,
  `src-tauri/src/modules/pty/agent_detect.rs`: upstream's Rust-side agent session storage and detection are deleted with them.
- `src/settings/sections/**`, `src/settings/components/**`: the settings related to the built-in agent and the launch-at-login item are removed.
- `src/modules/editor/**`, `src/modules/markdown/**`, `src/modules/launcher/**`,
  `src/modules/statusbar/**`: branches referencing the built-in agent are removed, the rest stays.
- The launch-at-login option is removed.

**Upstream metadata**

- `TERAX.md`: renamed to `VERTA.md` and rewritten as Verta's engineering notes (keeping the two upstream wasm identifier notes that cannot be changed).
- `.github/**` (CI, release, issue templates, dependabot, CODEOWNERS), `CLAUDE.md`, `AGENTS.md`:
  upstream's project governance files are removed in the baseline cleanup.
- `docs/**`: all upstream documentation removed (the directory is empty and not in version control).
- `CODE_OF_CONDUCT.md`: removed in the baseline cleanup.
- `CONTRIBUTING.md`, `ROADMAP.md`, `SECURITY.md`: upstream's contributing guide, roadmap and security notes are no longer distributed
  with the repository; the files stay on this machine as they are and are ignored by
  `.gitignore`; Verta's own engineering notes live in `VERTA.md`.
- `.coderabbit.yaml`: upstream's review configuration is not in version control (`.gitignore` already ignores it).
- `package.json`: the package name becomes `verta`, and upstream's release and documentation scripts are removed.
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`: product name, crate name and app identifier changed to Verta.
- `index.html`, `src/main.tsx`, `vite.config.ts`, `biome.json`: name and path references changed to Verta.
- `.gitignore`: upstream's local draft and documentation entries removed, replaced by ignoring `.superpowers/`.
- `.gitattributes`: line-ending rules adjusted to keep the working tree LF.

**License and change log**

- `LICENSE`: the Apache-2.0 body stays as upstream wrote it; two copyright lines are added at the top, for this project (Zomcxj) and for upstream Crynta.
- `README.md`: copyright notice and acknowledgements added, pointing at Terax AI and stating that the differences are recorded in `CHANGES.md`.
- `CHANGES.md`: new, recording every difference between this project and upstream, in reverse chronological order.
- `AGENTS.md`: the local working conventions, stating that this file is updated with every change (not in version control).
- `README.md`: rewritten in the layout of the upstream README (centered title, badges, sectioned feature table, tech stack, license), with the content
  replaced by Verta's own features; the "work log" section is dropped and workspace information is left to `AGENTS.md`.
- `docs/**`: upstream documentation and screenshots deleted from this machine (directory and contents), and the corresponding path rules removed
  from `.gitignore`.
- Cleanup of files left over from upstream: `.github/**` (CI, release workflow, issue templates, dependabot, CODEOWNERS),
  `.coderabbit.yaml`, `CONTRIBUTING.md`, `ROADMAP.md`, `SECURITY.md`, `flake.nix`, `flake.lock`,
  `nix/` and `scripts/dev/upstream-drift.sh` are deleted from this machine, and the corresponding dead rules are cleared from `.gitignore`.

**Wrap-up cleanup of the built-in AI feature (feature gone, scaffolding left)**

- `src/modules/editor/AiDiffPane.tsx`, `AiDiffStack.tsx`, `AiDiffStackLazy.tsx`: deleted with the built-in AI's diff view.
- `src/modules/tabs/lib/useTabs.ts`: the `AiDiffTab` and `AiDiffStatus` types, `openAiDiffTab`,
  `setAiDiffStatus` and `closeAiDiffTab` are deleted (exported, but with no callers).
- `src/modules/tabs/index.ts`, `src/modules/tabs/lib/tabLabel.ts`, `src/modules/tabs/TabBar.tsx`:
  the `ai-diff` re-export, title branch and tab icon are removed.
- `src/modules/editor/useEditorFileSync.ts`: the listener that reloaded the editor after an approved AI change is removed.
- `src/components/chat-code.tsx`: the unused `ChatStreamingProvider` export is removed (the file itself is still used for code block
  rendering in the terminal and Markdown).
- `src/app/feature-loading.test.tsx`: the loading test for the deleted component is removed.
- `src/lib/usePresence.ts`: deleted, a dead file with no references.
- `knip.json`: the ignore for the deleted `src/components/ai-elements/**` and the `swiftc` ignore are removed.

**Cleanup of upstream performance and visual tooling**

- `scripts/ipc-profile/`, `scripts/renderer-profile/`, `scripts/pty-smoke/`, `scripts/terminal-visual/`,
  `scripts/ghostty-profile.*`, `scripts/ghostty-soak.*`, `scripts/ghostty-webkit-memory*`: deleted, together with the
  `package.json` scripts pointing at them (`test:ipc:macos`, `profile:ghostty`, `soak:ghostty`,
  `profile:renderer:*`). `scripts/ipc-profile/smoke.ts` imported the deleted built-in AI modules.
- Kept: `scripts/dev/**` (this project's acceptance tooling), `scripts/build-cli.mjs`, `scripts/dist-graph.*` and
  `scripts/eager-graph.*` (imported directly by the bundle-size budget tests), `scripts/app-lab/**` (the driver for `src/bench`,
  which `src/main.tsx` and `src/app/App.tsx` reference).
- `src/modules/sidebar/useRightPanel.ts`: `shouldPersistRightWidth` is no longer exported (no callers).
- `src/app/dist-budget.test.ts`: the case that runs two full builds gets its own timeout.

**Dependency cleanup (empty dependencies left after the built-in AI and related features were removed)**
- `package.json`: `ai` and `@ai-sdk/*` (9 packages in total) are removed, along with `zod`, `@radix-ui/react-use-controllable-state`,
  `use-stick-to-bottom`, `@tauri-apps/plugin-autostart`, `@tauri-apps/plugin-notification` and the dev dependency
  `react-compiler-healthcheck`.
- `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`: the dependency, registration and permissions of
  `tauri-plugin-notification` are removed.
- `pnpm-lock.yaml` and `src-tauri/Cargo.lock` are updated accordingly, and the packages themselves are removed from `node_modules`.
</details>

<details>
<summary><strong>2026-10-17</strong></summary>

**Session panel (new feature)**

- `src-tauri/src/modules/agent_sessions/**`: new, reads real sessions of the local opencode (`session_v2`) and pi (jsonl inside the project), reading sessions inside a distro from within that distro; deleting a session goes through the respective CLI or a file operation.
- `src/modules/launcher/**`: new, the pure functions and UI for the session list, the resume command, sub-agent filtering, selection and deletion.
- `src/modules/i18n/**`: new, Chinese and English UI copy plus language switching.
- `src/app/App.tsx`, `src/modules/sidebar/**`: wired into the sidebar; the session panel is present as soon as the app opens.
- `src-tauri/src/lib.rs`, `src-tauri/src/modules/mod.rs`: register the new commands.

**Environment following**

- `src/modules/workspace/**`: the environment is now inferred from the path (`envForPath`), and opening a terminal prepares the environment before landing.
- `src-tauri/src/modules/workspace.rs`, `src-tauri/src/modules/pty/**`: start the matching shell per the environment the leaf carries.

**Foundational changes**

- `src-tauri/tauri.conf.json`: the app identifier changed to Verta's own.
- `.gitattributes`: keeps the working tree LF for the frontend lint gate on Windows.
- `scripts/dev/**`: new screenshot and probe scripts for acceptance (not part of packaging).
</details>
