import { describe, expect, it } from "vitest";
import { noticeForPhaseChange } from "./notificationRule";

/** Nobody is looking, and nothing about this wait has been announced yet. */
const away = { announcedSinceMs: undefined, foreground: false };
/** The session is on screen and the window is in front. */
const watching = { announcedSinceMs: undefined, foreground: true };

describe("noticeForPhaseChange", () => {
  it("announces a wait the user has not looked at", () => {
    expect(
      noticeForPhaseChange("working", "attention", { ...away, sinceMs: 1000 }),
    ).toBe("waiting");
  });

  it("does not announce the same wait twice", () => {
    expect(
      noticeForPhaseChange("attention", "attention", {
        ...away,
        sinceMs: 1000,
        announcedSinceMs: 1000,
      }),
    ).toBe(null);
  });

  it("announces a new wait on the same session", () => {
    expect(
      noticeForPhaseChange("working", "attention", {
        ...away,
        sinceMs: 9000,
        announcedSinceMs: 1000,
      }),
    ).toBe("waiting");
  });

  it("says nothing about a wait the user is watching", () => {
    expect(
      noticeForPhaseChange("working", "attention", {
        ...watching,
        sinceMs: undefined,
      }),
    ).toBe(null);
  });

  it("announces a turn that ended while the window was not in front", () => {
    expect(
      noticeForPhaseChange("working", "finished", {
        ...away,
        sinceMs: undefined,
      }),
    ).toBe("done");
  });

  it("says nothing about a turn that ended in front of the user", () => {
    expect(
      noticeForPhaseChange("working", "finished", {
        ...watching,
        sinceMs: undefined,
      }),
    ).toBe(null);
  });

  it("announces a wait whose latch arrived after the phase did", () => {
    // Measured on the machine: the store writes the new phase first and the latch in a second
    // write a moment later, so by the time the wait is knowable as "nobody has looked at this"
    // the phase itself is no longer news. A wait is news for as long as it is latched and
    // nobody has been told about it, which is what this pins - keying it on the phase changing
    // instead would miss every wait.
    expect(
      noticeForPhaseChange("attention", "attention", { ...away, sinceMs: 1000 }),
    ).toBe("waiting");
  });
});