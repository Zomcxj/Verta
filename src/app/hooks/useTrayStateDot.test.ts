import { describe, expect, it } from "vitest";
import { trayDotFor } from "@/app/hooks/useTrayStateDot";

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
});