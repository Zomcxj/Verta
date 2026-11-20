import { describe, expect, it } from "vitest";

import {
  folderOf,
  imageSiblingPaths,
  nameOf,
  stepImage,
} from "./imageSiblings";

/**
 * What "the next picture" means when a picture is open.
 *
 * The folder decides it, and the window's own listing already answers with numbers in order - which
 * is the thing worth pinning: a screenshot folder is full of `clip-1794555565322-29212-4.png`, and a
 * plain string sort puts `-10` before `-2`. The list here is passed through as it arrives, so the
 * ordering rule stays in one place (`fs_read_dir`), and what this module promises is only which
 * entries of it are pages.
 */
describe("imageSiblingPaths", () => {
  const entries = [
    { name: "shots", kind: "dir" as const },
    { name: "notes.txt", kind: "file" as const },
    { name: "clip-2.png", kind: "file" as const },
    { name: "clip-10.png", kind: "file" as const },
    { name: "link.jpg", kind: "symlink" as const },
    { name: "broken.tiff", kind: "file" as const },
  ];

  it("keeps the pictures and drops everything else", () => {
    expect(imageSiblingPaths(entries, "D:/shots")).toEqual([
      "D:/shots/clip-2.png",
      "D:/shots/clip-10.png",
      "D:/shots/link.jpg",
    ]);
  });

  it("keeps the listing's order rather than sorting again", () => {
    // `clip-2` before `clip-10`: the order the folder listing gave, which is the numeric-aware one.
    const paths = imageSiblingPaths(entries, "D:/shots");
    expect(paths.indexOf("D:/shots/clip-2.png")).toBeLessThan(
      paths.indexOf("D:/shots/clip-10.png"),
    );
  });

  it("joins with the separator the path already uses", () => {
    expect(imageSiblingPaths(entries, "D:\\shots")).toContain(
      "D:\\shots\\clip-2.png",
    );
    // A trailing separator must not become a doubled one.
    expect(imageSiblingPaths(entries, "D:\\shots\\")).toContain(
      "D:\\shots\\clip-2.png",
    );
  });
});

describe("folderOf and nameOf", () => {
  it("split a Windows path and a slashed one the same way", () => {
    expect(folderOf("D:\\shots\\a.png")).toBe("D:\\shots");
    expect(folderOf("D:/shots/a.png")).toBe("D:/shots");
    expect(nameOf("D:\\shots\\a.png")).toBe("a.png");
    expect(nameOf("D:/shots/a.png")).toBe("a.png");
  });

  it("leave a bare name alone", () => {
    expect(folderOf("a.png")).toBe("a.png");
    expect(nameOf("a.png")).toBe("a.png");
  });
});

describe("stepImage", () => {
  it("moves one picture either way", () => {
    expect(stepImage(1, 1, 3)).toBe(2);
    expect(stepImage(1, -1, 3)).toBe(0);
  });

  it("stops at the ends instead of wrapping", () => {
    expect(stepImage(0, -1, 3)).toBe(0);
    expect(stepImage(2, 1, 3)).toBe(2);
    expect(stepImage(0, 9, 3)).toBe(2);
  });

  it("keeps one picture and no picture where they are", () => {
    expect(stepImage(0, 1, 1)).toBe(0);
    expect(stepImage(0, 1, 0)).toBe(0);
  });
});
