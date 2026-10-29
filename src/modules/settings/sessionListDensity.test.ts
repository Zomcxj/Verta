import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, coerceSessionListDensity } from "./store";

describe("coerceSessionListDensity", () => {
  it("keeps the two densities", () => {
    expect(coerceSessionListDensity("standard")).toBe("standard");
    expect(coerceSessionListDensity("compact")).toBe("compact");
  });

  it("draws the standard list for anything it does not recognise", () => {
    // A hand-edited file, a value a future version wrote, a stray boolean: the list still
    // has to draw, and standard is the one every existing install already shows.
    expect(coerceSessionListDensity("dense")).toBe("standard");
    expect(coerceSessionListDensity("")).toBe("standard");
    expect(coerceSessionListDensity(true)).toBe("standard");
    expect(coerceSessionListDensity(undefined)).toBe("standard");
  });

  it("defaults to the standard list", () => {
    expect(DEFAULT_PREFERENCES.sessionListDensity).toBe("standard");
  });
});
