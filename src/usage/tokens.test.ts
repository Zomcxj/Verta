import { describe, expect, it } from "vitest";
import {
  countTokens,
  localOffsetMinutes,
  sinceForDays,
  type UsageParts,
  type UsagePayload,
  withScope,
} from "./tokens";

const tokens = (parts: Partial<UsageParts>): UsageParts => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  unsplit: 0,
  ...parts,
});

describe("countTokens", () => {
  // The same table Rust's `the_same_events_answer_differently_under_different_scopes` pins, so
  // the two implementations are checked against the same numbers rather than against each other.
  const parts = tokens({
    input: 100,
    output: 20,
    cacheRead: 900,
    cacheWrite: 80,
  });

  it("counts everything under the full scope", () => {
    expect(countTokens(parts, { cacheRead: true, cacheWrite: true })).toBe(
      1_100,
    );
  });

  it("drops cache reads and writes when both switches are off", () => {
    expect(countTokens(parts, { cacheRead: false, cacheWrite: false })).toBe(
      120,
    );
  });

  it("keeps one cache class when only the other switch is off", () => {
    expect(countTokens(parts, { cacheRead: true, cacheWrite: false })).toBe(
      1_020,
    );
    expect(countTokens(parts, { cacheRead: false, cacheWrite: true })).toBe(
      200,
    );
  });

  it("always counts tokens a tool did not split", () => {
    // pi's `totalTokens` with no parts: spent either way, with nothing to attribute it to.
    const unsplit = tokens({ unsplit: 250 });
    expect(countTokens(unsplit, { cacheRead: true, cacheWrite: true })).toBe(
      250,
    );
    expect(countTokens(unsplit, { cacheRead: false, cacheWrite: false })).toBe(
      250,
    );
  });

  it("counts reasoning tokens, which opencode reports separately from output", () => {
    expect(
      countTokens(tokens({ reasoning: 7 }), {
        cacheRead: false,
        cacheWrite: false,
      }),
    ).toBe(7);
  });
});

describe("withScope", () => {
  const payload: UsagePayload = {
    sinceMs: null,
    offsetMinutes: 480,
    scope: { cacheRead: true, cacheWrite: true },
    parts: tokens({ input: 100, output: 20, cacheRead: 900, cacheWrite: 80 }),
    tokens: 1_100,
    events: 3,
    excludedCacheRead: 0,
    excludedCacheWrite: 0,
    days: [
      {
        day: 20_000,
        label: "2026-11-13",
        parts: tokens({ input: 10, cacheRead: 40 }),
        tokens: 50,
        events: 1,
      },
    ],
    models: [
      {
        provider: "workbuddy",
        model: "glm-5.3-flash",
        parts: tokens({ input: 5, cacheWrite: 5 }),
        tokens: 10,
        events: 1,
      },
    ],
    failures: [],
  };

  it("recomputes the total, every row and the excluded counts together", () => {
    const shown = withScope(payload, { cacheRead: false, cacheWrite: false });
    expect(shown.tokens).toBe(120);
    expect(shown.days[0].tokens).toBe(10);
    expect(shown.models[0].tokens).toBe(5);
    // What the window is not counting is stated, not silently dropped from the total.
    expect(shown.excludedCacheRead).toBe(900);
    expect(shown.excludedCacheWrite).toBe(80);
    expect(shown.scope).toEqual({ cacheRead: false, cacheWrite: false });
  });

  it("leaves the read itself alone, so switching scope costs nothing", () => {
    const shown = withScope(payload, { cacheRead: false, cacheWrite: false });
    expect(shown.parts).toBe(payload.parts);
    expect(shown.days[0].parts).toBe(payload.days[0].parts);
    expect(shown.events).toBe(payload.events);
  });

  it("agrees with the count Rust returned for the same scope", () => {
    expect(withScope(payload, payload.scope).tokens).toBe(payload.tokens);
  });
});

describe("range helpers", () => {
  it("pushes the offset as minutes east of UTC, which is the sign Rust wants", () => {
    // `getTimezoneOffset` is minutes *behind* UTC: UTC+8 reports -480.
    const inShanghai = { getTimezoneOffset: () => -480 } as unknown as Date;
    expect(localOffsetMinutes(inShanghai)).toBe(480);
    const inNewYork = { getTimezoneOffset: () => 300 } as unknown as Date;
    expect(localOffsetMinutes(inNewYork)).toBe(-300);
  });

  it("asks for everything as null rather than as a very old date", () => {
    expect(sinceForDays(0, 1_700_000_000_000)).toBeNull();
    expect(sinceForDays(7, 1_700_000_000_000)).toBe(
      1_700_000_000_000 - 7 * 24 * 60 * 60 * 1000,
    );
  });
});
