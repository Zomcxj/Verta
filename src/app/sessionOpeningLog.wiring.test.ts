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
    // The 45 s fallback timer and leaving the tab both look like "the transition stayed too long"
    // and neither has anything to do with the agent, so they must not read as one.
    expect(app).toMatch(
      /noteSessionOpeningLifted\(token, "fallback-timer", null, null\)/,
    );
    expect(app).toMatch(
      /hideSessionOpening\(sessionOpeningToken\.current, "tab-left"\)/,
    );
    expect(
      app.match(/hideSessionOpening\(opening, "write-failed"\)/g) ?? [],
    ).toHaveLength(4);
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
    ).toHaveLength(4);
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
