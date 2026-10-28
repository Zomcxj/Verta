import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latchedKeys, trayDotFor } from "@/app/hooks/useTrayStateDot";

const DONE = { 1: 1_000 };
const ASKED = { 1: 1_000 };

describe("trayDotFor", () => {
  it("says nothing for a session that was opened and left at its prompt", () => {
    // Reported from the running app, twice: an agent that had just been opened put a green dot on
    // the icon and kept it there, and an agent whose turn was in flight put one up as well.
    expect(trayDotFor({ unseen: {}, unseenDone: {} })).toBeNull();
  });

  it("carries an ending that happened while nobody was looking", () => {
    expect(trayDotFor({ unseen: {}, unseenDone: DONE })).toBe("finished");
  });

  it("answers a question before an ending", () => {
    // Only one of the two is waiting for an answer.
    expect(trayDotFor({ unseen: ASKED, unseenDone: DONE })).toBe("asking");
    expect(trayDotFor({ unseen: ASKED, unseenDone: {} })).toBe("asking");
  });

  it("says nothing again for what was already waiting when the window was last looked at", () => {
    // Coming back to the window clears the icon; going away again with that same session still
    // unvisited must not light it up for the same news a second time.
    expect(trayDotFor({ unseen: {}, unseenDone: DONE }, new Set([1]))).toBeNull();
    expect(trayDotFor({ unseen: ASKED, unseenDone: DONE }, new Set([1]))).toBeNull();
    // A second session doing either thing is news, though.
    expect(
      trayDotFor({ unseen: {}, unseenDone: { 1: 1_000, 2: 2_000 } }, new Set([1])),
    ).toBe("finished");
    expect(
      trayDotFor({ unseen: { 2: 2_000 }, unseenDone: {} }, new Set([1])),
    ).toBe("asking");
  });

  it("says nothing later for a latch that arrived while the window was open", () => {
    // While the window is seen, every store write folds whatever is waiting into the snapshot the
    // effect keeps, so a turn that ended on another tab with the user right there is not news when
    // they later close the window.
    const open = { unseen: {}, unseenDone: { 7: 1_000 } };
    expect(trayDotFor(open, latchedKeys(open))).toBeNull();
    // One that arrives after that snapshot is news, which is the case the icon exists for.
    expect(
      trayDotFor({ unseen: {}, unseenDone: { 7: 1_000, 9: 9_000 } }, latchedKeys(open)),
    ).toBe("finished");
  });
});

describe("what counts as the user being away", () => {
  // Read as text, the way the motion budget test reads the stylesheet: this repository has no
  // component rendering, and the thing that changed here is which question the answer comes from.
  const hook = readFileSync(
    new URL("./useTrayStateDot.ts", import.meta.url),
    "utf8",
  );
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");

  it("asks whether the window can be seen, not whether it has focus", () => {
    // Reading the two as one question made a turn that ended while the user was typing in another
    // window - with this window in front of them - light the icon. The icon is news about what they
    // could not see, so it asks about that.
    expect(hook).toContain("useWindowHidden()");
    expect(hook).not.toContain("useWindowInactive()");
    expect(hook).toMatch(/if \(windowHidden\)/);
  });

  it("keeps the window's own tab in front until the window cannot be seen", () => {
    // The same answer reached the other way: the set of leaves being looked at is what the latches
    // are decided from, so it is emptied when nobody can see the window, and no longer when the
    // window merely loses focus.
    expect(app).toMatch(
      /setForegroundLeaves\(\s*tab\?\.kind === "terminal" && !windowHidden/,
    );
    expect(app).not.toMatch(
      /setForegroundLeaves\(\s*tab\?\.kind === "terminal" && !windowInactive/,
    );
  });
});