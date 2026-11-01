import { describe, expect, it } from "vitest";
import { lineCounts } from "./lineCounts";

describe("lineCounts", () => {
  it("shows both numbers, zero included", () => {
    expect(lineCounts(13, 0)).toEqual({ added: "+13", removed: "-0" });
  });

  it("keeps a large count as it is", () => {
    expect(lineCounts(1089, 62)).toEqual({ added: "+1089", removed: "-62" });
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
