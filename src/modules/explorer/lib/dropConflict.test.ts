import { describe, expect, it } from "vitest";
import { baseName, conflictingNames } from "./dropConflict";

describe("baseName", () => {
  it("takes the last segment with either separator", () => {
    expect(baseName("C:/work/shot.png")).toBe("shot.png");
    expect(baseName("C:\\work\\shot.png")).toBe("shot.png");
  });

  it("ignores a trailing separator", () => {
    expect(baseName("C:/work/folder/")).toBe("folder");
  });

  it("answers a bare name as itself", () => {
    expect(baseName("shot.png")).toBe("shot.png");
  });
});

describe("conflictingNames", () => {
  it("names what the destination would hold", () => {
    expect(conflictingNames(["C:/a/shot.png", "C:/b/notes.txt"])).toEqual([
      "shot.png",
      "notes.txt",
    ]);
  });

  it("says one name once, even from two folders", () => {
    // Two `shot.png` from different folders are one name in the destination, so the dialog asks
    // about it once.
    expect(conflictingNames(["C:/a/shot.png", "C:/b/shot.png"])).toEqual(["shot.png"]);
  });

  it("keeps the order the sources came in", () => {
    expect(conflictingNames(["C:/z.png", "C:/a.png"])).toEqual(["z.png", "a.png"]);
  });

  it("has nothing to say about an empty list", () => {
    expect(conflictingNames([])).toEqual([]);
  });
});
