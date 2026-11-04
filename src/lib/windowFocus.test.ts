import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A file dropped from outside brings the window forward.
 *
 * Read as text, the way the boot test reads its hook: what has to hold is where the call sits, not
 * how it renders. The measurement behind it (2026-11-04): dragging a file onto a name the folder
 * already held, in a window that was not focused, the drop arrived on time and the conflict dialog's
 * DOM was built 42 ms later - and stayed invisible until the window was clicked, because a window
 * that is not focused is not painted. The two surfaces that accept a dropped path are the file tree
 * and the terminal, so both have to bring the window forward as the files land.
 */
const listeners = {
  explorer: readFileSync(
    new URL("../modules/explorer/lib/useExplorerFileDrop.ts", import.meta.url),
    "utf8",
  ),
  terminal: readFileSync(
    new URL("../modules/terminal/lib/useTerminalFileDrop.ts", import.meta.url),
    "utf8",
  ),
};

describe("an external drop", () => {
  for (const [surface, source] of Object.entries(listeners)) {
    it(`${surface}: brings the window forward when the files land`, () => {
      const drop = source.slice(source.indexOf('p.type === "drop"'));
      expect(drop).toContain("bringWindowForward()");
    });

    it(`${surface}: never takes the foreground mid-drag`, () => {
      // During `enter`/`over` the user is still holding the button, and the window the drag started
      // in is the one that should stay in front.
      const beforeDrop = source.slice(0, source.indexOf('p.type === "drop"'));
      expect(beforeDrop).not.toContain("bringWindowForward()");
    });
  }
});