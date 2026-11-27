import { describe, expect, it } from "vitest";
import { rememberTerminalSession } from "./sessionForDiff";

describe("rememberTerminalSession", () => {
  it("switches to the active terminal tab's session", () => {
    // This is the fix for "pi's diff went to cc": the tab the reader is looking at wins
    // over whichever session was opened last.
    expect(rememberTerminalSession({ kind: "terminal", sessionId: "pi" }, "cc")).toBe(
      "pi",
    );
  });

  it("keeps the last terminal session when a diff tab is active", () => {
    // A diff has no session of its own, so opening one while pi is working must keep
    // pointing at pi.
    expect(rememberTerminalSession({ kind: "git-diff" }, "pi")).toBe("pi");
  });

  it("keeps the last session on a terminal that carries no session id", () => {
    // A plain shell tab opened by hand has no session; it must not clear the target.
    expect(rememberTerminalSession({ kind: "terminal" }, "pi")).toBe("pi");
  });

  it("is null before any terminal has been seen", () => {
    expect(rememberTerminalSession(undefined, null)).toBeNull();
  });
});
