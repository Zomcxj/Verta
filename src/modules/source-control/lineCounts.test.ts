import { describe, expect, it } from "vitest";
import { lineCounts } from "./lineCounts";

describe("lineCounts", () => {
  it("shows both numbers, zero included", () => {
    // The minus is U+2212 MINUS SIGN, not the ASCII hyphen: the hyphen sits above the baseline and
    // reads as higher than the plus beside it, while the minus sign is drawn where a minus belongs.
    expect(lineCounts(13, 0)).toEqual({ added: "+13", removed: "\u22120" });
  });

  it("keeps a large count as it is", () => {
    expect(lineCounts(1089, 62)).toEqual({ added: "+1089", removed: "\u221262" });
  });

  it("never emits an ASCII hyphen as the sign", () => {
    const counts = lineCounts(1, 1);
    expect(counts?.removed.charCodeAt(0)).toBe(0x2212);
    expect(counts?.removed.includes("-")).toBe(false);
  });

  it("says nothing when git could not count", () => {
    expect(lineCounts(null, null)).toBeNull();
  });

  it("says nothing when only one side is missing", () => {
    // The two arrive together, so half a pair means the read is not trustworthy.
    expect(lineCounts(4, null)).toBeNull();
    expect(lineCounts(null, 4)).toBeNull();
  });
});
