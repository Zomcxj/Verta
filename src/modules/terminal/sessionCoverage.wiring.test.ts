import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The pane whose session is starting stays hidden, whatever tab is on screen.
 *
 * Reported twice. The first report was "加载动画一切标签就没了", which was the layer's *state* being
 * cleared on a tab switch; that is fixed by `sessionOpeningAlive`. The second was "切标签再切回加载
 * 动画消失变成终端命令": the state survived, but the pane did not. `TerminalStack` was handed one
 * boolean, `covered`, and that boolean means "the transition layer is up in the tab you are looking
 * at" - false the moment the reader switches away. The pane was therefore uncovered on the way out,
 * and its own screen already held the resume command, so coming back showed that command for the
 * frames before the layer re-mounted.
 *
 * The fix is a second, leaf-shaped answer: the leaf keeps its pixels hidden until its session paints,
 * regardless of which tab is active. Read as text, the way the wiring tests here do: this repository
 * renders no components.
 */
const workspace = readFileSync(
  new URL("../../app/components/WorkspaceSurface.tsx", import.meta.url),
  "utf8",
);
const stack = readFileSync(new URL("./TerminalStack.tsx", import.meta.url), "utf8");
const tree = readFileSync(new URL("./PaneTreeView.tsx", import.meta.url), "utf8");
const pane = readFileSync(new URL("./TerminalPane.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../../app/App.tsx", import.meta.url), "utf8");

describe("the pane a session is starting in", () => {
  it("is named by leaf, not by whether its tab is the one on screen", () => {
    // The two questions are different, and answering the second one for both is the bug.
    expect(app).toMatch(/sessionOpeningLeaves=\{sessionOpenings\.map\(/);
    expect(workspace).toMatch(/coveredLeaves=\{coveredLeaves\}/);
    expect(workspace).toMatch(
      /const coveredLeaves = sessionTransitionEnabled\(transitionVariant\)/,
    );
  });

  it("keeps its opacity at zero all the way down to the pane", () => {
    // Passed through every layer that draws a pane, so no layer can decide on its own that a tab
    // switch means "show it".
    expect(stack).toMatch(/coveredLeaves\?: readonly number\[\]/);
    expect(tree).toMatch(/coveredLeaves\?: readonly number\[\]/);
    expect(pane).toMatch(/covered\?: boolean/);
    expect(pane).toMatch(/\.\.\.\(covered \? \{ opacity: 0 \} : null\)/);
  });

  it("does not use visibility to hide it, which would drop the canvas", () => {
    // `visibility` is the pane's own, and hiding it that way unmounts the renderer's canvas, so the
    // pane is blank at the moment the transition lifts instead of showing the session already there.
    expect(pane).not.toMatch(/covered \? \{ visibility/);
  });
});
