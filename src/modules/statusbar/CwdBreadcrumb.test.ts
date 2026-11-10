import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "CwdBreadcrumb.tsx"), "utf8");

describe("the status bar's path", () => {
  it("offers the folders beside a segment, not only inside it", () => {
    // The trail could only ever go down: clicking a segment went into it, and the folder next to it
    // was two moves away. Each segment carries the subfolders of its *parent* instead.
    expect(source).toMatch(/parentPath\(path\)/);
    expect(source).toMatch(/list_subdirs[\s\S]{0,200}path: parent/);
    expect(source).toMatch(/childPath\(parent, name\)/);
  });

  it("marks the folder you are in as the one that is here", () => {
    // A list of the folders beside this one has to say which of them this one is, or every entry
    // reads the same.
    expect(source).toMatch(/DropdownMenuRadioGroup/);
    expect(source).toMatch(/value=\{here\}/);
  });

  it("gives the folder you are in the same list, under its own children", () => {
    // The folder you are in is where you notice you meant the one next to it.
    expect(source).toMatch(/SiblingList/);
    expect(source).toMatch(/DropdownMenuSeparator/);
  });

  it("reads a listing when a menu opens, not on every render", () => {
    // The bar re-renders on every tab change; a request per segment per render would be a syscall
    // storm for a path nobody is looking at.
    expect(source).toMatch(/if \(open\) load\(\)/);
  });
});
