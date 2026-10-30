import { describe, expect, it } from "vitest";
import { advanceCursor, isNewer, parseActivityCursor } from "./activity";

/**
 * The three questions the dot asks, kept apart from any React or Tauri code so they can be
 * answered here: is there something newer than the last time it was looked at, what does a mark
 * become after something is read, and what happens when the stored marks are not what we wrote.
 */
describe("isNewer", () => {
  it("compares the two timestamps GitHub hands out", () => {
    expect(isNewer("2026-10-29T03:00:00Z", "2026-10-28T03:00:00Z")).toBe(true);
    expect(isNewer("2026-10-28T03:00:00Z", "2026-10-29T03:00:00Z")).toBe(false);
    expect(isNewer("2026-10-29T03:00:00Z", "2026-10-29T03:00:00Z")).toBe(false);
  });

  it("no cursor means everything is new", () => {
    expect(isNewer("2026-10-29T03:00:00Z", null)).toBe(true);
    expect(isNewer("2026-10-29T03:00:00Z", undefined)).toBe(true);
  });

  it("nothing to report is never new, and a broken value is not a claim", () => {
    // No answer from gh: silence, not a dot. The reverse (a dot on every failure) would turn
    // every repository without gh installed into a dot.
    expect(isNewer(null, "2026-10-28T03:00:00Z")).toBe(false);
    expect(isNewer(undefined, "2026-10-28T03:00:00Z")).toBe(false);
    // An unparseable mark counts as "never looked": better one extra dot than a permanently
    // suppressed one.
    expect(isNewer("2026-10-29T03:00:00Z", "yesterday")).toBe(true);
    // An unparseable answer is not a timestamp, so it is not newer than anything.
    expect(isNewer("nonsense", "2026-10-28T03:00:00Z")).toBe(false);
  });
});

describe("advanceCursor", () => {
  it("moves one repository's mark and leaves the rest alone", () => {
    const before = { "a/b": "2026-10-01T00:00:00Z" };
    expect(advanceCursor(before, "c/d", "2026-10-29T00:00:00Z")).toEqual({
      "a/b": "2026-10-01T00:00:00Z",
      "c/d": "2026-10-29T00:00:00Z",
    });
  });

  it("never moves backwards: a later mark stays later", () => {
    const before = { "a/b": "2026-10-29T00:00:00Z" };
    expect(advanceCursor(before, "a/b", "2026-10-01T00:00:00Z")).toEqual(before);
  });

  it("keeps the map it was given when nothing changes", () => {
    const before = { "a/b": "2026-10-29T00:00:00Z" };
    // Same object back: the caller can skip a write with an identity check.
    expect(advanceCursor(before, "a/b", "2026-10-29T00:00:00Z")).toBe(before);
  });

  it("an unparseable time does not become the mark", () => {
    const before = { "a/b": "2026-10-01T00:00:00Z" };
    expect(advanceCursor(before, "a/b", "not a time")).toBe(before);
    expect(advanceCursor({}, "a/b", "")).toEqual({});
  });

  it("an item seen is not news again until something newer arrives", () => {
    const latest = "2026-10-29T03:00:00Z";
    const cursor = advanceCursor({}, "a/b", latest);
    expect(isNewer(latest, cursor["a/b"])).toBe(false);
    expect(isNewer("2026-10-29T04:00:00Z", cursor["a/b"])).toBe(true);
  });
});

describe("parseActivityCursor", () => {
  it("takes what it recognises and drops the rest", () => {
    expect(parseActivityCursor({ "a/b": "2026-10-01T00:00:00Z", "c/d": 5 })).toEqual({
      "a/b": "2026-10-01T00:00:00Z",
    });
  });

  it("drops marks that are not timestamps", () => {
    expect(parseActivityCursor({ "a/b": "yesterday", "c/d": "" })).toEqual({});
  });

  it("anything that is not an object is no cursor at all", () => {
    expect(parseActivityCursor(null)).toEqual({});
    expect(parseActivityCursor(undefined)).toEqual({});
    expect(parseActivityCursor("x")).toEqual({});
    expect(parseActivityCursor([])).toEqual({});
    expect(parseActivityCursor(42)).toEqual({});
  });
});