import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * What the sessions panel shows while it is reading.
 *
 * The sidebar swaps whole panels with a `key`, so leaving the sessions list for the file tree and
 * coming back remounts it with nothing in hand and starts a read from scratch. The panel then said
 * "no sessions" for as long as that read took - measured by the person it was written for: switching
 * back from the file tree showed an empty list for a moment before the sessions appeared. Two things
 * have to hold: the last list is kept across the remount, and an empty list that was never read is
 * not reported as an empty list.
 */
const panel = readFileSync(
  new URL("../components/LauncherPanel.tsx", import.meta.url),
  "utf8",
);
const empty = readFileSync(
  new URL("../components/SessionList.tsx", import.meta.url),
  "utf8",
);

describe("the sessions panel while it reads", () => {
  it("starts from the list it had last time instead of from nothing", () => {
    // Module scope outlives the remount, which is the only thing that does.
    expect(panel).toMatch(/let cached[\s\S]{0,200}/);
    expect(panel).toContain("useState<AgentSession[]>(() => cachedSessions");
  });

  it("distinguishes a list that was never read from a list that is empty", () => {
    // The bug in one sentence: `sessions.length === 0` drew "no sessions" before any read finished.
    expect(panel).toContain("hasRead");
    expect(panel).toContain("reading={!hasRead || pendingSources.size > 0}");
    // The panel that draws the emptiness asks first, and only says "no sessions" once a read is in.
    expect(empty).toContain('t("launcher.loading")');
    expect(empty).toContain('t("launcher.empty")');
    expect(empty).toContain('data-session-empty={reading ? "reading" : "empty"}');
  });

  it("keeps saying it is reading while a source is still outstanding", () => {
    // A distro is read by running a query inside it, so its rows arrive seconds after this
    // machine's. Drawing the list as complete in between showed it missing its WSL block with
    // nothing to say why - which reads as "the switch did nothing". A finished read therefore clears
    // the pending sets per source, and the list stays in "reading" until the last one settles.
    expect(panel).toContain("setPendingSources(pendingFor(requests))");
    expect(panel).toContain("next.delete(key)");
  });
});
