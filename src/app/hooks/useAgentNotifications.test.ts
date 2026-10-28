import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Read as text, the way the motion budget test reads the stylesheet. This repository renders no
// components, and what has to hold here is which question the hook asks before it interrupts the
// user with a system notification. The machine run is what proves the behaviour; this is what stops
// a later edit from quietly dropping the question.
const hook = readFileSync(
  new URL("./useAgentNotifications.ts", import.meta.url),
  "utf8",
);

describe("when a notification is worth interrupting the user for", () => {
  it("asks whether the window can be seen at all before it says anything", () => {
    // Reported from the running app: with the window in front of the user and another window taking
    // their typing, a turn that ended on another tab raised a toast. That tab's own dot is what the
    // window has to say about it, and a toast on top of the window the user is looking at is the
    // interruption they asked to stop.
    expect(hook).toContain("getWindowHidden()");
    expect(hook).toMatch(/if \(windowSeen\)/);
  });

  it("records a wait it deliberately did not announce", () => {
    // Otherwise closing the window later announces it: the wait is still latched, and the hook reads
    // "already announced" from what it remembers, so it has to remember this case too.
    //
    // Pinned inside the branch rather than by the line existing: this hook also sets that map when
    // it really does announce a wait, so matching the line anywhere would prove nothing.
    const branch = hook.indexOf("if (windowSeen)");
    expect(branch).toBeGreaterThan(-1);
    const rest = hook.slice(branch);
    const upToTheNextCheck = rest.slice(0, rest.indexOf("if (!announce"));
    expect(upToTheNextCheck).toContain("announced.set(ptyId, sinceMs)");
  });
});