import { describe, expect, it } from "vitest";
import { collectSessionClaims, sessionsRunningNow } from "./sessionServicePhase";

describe("collectSessionClaims", () => {
  it("groups the ptys of the tabs that resumed a session", () => {
    const claims = collectSessionClaims([
      { kind: "terminal", sessionId: "ses_a", ptys: [1] },
      { kind: "terminal", sessionId: "ses_b", ptys: [2] },
    ]);
    expect(claims).toEqual([
      { sessionId: "ses_a", ptys: [1] },
      { sessionId: "ses_b", ptys: [2] },
    ]);
  });

  it("unions a session split across two tabs instead of replacing the first", () => {
    // Split a resumed session into two panes and the second tab must not hide the first's leaf.
    const claims = collectSessionClaims([
      { kind: "terminal", sessionId: "ses_a", ptys: [1] },
      { kind: "terminal", sessionId: "ses_a", ptys: [2, 1] },
    ]);
    expect(claims).toEqual([{ sessionId: "ses_a", ptys: [1, 2] }]);
  });

  it("skips tabs that are not a resumed session", () => {
    const claims = collectSessionClaims([
      { kind: "terminal", ptys: [1] },
      { kind: "editor", sessionId: "ses_b", ptys: [2] },
      { kind: "terminal", sessionId: "ses_c", ptys: [3] },
    ]);
    expect(claims).toEqual([{ sessionId: "ses_c", ptys: [3] }]);
  });
});

describe("sessionsRunningNow", () => {
  const claims = [
    { sessionId: "ses_a", ptys: [1, 2] },
    { sessionId: "ses_b", ptys: [3] },
  ];

  it("names the ptys of a session the service says is mid-turn", () => {
    expect(sessionsRunningNow(claims, new Set(["ses_a"]))).toEqual([
      { ptyId: 1, sessionId: "ses_a" },
      { ptyId: 2, sessionId: "ses_a" },
    ]);
  });

  it("says nothing when the service could not be asked", () => {
    // No service running is the common case, and it must leave the screen in charge.
    expect(sessionsRunningNow(claims, null)).toEqual([]);
  });

  it("says nothing for a session the service does not name", () => {
    // Between turns the service writes nothing, and the screen is the fresher of the two there.
    expect(sessionsRunningNow(claims, new Set(["ses_b"]))).toEqual([
      { ptyId: 3, sessionId: "ses_b" },
    ]);
    expect(sessionsRunningNow(claims, new Set())).toEqual([]);
  });
});
