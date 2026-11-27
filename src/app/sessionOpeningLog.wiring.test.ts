import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The cover's own record has to be fed on every path, or the measurement answers nothing.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components, and
 * what has to hold is that each way the cover can come down names itself and carries what the wait
 * saw. A path that quietly lifts without recording is a pause nobody can explain later.
 */
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const coverRule = readFileSync(
  new URL("./coverRule.ts", import.meta.url),
  "utf8",
);
const entry = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
const diagnostics = readFileSync(
  new URL("../modules/terminal/lib/terminalDiagnostics.ts", import.meta.url),
  "utf8",
);

describe("the record of a session opening", () => {
  it("starts when the cover goes up", () => {
    expect(app).toMatch(/noteSessionOpeningShown\(token, leafId, tool\)/);
  });

  it("names what ended it, including the two paths that are not the agent", () => {
    // The fallback timer and leaving the tab both look like "the transition stayed too long" and
    // neither has anything to do with the agent, so they must not read as one.
    expect(app).toMatch(
      /noteSessionOpeningLifted\(token, "fallback-timer", null, null\)/,
    );
    // A start whose tab is gone is lifted through its own token, because several can be pending.
    expect(app).toMatch(/hideSessionOpening\(start\.token, "tab-closed"\)/);
    expect(
      app.match(/hideSessionOpening\(opening, "write-failed"\)/g) ?? [],
    ).toHaveLength(5);
  });

  it("lets the rules decide, and the clock only as the last resort", () => {
    // The rule for this is the reader's (2026-11-22): the cover lifts onto the agent's own screen,
    // never onto the command it exists to hide. Every rule in `coverRule.ts` refuses while the
    // launch line is on screen, so the one path that can disagree is the hard cap, which lifts
    // whether or not the line is there. It therefore has to sit well past the rules' own budget: at
    // 30 s it was doing the lifting while a slow agent still held its command on the normal screen,
    // exposing exactly what the cover is for.
    const number = (pattern: RegExp, text: string): number => {
      const found = pattern.exec(text)?.[1];
      expect(found, `nothing matched ${pattern}`).toBeTruthy();
      return Number(found?.replace(/_/g, ""));
    };
    const cap = number(/const AGENT_UI_HARD_CAP_MS = ([\d_]+);/, app);
    const budget = number(
      /export const AGENT_UI_TIMEOUT_MS = ([\d_]+);/,
      coverRule,
    );
    expect(cap).toBeGreaterThanOrEqual(budget * 4);
    // The fallback timer is the net under the wait itself, so it has to fire after it has given up.
    expect(app).toMatch(
      /const SESSION_OPENING_FALLBACK_MS = AGENT_UI_HARD_CAP_MS \+ 500;/,
    );
  });

  it("keeps the layer when the reader only looks at another tab", () => {
    // Reported as "加载动画一切标签就没了". Rendering is already gated by `sessionOpeningVisible`
    // (the workspace draws the layer for its own tab only), so that lookup must not also end the
    // layer: the session keeps starting while the reader is elsewhere, and coming back has to show
    // the transition rather than the launch command it exists to hide. Only the leaf disappearing
    // ends it.
    expect(app).toMatch(/sessionOpeningAlive\(tabs, start\.leafId\)/);
    expect(app).not.toMatch(/sessionOpening === null \|\| sessionOpeningShown/);
  });

  it("gives every start its own fallback timer, so one cannot cancel another's", () => {
    // Measured on a restore, which starts two sessions in the same pass: one timer for the window
    // meant the newer start cancelled the older one's last resort, and that cover then had nothing
    // left that could take it down - it stayed up over a terminal that was already running,
    // reported as "还是卡在加载动画".
    expect(app).toMatch(/sessionOpeningTimers\.current\.set\(/);
    expect(app).toMatch(/clearSessionOpeningTimer\(leafId\)/);
    expect(app).not.toMatch(/sessionOpeningTimer\.current\s*=/);
  });

  it("carries the wait's report and the screen it lifted on", () => {
    // `coveredMs` alone cannot say whether an opening was slow because the agent was slow or
    // because a rule kept firing and the frame kept disagreeing; the report and the tail are what
    // separate those.
    expect(app).toMatch(
      /async function waitForAgentUi\([\s\S]*?\): Promise<SessionOpeningWait>/,
    );
    expect(app).toMatch(/return \{ rule, ticks, heldTicks, bytes \}/);
    expect(app).toMatch(/return \{\s*rule: "gave-up",\s*ticks,\s*heldTicks,/);
    expect(app).toMatch(/heldTicks \+= 1/);
    expect(
      app.match(/hideSessionOpening\(opening, "ui-painted", wait\)/g) ?? [],
    ).toHaveLength(5);
    expect(app).toMatch(/leafScreenTail\(leafId\)/);
  });

  it("is readable on the build the report came from, not only on a dev one", () => {
    // The user reports a pause in the installed app; a DEV-only global would measure the one build
    // where it does not happen. The terminal's diagnostics are installed in release too (behind the
    // `verta:terminal-diagnostics` flag), and the entry point hands the cover's record to them,
    // which is also what keeps a terminal module from importing the application.
    expect(diagnostics).toMatch(/installTerminalDiagnostics\(/);
    expect(diagnostics).not.toMatch(/@\/app\//);
    expect(entry).toMatch(
      /sessionOpenings: openings\.sessionOpeningRecords\(\)/,
    );
    expect(app).not.toMatch(/__vertaOpenings/);
  });
});
