import { beforeEach, describe, expect, it } from "vitest";
import {
  noteSessionOpeningLifted,
  noteSessionOpeningShown,
  resetSessionOpeningRecords,
  sessionOpeningLeaf,
  sessionOpeningRecords,
} from "./sessionOpeningLog";

const wait = (
  over: Partial<Parameters<typeof noteSessionOpeningLifted>[2]>,
) => ({
  rule: "own-screen" as const,
  ticks: 4,
  heldTicks: 0,
  bytes: 1_200,
  ...over,
});

describe("what a session-opening cover did", () => {
  beforeEach(() => resetSessionOpeningRecords());

  it("records how long the cover was up, and what ended it", () => {
    // The complaint this exists for is a pause, so the number that matters is the duration between
    // the cover going up and coming down - not the wait's own elapsed time, which excludes the
    // terminal coming up before the command is written.
    noteSessionOpeningShown(1, 42, "opencode", 10_000);
    expect(sessionOpeningLeaf(1)).toBe(42);
    noteSessionOpeningLifted(1, "ui-painted", wait({}), "opencode\n> ", 12_340);
    expect(sessionOpeningRecords()).toEqual([
      {
        seq: 1,
        leafId: 42,
        tool: "opencode",
        coveredMs: 2_340,
        lift: "ui-painted",
        rule: "own-screen",
        ticks: 4,
        heldTicks: 0,
        bytes: 1_200,
        screenTail: "opencode\n> ",
      },
    ]);
    expect(sessionOpeningLeaf(1)).toBeNull();
  });

  it("keeps the screen it lifted on, which is what every rule is a question about", () => {
    const long = `${"x".repeat(400)}launch: opencode --session abc`;
    noteSessionOpeningShown(2, 7, "opencode", 0);
    noteSessionOpeningLifted(2, "ui-painted", wait({}), long, 100);
    const [record] = sessionOpeningRecords();
    if (!record) throw new Error("no record");
    expect(record.screenTail?.endsWith("launch: opencode --session abc")).toBe(
      true,
    );
    expect(record.screenTail?.length).toBe(200);
  });

  it("says when the cover ended at the fallback timer or left with its tab", () => {
    // Both are pauses the user sees without any agent being slow, and telling them apart from a
    // slow agent is the whole point of recording the lift.
    noteSessionOpeningShown(3, 8, null, 0);
    noteSessionOpeningLifted(3, "fallback-timer", null, null, 45_500);
    noteSessionOpeningShown(4, 9, "claude", 0);
    noteSessionOpeningLifted(4, "tab-left", null, null, 900);
    expect(
      sessionOpeningRecords().map((r) => [r.lift, r.coveredMs, r.rule]),
    ).toEqual([
      ["fallback-timer", 45_500, null],
      ["tab-left", 900, null],
    ]);
  });

  it("records a wait that ran to its cap as having given up", () => {
    // A session whose agent never takes the screen ends here. Its screen tail is the only thing
    // that can say why, so a record without one would be useless in exactly this case.
    noteSessionOpeningShown(5, 10, "pi", 0);
    noteSessionOpeningLifted(
      5,
      "fallback-timer",
      wait({ rule: "gave-up", ticks: 375, heldTicks: 12, bytes: 40 }),
      "special@LAPTOP MINGW64 ~ $ pi --resume abc",
      45_500,
    );
    const [record] = sessionOpeningRecords();
    expect(record).toMatchObject({
      rule: "gave-up",
      ticks: 375,
      heldTicks: 12,
    });
  });

  it("ignores a lift that is no longer the pending start", () => {
    // Each start takes a token so a slower earlier one cannot lift a newer cover; the log has to
    // agree, or an opening would be recorded with another one's timing.
    noteSessionOpeningShown(6, 11, "opencode", 0);
    noteSessionOpeningLifted(6, "ui-painted", wait({}), "a", 100);
    noteSessionOpeningLifted(6, "ui-painted", wait({}), "b", 200);
    expect(sessionOpeningRecords()).toHaveLength(1);
  });

  it("drops a start that a newer one replaced, rather than recording it as slow", () => {
    noteSessionOpeningShown(7, 12, "opencode", 0);
    noteSessionOpeningShown(8, 13, "claude", 50);
    noteSessionOpeningLifted(7, "ui-painted", wait({}), "old", 60);
    expect(sessionOpeningRecords()).toHaveLength(0);
    noteSessionOpeningLifted(8, "ui-painted", wait({}), "new", 70);
    expect(sessionOpeningRecords().map((r) => r.leafId)).toEqual([13]);
  });

  it("keeps the newest openings and forgets the oldest", () => {
    // Bounded on purpose: this is installed on every build and read only when something is wrong.
    for (let i = 0; i < 60; i += 1) {
      noteSessionOpeningShown(i, i, "opencode", 0);
      noteSessionOpeningLifted(i, "ui-painted", wait({}), null, 10);
    }
    const records = sessionOpeningRecords();
    expect(records).toHaveLength(50);
    expect(records[records.length - 1]?.seq).toBe(60);
    expect(records[0]?.seq).toBe(11);
  });
});
