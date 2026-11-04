import { describe, expect, it } from "vitest";
import {
  folderAtOrUnder,
  folderName,
  normalizeFolderPath,
} from "./pathContainment";

describe("normalizeFolderPath", () => {
  it("makes one folder out of two spellings", () => {
    expect(normalizeFolderPath("F:\\work\\app\\")).toBe("F:/work/app");
    expect(normalizeFolderPath("F:/work/app/")).toBe("F:/work/app");
  });
});

describe("folderAtOrUnder", () => {
  it("counts the folder itself and anything inside it", () => {
    expect(folderAtOrUnder("F:/work/app", "F:/work/app")).toBe(true);
    expect(folderAtOrUnder("F:/work/app/packages/ui", "F:/work/app")).toBe(true);
  });

  it("ignores case, the way the filesystem does", () => {
    // opencode writes `F:/work/x`, pi writes `F:\work\x`; Windows reads both as one folder.
    expect(folderAtOrUnder("f:\\WORK\\App\\src", "F:/work/app")).toBe(true);
  });

  it("does not match a folder that only shares a prefix", () => {
    expect(folderAtOrUnder("F:/work/application", "F:/work/app")).toBe(false);
  });

  it("matches nothing when the project path is empty", () => {
    // A blank entry in the project list would otherwise swallow every session.
    expect(folderAtOrUnder("F:/work/app", "")).toBe(false);
    expect(folderAtOrUnder("F:/work/app", "  ")).toBe(false);
  });
});

describe("folderName", () => {
  it("takes the last segment, whichever separator it uses", () => {
    expect(folderName("F:\\work\\app")).toBe("app");
    expect(folderName("F:/work/app/")).toBe("app");
    expect(folderName("/home/x/app")).toBe("app");
  });
});
