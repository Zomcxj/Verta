import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Where the side preview gets its text.
 *
 * The rule itself lives in `useDocument` and is one line; what is checked here is the wiring, the
 * way `repoActivityDot.test.ts` checks the "something new" dot, because this one failed quietly for
 * a long time: every part was individually reasonable and the pair was wrong. The editor's document
 * state only moves when a file is loaded or reloaded, so a preview reading it drew the file as it was
 * on disk while the person typed next to it - reported and measured as the preview still showing
 * `# Old title` after the editor's own text read `# New title`.
 *
 * Two things have to hold together, and either one alone brings the bug back: the hook has to
 * publish the live buffer, and the pane has to hand the preview that, rather than `doc.content`.
 */
const pane = readFileSync(new URL("./EditorPane.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("./lib/useDocument.ts", import.meta.url), "utf8");

describe("the side preview follows typing", () => {
  it("publishes the buffer on every edit", () => {
    // Inside `onChange`, which is what CodeMirror calls per keystroke.
    const onChange = hook.slice(hook.indexOf("const onChange = useCallback("));
    const body = onChange.slice(0, onChange.indexOf("}, ["));
    expect(body).toContain("publishBuffer(next)");
  });

  it("publishes what was loaded, so a preview opened later starts on the right text", () => {
    // Subscribing hands over the current buffer; adopting a read must therefore publish it.
    const adopt = hook.slice(hook.indexOf("const adoptRead = useCallback("));
    const body = adopt.slice(0, adopt.indexOf("}, ["));
    expect(body).toContain("publishBuffer(content)");
  });

  it("gives the preview the live text rather than the loaded document", () => {
    expect(pane).toContain("content={previewText}");
    expect(pane).not.toContain("content={doc.content}");
    expect(pane).toContain("subscribeBuffer(setPreviewText)");
  });

  it("only listens while the column is on screen", () => {
    // Otherwise every keystroke re-renders the pane for a preview nobody can see.
    const effect = pane.slice(pane.indexOf("subscribeBuffer(setPreviewText)"));
    const guard = pane.slice(0, pane.indexOf("subscribeBuffer(setPreviewText)"));
    expect(guard).toContain("if (!sideVisible) return;");
    expect(effect).toContain("[sideVisible, subscribeBuffer]");
  });

  it("has no other consumer of the subscription", () => {
    // One consumer is the whole design: the channel exists for the preview, and a second caller
    // would mean the cost of re-rendering per keystroke is being paid somewhere unexpected. The
    // three mentions here are the destructuring, the call and the effect's dependency list.
    expect(pane.split("subscribeBuffer").length - 1).toBe(3);
  });
});