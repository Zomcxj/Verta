import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Paging through a folder's pictures in the image viewer.
 *
 * A picture opened as a file used to be one picture: to look at the next screenshot the reader went
 * back to the explorer. Windows' own photo viewer is the shape asked for - the folder is the
 * collection, and two arrows (or the two arrow keys) move inside it ("类似 windows 自带的照片查看器").
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components. What
 * is worth pinning is the wiring: the folder's listing is the window's own (`fs_read_dir`), which
 * entries of it are pages is one module (`imageSiblings`), and the keys belong to the pane in front
 * rather than to every mounted tab.
 */
const pane = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const helpers = readFileSync(
  new URL("./lib/imageSiblings.ts", import.meta.url),
  "utf8",
);

describe("the image viewer's folder paging", () => {
  it("lists the folder with the window's own directory read", () => {
    expect(pane).toContain('invoke<DirEntry[]>("fs_read_dir"');
    expect(pane).toContain("imageSiblingPaths(entries, folder)");
    // The one module that decides what a page of a folder is.
    expect(helpers).toContain("export function imageSiblingPaths(");
  });

  it("moves on the two arrow keys and on the two buttons", () => {
    expect(pane).toContain('event.key !== "ArrowLeft" && event.key !== "ArrowRight"');
    expect(pane).toContain("onClick={() => move(-1)}");
    expect(pane).toContain("onClick={() => move(1)}");
    // Both ends are drawn spent, so the reader can see where the folder stops.
    expect(pane).toContain("disabled={index <= 0}");
    expect(pane).toContain("disabled={index >= siblings.length - 1}");
  });

  it("leaves the keys to the pane in front", () => {
    // Every open tab keeps its editor mounted, hidden ones behind `aria-hidden`: without this check
    // the arrow keys would page a folder behind the tab being looked at.
    expect(pane).toContain('node.closest(\'[aria-hidden="true"]\')');
  });

  it("says where it is in the folder", () => {
    expect(pane).toContain('t("editor.image.position"');
    expect(pane).toMatch(/siblings\.length > 1 \?/);
  });
});
