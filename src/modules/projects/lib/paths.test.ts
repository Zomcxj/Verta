import { describe, expect, it } from "vitest";
import {
  basename,
  mergeProjectPaths,
  normalizePath,
  removeProjectPath,
  samePath,
} from "./paths";

describe("normalizePath", () => {
  it("trims and drops a trailing separator", () => {
    expect(normalizePath("  F:\\work\\Verta \\ ")).toBe("F:\\work\\Verta");
    expect(normalizePath("/home/cxj/workspace/")).toBe("/home/cxj/workspace");
  });

  it("keeps drive roots readable", () => {
    expect(normalizePath("C:\\")).toBe("C:\\");
    expect(normalizePath("C:")).toBe("C:\\");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("samePath", () => {
  it("compares case-insensitively and ignores separators", () => {
    expect(samePath("F:\\Work\\Verta", "f:/work/verta")).toBe(true);
    expect(samePath("F:\\work\\Verta\\", "F:\\work\\Verta")).toBe(true);
    expect(samePath("F:\\work\\Verta", "F:\\work\\Verta2")).toBe(false);
  });

  it("treats missing values as not equal", () => {
    expect(samePath(null, "F:\\work")).toBe(false);
    expect(samePath("F:\\work", null)).toBe(false);
    expect(samePath(null, null)).toBe(false);
  });
});

describe("basename", () => {
  it("takes the last segment whichever separator", () => {
    expect(basename("F:\\work\\Verta")).toBe("Verta");
    expect(basename("/home/cxj/workspace/token-monitor/")).toBe("token-monitor");
  });
});

describe("mergeProjectPaths", () => {
  it("keeps order and never adds the same directory twice", () => {
    const merged = mergeProjectPaths(
      ["F:\\work\\Verta"],
      ["f:/work/verta", "F:\\work\\Other"],
    );
    expect(merged).toEqual(["F:\\work\\Verta", "F:\\work\\Other"]);
  });

  it("drops empty entries instead of storing blank lines", () => {
    expect(mergeProjectPaths([], ["  ", ""])).toEqual([]);
  });
});

describe("removeProjectPath", () => {
  it("removes the matching entry whatever the spelling", () => {
    expect(
      removeProjectPath(["F:\\work\\A", "F:\\work\\B"], "f:/work/a"),
    ).toEqual(["F:\\work\\B"]);
  });

  it("leaves the list alone when nothing matches", () => {
    const paths = ["F:\\work\\A"];
    expect(removeProjectPath(paths, "F:\\work\\Z")).toEqual(paths);
  });
});