import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A session row's context menu.
 *
 * Radix draws a trigger only as part of the menu it opens: rendered on its own it throws
 * "`ContextMenuTrigger` must be used within `ContextMenu`", and the panel's error boundary took the
 * whole list down with it. The menu no longer offers renaming - a session's name belongs to the tool
 * that wrote it, and is changed inside it - so a row has no state that takes it out of the menu.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const list = readFileSync(new URL("./SessionList.tsx", import.meta.url), "utf8");

describe("a session row's context menu", () => {
  it("draws its trigger inside the one menu it opens, in every state", () => {
    expect(list.match(/<ContextMenuTrigger\b/g)?.length).toBe(1);
    expect(list.match(/<ContextMenu\b/g)?.length).toBe(1);
    // The row comes back bare only where there is no menu at all.
    expect(list).toMatch(/if \(!actions\) return body;/);
  });

  it("offers no rename", () => {
    // The name is the tool's: Claude Code writes it in its own transcript, and the app appending a
    // line the tool is not known to read back is what was refused here for that tool alone.
    expect(list).not.toContain("launcher.renameSession");
    expect(list).not.toContain("onStartRename");
    expect(list).not.toContain("RenameField");
  });
});
