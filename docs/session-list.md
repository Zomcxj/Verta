# Session list

The session list is the product's front door: it shows the coding-agent sessions that already exist
on this machine and opens one in its own project directory.

It reads, it never writes. A session is opened by running the agent's own resume command in a
terminal, not by importing or copying anything.

## Where the rows come from

`agent_sessions_list` reads every source: this machine plus each WSL distro while the WSL switch is
on. A distro is queried by its own `python3`, with the script handed over through `/mnt`, because a
WAL database cannot be read correctly across the 9p mount.

A row is `(tool, id, title, cwd, updatedAtMs, parentId, distro, stats)`. The tool is part of every
identity: an id is unique within a tool, and nothing stops two tools from using the same string.

## Opening a session

`planSessionOpen` derives the environment and the resume command **together**. That pairing is the
point: a local session must not open in a distro shell, and the way that once happened was letting
the downstream guess the environment instead of passing it.

The command is typed into a terminal on the reader's behalf, so the instant it lands is covered by a
transition (`SessionOpeningOverlay`, drawn inside the terminal area rather than over the whole
window). The cover lifts only onto the agent's own screen: every rule in `src/app/coverRule.ts`
requires that the launch line is not on screen, and the three that can fire before the agent owns the
alternate screen also require that the screen has something on it at all - silence over a cleared
buffer once lifted the cover onto a blank pane. The clock is the last resort and sits well past those
rules (60 s), for an agent that never draws anything.

The layer belongs to its tab, not to the tab on screen. Switching tabs hides it - it must not hang
over someone else's terminal - but does not end it: the session is still starting, and coming back has
to show the same transition rather than the launch command it exists to hide. `sessionOpeningAlive`
answers "is there still a pane to cover", and only closing the tab ends it.

**Several starts can be pending at once, and each one keeps its own entry.** Sessions are opened one
after another, and every start covers its own pane until its own UI is painted. A single entry meant
the newest start replaced the older ones, so their panes were uncovered while their sessions were
still starting - and their screens already held the resume command (reported as "clicking several
sessions in a row: only the last one still had its transition after a tab switch, the rest showed the
terminal command"). The list is therefore a list of starts, each carrying its
own leaf, tool and token; the layer is drawn for whichever one belongs to the tab on screen
(`sessionOpeningOnScreen`), and the covered panes are named by leaf, not by "the tab I am looking at"
(`coveredLeaves`), which is what keeps them hidden while the reader is away.

## Subagents

An agent's subagent sessions are filed under their parent's id. They are hidden from the list by
default, because they are not what a person is looking for; the manage view draws them, which is the
view whose question is "what will I lose if I delete this".

Two facts about a parent are read from the rows themselves rather than stored:

- `subagentsOf(sessions, parent)` answers what one session started.
- `subagentsByParent(sessions)` groups every session's children in one pass, keyed by tool and parent
  id, and feeds both the manage view's `↳N` badge and the hover card.

Neither can drift from the rows on screen, because they are the rows.

## Reading one session

A row says a title and, at the standard density, three numbers. What a session *is* is one hover
away, in **either** density and in **either** mode, including the manage view and whether or not the
row is ticked: hovering is how a session is read, and ticking it first must not be the price of
asking.

- **The card** (`SessionHoverCard`, one element for the whole list, moved with a plain 2D transform so
  switching rows is a move rather than a flicker) says the id, the directory and the usage, plus the
  parent on a subagent's row.
- **The dialog** (`SessionInfoDialog`, from the row's menu or the manage view's toolbar) is the whole
  record: the agent, the source, and every subagent the session started.

Both draw the same block (`SessionFacts`), so the two cannot disagree about a number. What differs is
how much fits: the card takes no pointer events - a card that could be hovered would keep itself open
- so it cannot scroll, and it does not start a list it cannot finish.

The row carries no native `title` in either density: the card says the same words in full, and two
popups on one hover is worse than one.

## Deleting

Multi-select, then one confirmation that says how many rows go and how many subagent sessions go with
them. Delete resolves the session directory from the store, calls the tool's own CLI, then re-reads to
confirm. A failure is reported with the tool's own words, never disguised as success.

## The watcher

`agent_sessions/watch.rs` watches both session stores and coalesces a burst of changes into one
`verta://agent-sessions-changed` event, which is what makes a session started in a terminal appear
without pressing Refresh. The list pauses its own refreshes while a selection flow is open - a row
that moves under the cursor is how the wrong session gets ticked - and catches up when the flow ends.

## Verifying the opening transition

- `scripts/dev/probes/session-opening-latency.mjs` opens a session and compares two clocks: the
  layer's presence sampled from the DOM, and the app's own record (`sessionOpenings` in
  `terminalDebugStats`). Two independent clocks have to agree, or the numbers mean nothing.
- `scripts/dev/probes/session-opening-tab-switch.mjs` is the one for the tab-switch report: it opens
  a session, switches to another tab while the cover is up, and switches back. It asserts that the
  layer does not follow the reader to another tab, that the starting pane's own `opacity` stays 0 the
  whole time (away and back), and that the layer is up again on return. A pane that is merely
  `visibility: hidden` would pass a screenshot and still flash the resume command on the way back, so
  the probe reads the computed opacity.

## Verifying a change here

- `scripts/dev/probes/session-list-density.mjs` asserts one card on hover in both densities, holding
  the row's id, its directory and three usage parts, with the parent line present for a subagent row
  and absent for a top-level one. It fails on a card that has started drawing the record's fields or a
  child list again. `--manage` reads the same card from the manage view, and `--click-row` proves the
  row still opens a session with a card riding on its pointer events.
- `scripts/dev/probes/session-hover-card-roam.mjs` proves the card is one DOM element that moves: same
  node across two rows, transform changed, content replaced, `aria-describedby` following.
- `src/modules/launcher/lib/sessionInfo.test.ts` holds the grouping; the wiring tests hold which rows
  draw the card and which facts each surface asks for.
