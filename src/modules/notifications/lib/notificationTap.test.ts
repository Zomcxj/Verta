import { describe, expect, it } from "vitest";
import { tappedPty } from "./notificationTap";

describe("tappedPty", () => {
  it("reads the session a tap is about", () => {
    expect(
      tappedPty({ actionId: "tap", notification: { extra: { ptyId: 12 } } }),
    ).toBe(12);
  });

  it("ignores anything that is not a tap on the notification", () => {
    // A button on the notification is its own action, and nothing here acts on one.
    expect(
      tappedPty({ actionId: "button.0", notification: { extra: { ptyId: 12 } } }),
    ).toBe(null);
  });

  it("says nothing when the notification carries no session", () => {
    expect(tappedPty({ actionId: "tap" })).toBe(null);
    expect(tappedPty({ actionId: "tap", notification: { extra: {} } })).toBe(null);
    expect(
      tappedPty({ actionId: "tap", notification: { extra: { ptyId: null } } }),
    ).toBe(null);
  });

  it("says nothing for a session that is not a number", () => {
    // The payload crosses a JSON boundary; a session id that came back as text is not one,
    // and reading "0" out of it would send the user to a session that was never named.
    expect(
      tappedPty({ actionId: "tap", notification: { extra: { ptyId: "12" } } }),
    ).toBe(null);
  });
});
