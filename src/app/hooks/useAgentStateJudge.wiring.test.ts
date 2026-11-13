import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The one fact the screen cannot carry: does the shell have a command in flight.
 *
 * Reported from the running app: a session that had stopped kept its tab blue. Quitting an agent
 * leaves its question where it was and the shell's prompt is drawn under it, so every screen read
 * still finds "a question is waiting" - and the only thing that ever retracts that is a signal, so
 * nothing was coming. The judge now takes the shell's own answer beside the screen (`ScreenFacts`),
 * and what has to hold here is where that answer comes from and that a missing answer is not read
 * as one.
 *
 * The answer is the shell's OSC 133 markers rather than the system's process table, and that is not
 * a preference: measured on this machine (2026-11-13), a command started in a Git bash shell is
 * recorded against a fork helper that exits at once, so the parent table says the shell has no
 * children while `sleep 60` runs. Building this on that answer demoted a session that was busy -
 * caught by `scripts/dev/probes/stopped-session-dot.mjs`, which is the machine run this file
 * guards. Read as text, the way the other hook tests here do: this repository renders no components.
 */
const hook = readFileSync(
  new URL("./useAgentStateJudge.ts", import.meta.url),
  "utf8",
);
const session = readFileSync(
  new URL(
    "../../modules/terminal/ghostty/useGhosttyTerminalSession.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("the fact the state judge is given about a shell", () => {
  it("comes from the shell's own prompt markers", () => {
    // The parser turns OSC 133 into these events and the session's router reports them; the judge
    // reads it per leaf, in this process.
    expect(session).toMatch(/onCommandState: \(running\) => \{/);
    expect(session).toMatch(/noteLeafCommandState\(session\.leafId, running\)/);
    expect(session).toMatch(/forgetLeafCommandState\(session\.leafId\)/);
    expect(hook).toMatch(/const commandRunning = leafCommandRunning\(leafId\)/);
  });

  it("is handed to the screen read, and a shell that never spoke hands nothing", () => {
    // `null` is a shell that has never said anything - no integration, a distribution's shell
    // reached through `wsl.exe`. Treated as rest, it would demote every busy session on such a
    // shell; treated as no opinion, the screen is judged as it always was.
    expect(hook).toMatch(/const facts: ScreenFacts \| undefined =/);
    expect(hook).toMatch(/commandRunning === null/);
    expect(hook).toMatch(/\{ nothingRunning: !commandRunning \}/);
    expect(hook).toMatch(/judgeTail\(entry, tail, now, facts\)/);
  });

  it("does not ask the system, whose answer is wrong on this platform", () => {
    // Both of these were tried and both were measured wrong: `pty_foreground_facts` was written for
    // this fix and deleted again, and `pty_has_foreground_process` answers "no command" over a
    // running `sleep 60`.
    expect(hook).not.toContain("pty_foreground_facts");
    expect(hook).not.toContain("leafHasForegroundProcess");
  });
});
