import { describe, expect, it } from "vitest";
import { applySignal, useAgentActivityStore } from "./agentActivity";
import type { AgentSignal } from "./agentActivity";
import {
  AGENT_GONE_MS,
  IDLE_SETTLE_MS,
  NO_JOB_SETTLE_MS,
  emptyJudgeEntry,
  judgeTail,
} from "./agentJudge";

/** Footer-based fixtures; the original captures are kept in `agentRules.test.ts`. */
const OPENCODE_WORKING =
  "Writing the patch\n⠹ Thinking\nesc interrupt · ctrl+p commands   · Tokens 12.4k";
const OPENCODE_IDLE = "Where to next?\nctrl+p commands   · Tokens 12.4k";
const OPENCODE_BLOCKED =
  "△ Permission required\n  Allow once\n  Allow always\n  Deny\nctrl+p commands";
const SHELL_PROMPT = "special@LAPTOP MINGW64 /f/VibeCoding/work (main)\n$ ";

/**
 * A turn over, one background shell left, and the footer wrapped so the count sits on the line
 * above the last one (2026-10-31, `idle-screen.log`; see `agentRules.test.ts` for the full screen).
 */
const OPENCODE_TRAILING = [
  "  ┃  Build auto · deepseek-v4.1-flash workbuddy · max",
  "  F:\\…\\Verta:ma…  命中率 99.8% ↑0.7% · Tokens 2232.6M · 余额 -   ↓ 1 shell · ◎ goal paused · 319.7K (64%)  ctrl+p commands",
  "                  ·",
].join("\n");

const kinds = (signals: readonly AgentSignal[]) =>
  signals.map((signal) => signal.kind);

/** The first state of a leaf, at a given instant. */
function first(tail: string, nowMs = 1_000) {
  const outcome = judgeTail(emptyJudgeEntry(7), tail, nowMs);
  if (outcome.kind !== "report") throw new Error(`expected a report, got ${outcome.kind}`);
  return outcome;
}

describe("judgeTail", () => {
  it("says nothing at all about a plain shell prompt", () => {
    const outcome = judgeTail(emptyJudgeEntry(7), SHELL_PROMPT, 1_000);
    expect(outcome.kind).toBe("quiet");
    if (outcome.kind === "quiet") expect(outcome.entry.tool).toBeNull();
  });

  it("announces the agent and its first state together", () => {
    const outcome = first(OPENCODE_WORKING);
    expect(kinds(outcome.signals)).toEqual(["started", "working"]);
    expect(outcome.signals[0]).toEqual({
      id: 7,
      kind: "started",
      agent: "opencode",
    });
    expect(outcome.entry).toMatchObject({ id: 7, tool: "opencode", state: "working" });
  });

  it("does not repeat an announcement or a state that has not changed", () => {
    const working = first(OPENCODE_WORKING);
    expect(judgeTail(working.entry, OPENCODE_WORKING, 2_000).kind).toBe("quiet");
  });

  it("reports a turn that ended into background work as trailing, not as an ending", () => {
    // The session is not at rest (something is still running) and this is not "a turn finished"
    // either: the latch that says an ending nobody has looked at is kept by the caller, and the
    // phase it draws is neither of the two states around it.
    const working = first(OPENCODE_WORKING);
    const trailing = judgeTail(working.entry, OPENCODE_TRAILING, 2_000);
    if (trailing.kind !== "report") {
      throw new Error(`expected a report, got ${trailing.kind}`);
    }
    expect(kinds(trailing.signals)).toEqual(["trailing"]);
    expect(trailing.entry.state).toBe("trailing");
  });

  it("reports the background work finishing as rest", () => {
    const working = first(OPENCODE_WORKING);
    const trailing = judgeTail(working.entry, OPENCODE_TRAILING, 2_000);
    if (trailing.kind !== "report") throw new Error("report");
    const idle = judgeTail(trailing.entry, OPENCODE_IDLE, 3_000);
    if (idle.kind !== "report") throw new Error(`report, got ${idle.kind}`);
    expect(kinds(idle.signals)).toEqual(["idle"]);
    expect(idle.entry.state).toBe("idle");
  });

  it("reports a question as attention", () => {
    const working = first(OPENCODE_WORKING);
    const blocked = judgeTail(working.entry, OPENCODE_BLOCKED, 2_000);
    expect(blocked.kind).toBe("report");
    if (blocked.kind !== "report") return;
    expect(kinds(blocked.signals)).toEqual(["attention"]);
    expect(blocked.entry.state).toBe("blocked");
  });

  it("does not call a question that stops a finished turn", () => {
    // A card leaves the screen because the user answered it, dismissed it, or the agent took the
    // screen back; a question is not a turn, so its going quiet is rest rather than an ending.
    // Measured on the installed build, an ending here put a second "a turn finished" notice into
    // Windows' store for one turn - one for the card leaving, one for the turn, eleven seconds
    // apart - while the same command on a terminal with no card put exactly one.
    const blocked = judgeTail(first(OPENCODE_WORKING).entry, OPENCODE_BLOCKED, 2_000);
    if (blocked.kind !== "report") throw new Error("report");
    const firstIdle = judgeTail(blocked.entry, OPENCODE_IDLE, 3_000);
    expect(firstIdle.kind).toBe("quiet");
    if (firstIdle.kind !== "quiet") return;
    const idle = judgeTail(firstIdle.entry, OPENCODE_IDLE, 3_000 + IDLE_SETTLE_MS);
    expect(idle.kind).toBe("report");
    if (idle.kind !== "report") return;
    expect(kinds(idle.signals)).toEqual(["idle"]);
  });

  it("marks a finished turn, which the store shows as done before idle", () => {
    const working = first(OPENCODE_WORKING);
    // The idle screen has to be believed before it is reported (see `IDLE_SETTLE_MS`), so the
    // first read of it says nothing and the ending arrives once the screen has gone on saying so.
    const firstIdle = judgeTail(working.entry, OPENCODE_IDLE, 2_000);
    expect(firstIdle.kind).toBe("quiet");
    if (firstIdle.kind !== "quiet") return;
    const idle = judgeTail(firstIdle.entry, OPENCODE_IDLE, 2_000 + IDLE_SETTLE_MS);
    expect(idle.kind).toBe("report");
    if (idle.kind !== "report") return;
    // Reported as `finished`, not as `idle`: the store turns that into a short "done" mark, which
    // is what the dots and the notification layer read.
    expect(kinds(idle.signals)).toEqual(["finished"]);
  });

  it("reports one ending when the interrupt hint disappears despite leftover Thinking text", () => {
    const working = first("esc interrupt · ctrl+p commands");
    const stopped = "Thinking about the completed work\n◐ goal met · ctrl+p commands";
    const pending = judgeTail(working.entry, stopped, 2_000);
    expect(pending.kind).toBe("quiet");
    const ended = judgeTail(pending.entry, stopped, 2_000 + IDLE_SETTLE_MS);
    expect(ended.kind).toBe("report");
    if (ended.kind !== "report") throw new Error("missing ending");
    expect(kinds(ended.signals)).toEqual(["finished"]);
    expect(ended.entry.state).toBe("idle");
    expect(judgeTail(ended.entry, stopped, 4_000).kind).toBe("quiet");
  });

  it("reports idle directly when the agent was never busy", () => {
    // The first screen after the agent appears is already its idle prompt, so the
    // change is "unknown to idle", not "a turn finished".
    expect(kinds(first(OPENCODE_IDLE).signals)).toEqual(["started", "idle"]);
  });

  it("stops claiming work when no rule can read the screen", () => {
    // Measured on this machine (2026-11-03): a session closed since the day before opened with an
    // orange dot. `started` says `working`, and the screen underneath - `~/Desktop    251.1K (50%)
    // ctrl+p commands` - identified opencode but matched no state rule, so the judge said nothing
    // and the dot kept the claim forever.
    const UNREADABLE = "Working on it\n  enter submit";
    const working = first(OPENCODE_WORKING);
    const held = judgeTail({ ...working.entry, state: "working" }, UNREADABLE, 2_000);
    expect(held.kind).toBe("quiet");
    if (held.kind !== "quiet") return;
    expect(held.entry.state).toBe("working");
    const settled = judgeTail(held.entry, UNREADABLE, 2_000 + IDLE_SETTLE_MS);
    expect(settled.kind).toBe("report");
    if (settled.kind !== "report") return;
    // `idle`, not `finished`: an unreadable screen cannot say a turn ended, so no "a turn
    // finished" notice is invented for it.
    expect(kinds(settled.signals)).toEqual(["idle"]);
    expect(settled.entry.state).toBe("idle");
  });

  it("starts fresh when the leaf has been reused for another pty", () => {
    // Same leaf, new pty: the entry is keyed by pty, so the caller hands in a fresh
    // one and the agent is announced again.
    expect(kinds(first(OPENCODE_WORKING).signals)).toEqual(["started", "working"]);
  });
});

describe("an agent that leaves the screen", () => {
  const working = { ...first(OPENCODE_WORKING).entry };

  it("does not call the agent gone on the first screen without it", () => {
    const outcome = judgeTail(working, SHELL_PROMPT, 5_000);
    expect(outcome.kind).toBe("quiet");
    if (outcome.kind === "quiet") {
      expect(outcome.entry.tool).toBe("opencode");
      expect(outcome.entry.state).toBe("working");
      expect(outcome.entry.lostSince).toBe(5_000);
    }
  });

  it("keeps the last state through a redraw inside the grace period", () => {
    const firstMiss = judgeTail(working, SHELL_PROMPT, 5_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const secondMiss = judgeTail(firstMiss.entry, "", 5_000 + AGENT_GONE_MS - 1);
    expect(secondMiss.kind).toBe("quiet");
    if (secondMiss.kind === "quiet") {
      // The clock is not restarted by every miss: one grace period, not one per tick.
      expect(secondMiss.entry.lostSince).toBe(5_000);
    }
  });

  it("reports finished once the grace period has passed", () => {
    const firstMiss = judgeTail(working, SHELL_PROMPT, 5_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const gone = judgeTail(firstMiss.entry, SHELL_PROMPT, 5_000 + AGENT_GONE_MS);
    expect(gone.kind).toBe("report");
    if (gone.kind !== "report") return;
    // `exited` after `finished`: the turn ended, and then there is no agent on this session at all,
    // which is what clears the store's name for it. Without that the tab went on drawing a green dot
    // over a bare shell prompt for the rest of the window's life.
    expect(kinds(gone.signals)).toEqual(["finished", "exited"]);
    expect(gone.entry).toEqual({
      id: 7,
      tool: null,
      state: "idle",
      lostSince: null,
      idleSince: null,
      noJobSince: null,
    });
  });

  it("reports rest, not finished, when what left was a question", () => {
    // Same reasoning as the settled case: the app is being told a card is no longer on the screen,
    // not that a turn ended. Reported as `idle` so nothing is latched and nothing is announced.
    const blocked = judgeTail(working, OPENCODE_BLOCKED, 5_000);
    if (blocked.kind !== "report") throw new Error("report");
    const firstMiss = judgeTail(blocked.entry, SHELL_PROMPT, 6_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const gone = judgeTail(firstMiss.entry, SHELL_PROMPT, 6_000 + AGENT_GONE_MS);
    expect(gone.kind).toBe("report");
    if (gone.kind !== "report") return;
    // Rest first (a question is not a turn), then `exited` for the same reason as above: the
    // session has no agent on it any more, so nothing may keep describing one.
    expect(kinds(gone.signals)).toEqual(["idle", "exited"]);
    expect(gone.entry.tool).toBeNull();
  });

  it("clears the grace period as soon as the agent is back", () => {
    const firstMiss = judgeTail(working, SHELL_PROMPT, 5_000);
    if (firstMiss.kind !== "quiet") throw new Error("quiet");
    const back = judgeTail(firstMiss.entry, OPENCODE_BLOCKED, 5_500);
    expect(back.kind).toBe("report");
    if (back.kind !== "report") return;
    expect(back.entry.lostSince).toBeNull();
    expect(kinds(back.signals)).toEqual(["attention"]);
    // An agent already reported as settled still has to be cleared when its screen goes: the
    // sentence this replaces said the opposite, and it is the reason a tab whose pane is a bare
    // `$` prompt kept a green dot. Measured on this machine: `phases[65] = idle` and
    // `agents[65] = opencode` on a pane whose whole screen was a prompt.
    const gone = judgeTail(
      { id: 7, tool: "opencode", state: "idle", lostSince: 6_000, idleSince: null , noJobSince: null},
      SHELL_PROMPT,
      6_000 + AGENT_GONE_MS,
    );
    expect(gone.kind).toBe("report");
    if (gone.kind !== "report") return;
    expect(kinds(gone.signals)).toEqual(["exited"]);
    expect(gone.entry.tool).toBeNull();
  });

  it("leaves no agent name behind when a settled agent's screen becomes a bare prompt", () => {
    // The reported case, end to end: a pane that showed opencode at rest, then became an empty shell
    // prompt, kept `agents[pty] = "opencode"` for the rest of the window's life - and the tab's
    // green asks only whether that name is there, not what the phase is. Replayed here with the
    // real judge: the name is set by `started`, and only an `exited` takes it away.
    const store = useAgentActivityStore.getState();
    store.clear(7);
    let entry = emptyJudgeEntry(7);
    let now = 1_000;
    for (const tail of [OPENCODE_IDLE, SHELL_PROMPT, SHELL_PROMPT, SHELL_PROMPT, SHELL_PROMPT]) {
      const outcome = judgeTail(entry, tail, now);
      entry = outcome.entry;
      if (outcome.kind === "report") {
        for (const signal of outcome.signals) applySignal(signal);
      }
      now += AGENT_GONE_MS / 2;
    }
    const after = useAgentActivityStore.getState();
    // Nothing on this session describes an agent any more, which is what the tab and the row read.
    expect(after.agents[7]).toBeUndefined();
    expect(after.phases[7]).toBeUndefined();
  });

  it("never asks about a screen that was never an agent", () => {
    // A foreign full-screen program is not an agent leaving; it is nothing at all.
    const outcome = judgeTail(emptyJudgeEntry(7), "man verta\n", 1_000);
    expect(outcome.kind).toBe("quiet");
  });
});

describe("the settle before an ending", () => {
  // The screens the false endings came from, as `agentRules.test.ts` keeps them: the same turn,
  // read once without the working line and once with it.
  const WORKING = OPENCODE_WORKING;
  const IDLE = "Where to next?\nctrl+p commands   · Tokens 12.4k";

  it("does not report an ending from a single read that missed the working line", () => {
    let entry = first(WORKING, 0).entry;
    const blip = judgeTail(entry, IDLE, 500);
    expect(blip.kind).toBe("quiet");
    if (blip.kind !== "quiet") return;
    expect(blip.entry.state).toBe("working");
    entry = blip.entry;
    // The screen says working again on the next read: the ending never happened, and neither the
    // dot nor the notification for one is produced.
    const back = judgeTail(entry, WORKING, 1_000);
    expect(back.kind).toBe("quiet");
  });

  it("reports the ending once the screen has gone on saying idle", () => {
    let entry = first(WORKING, 0).entry;
    for (const nowMs of [500, 1_000, 1_500]) {
      const outcome = judgeTail(entry, IDLE, nowMs);
      expect(outcome.kind).toBe("quiet");
      if (outcome.kind === "quiet") entry = outcome.entry;
    }
    const settled = judgeTail(entry, IDLE, 2_100);
    expect(settled.kind).toBe("report");
    if (settled.kind === "report") expect(kinds(settled.signals)).toEqual(["finished"]);
  });

  it("reports a question at once, settled or not", () => {
    // A card on screen is not a frame that could have been missed.
    const entry = first(WORKING, 0).entry;
    const asked = judgeTail(entry, OPENCODE_BLOCKED, 600);
    expect(asked.kind).toBe("report");
    if (asked.kind === "report") expect(kinds(asked.signals)).toEqual(["attention"]);
  });
});

describe("a screen still painted on a pty with nothing running in it", () => {
  /** The caller's answer when the pty has no command on it and this machine can see that. */
  const NOTHING = { nothingRunning: true };
  /** The same caller, with a command on the tty. */
  const RUNNING = { nothingRunning: false };
  /** The same caller when the machine cannot see foreground commands at all. */
  const BLIND = { nothingRunning: false };

  /** An entry that has settled on a question, the state the reported tab was stuck in. */
  const asked = () => {
    const outcome = first(OPENCODE_BLOCKED);
    if (outcome.entry.state !== "blocked") throw new Error("expected a question");
    return outcome.entry;
  };

  it("reads the last frame of a stopped agent as rest, not as a question", () => {
    // The reported case: quitting an agent leaves its question where it was and the shell's prompt
    // is drawn under it, so the rules keep reading a question nothing is asking. The clear is a
    // signal, and no signal was ever going to come - the tab stayed blue for the window's life.
    const entry = asked();
    const firstRead = judgeTail(entry, OPENCODE_BLOCKED, 10_000, NOTHING);
    expect(firstRead.kind).toBe("quiet");
    if (firstRead.kind !== "quiet") return;
    expect(firstRead.entry.noJobSince).toBe(10_000);

    const settled = judgeTail(
      firstRead.entry,
      OPENCODE_BLOCKED,
      10_000 + NO_JOB_SETTLE_MS,
      NOTHING,
    );
    expect(settled.kind).toBe("report");
    if (settled.kind !== "report") return;
    expect(kinds(settled.signals)).toEqual(["idle"]);
    expect(settled.entry).toMatchObject({ state: "idle", noJobSince: null });
  });

  it("cannot have the claim put back by the same frame once it has been dropped", () => {
    // The screen is still the last frame, so the very next read sees the same question. If that
    // read were believed the dot would go blue again three seconds after every clear, for as long
    // as the tab lived - a flicker instead of a stuck dot, which is not a fix.
    const settled = judgeTail(
      { ...asked(), state: "idle", noJobSince: null },
      OPENCODE_BLOCKED,
      20_000,
      NOTHING,
    );
    expect(settled.kind).toBe("quiet");
    expect(judgeTail(asked(), OPENCODE_BLOCKED, 20_000).kind).toBe("quiet");
  });

  it("does not announce an agent on a frame nothing is behind", () => {
    // `started` is what the tab's icon and the store's name come from, and the store reads it as a
    // session with work in flight: announced over a dead frame, that is a tab drawn for an agent
    // that is not there, and it is orange.
    const dead = judgeTail(emptyJudgeEntry(7), OPENCODE_BLOCKED, 21_000, NOTHING);
    expect(dead.kind).toBe("quiet");
    if (dead.kind !== "quiet") return;
    expect(dead.entry.tool).toBeNull();
  });

  it("says nothing while a command is still on the tty", () => {
    // A question that is really being asked is asked by a process. With one there, the screen is
    // judged exactly as before, and a question that has not moved is quiet.
    expect(judgeTail(asked(), OPENCODE_BLOCKED, 30_000, RUNNING).kind).toBe("quiet");
  });

  it("takes a blind machine's word for nothing, because its answer is always the same", () => {
    // `wsl.exe` is the case: its commands are Linux processes and Windows' process list has none of
    // them, so "nothing running" is what it reports while a distribution is busy.
    const entry = { ...asked(), noJobSince: null };
    const read = judgeTail(entry, OPENCODE_BLOCKED, 31_000, BLIND);
    expect(read.kind).toBe("quiet");
    expect(read.entry.state).toBe("blocked");
  });

  it("forgets the wait as soon as a read has a command behind it", () => {
    // The fact arrives on a slower cadence than the screen: a command that starts between two asks
    // is seen by the next read, and that read is what says the pty is not dead after all.
    const firstRead = judgeTail(asked(), OPENCODE_BLOCKED, 40_000, NOTHING);
    if (firstRead.kind !== "quiet") throw new Error("quiet");
    expect(firstRead.entry.noJobSince).toBe(40_000);
    const read = judgeTail(firstRead.entry, OPENCODE_BLOCKED, 41_000, RUNNING);
    expect(read.entry.noJobSince).toBeNull();
    // A caller with no answer yet leaves the wait standing rather than restarting it: otherwise a
    // probe that stops asking, or a slow first ask, would keep the clock at zero for ever.
    const kept = judgeTail(firstRead.entry, OPENCODE_BLOCKED, 41_000);
    expect(kept.entry.noJobSince).toBe(40_000);
  });
});
