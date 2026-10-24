import { describe, expect, it } from "vitest";
import {
  applyTabPatch,
  type EditorTab,
  type PreviewTab,
  type TerminalTab,
} from "./useTabs";

const PREVIEW_LABEL = "Preview";

const terminal: TerminalTab = {
  id: 1,
  kind: "terminal",
  title: "shell",
  cwd: "/repo",
  paneTree: { kind: "leaf", id: 2 },
  activeLeafId: 2,
};

function editor(id: number, preview: boolean): EditorTab {
  return {
    id,
    kind: "editor",
    title: "main.rs",
    path: "/repo/main.rs",
    dirty: false,
    preview,
  };
}

describe("applyTabPatch", () => {
  it("returns the same tab when the patch changes nothing", () => {
    const tab = terminal;
    expect(applyTabPatch(tab, { cwd: "/repo" }, PREVIEW_LABEL)).toBe(tab);
    expect(applyTabPatch(tab, { title: "shell" }, PREVIEW_LABEL)).toBe(tab);
    // A patch with fields the tab does not carry is still a no-op.
    expect(applyTabPatch(tab, { dirty: undefined }, PREVIEW_LABEL)).toBe(tab);
  });

  it("returns a new tab when a field actually changes", () => {
    const tab = terminal;
    const next = applyTabPatch(tab, { cwd: "/repo/sub" }, PREVIEW_LABEL);
    expect(next).not.toBe(tab);
    expect(next).toMatchObject({ cwd: "/repo/sub" });
  });

  it("clears a terminal custom title with an empty string", () => {
    const tab: TerminalTab = { ...terminal, customTitle: "build" };
    const cleared = applyTabPatch(tab, { customTitle: "" }, PREVIEW_LABEL);
    expect(cleared).toMatchObject({ kind: "terminal" });
    expect((cleared as TerminalTab).customTitle).toBeUndefined();
    // Setting the same custom title again is not a change.
    expect(applyTabPatch(tab, { customTitle: "build" }, PREVIEW_LABEL)).toBe(
      tab,
    );
  });

  it("pins a preview editor tab the moment it becomes dirty", () => {
    const tab = editor(3, true);
    const dirty = applyTabPatch(tab, { dirty: true }, PREVIEW_LABEL);
    expect(dirty).toMatchObject({ preview: false, dirty: true });

    // Reporting the same dirty state twice does not keep rewriting the tab.
    expect(applyTabPatch(dirty, { dirty: true }, PREVIEW_LABEL)).toBe(dirty);
  });

  it("does not pin a preview tab when a patch only clears dirty", () => {
    const tab = editor(3, true);
    expect(applyTabPatch(tab, { dirty: false }, PREVIEW_LABEL)).toBe(tab);
  });

  it("derives a preview tab's title from its url", () => {
    const tab: PreviewTab = {
      id: 4,
      kind: "preview",
      title: "Preview",
      url: "about:blank",
    };
    const next = applyTabPatch(
      tab,
      { url: "https://example.com/docs" },
      PREVIEW_LABEL,
    );
    expect(next).toMatchObject({
      url: "https://example.com/docs",
      title: "example.com",
    });
    // The same url again is not a change.
    expect(
      applyTabPatch(
        next,
        { url: "https://example.com/docs" },
        PREVIEW_LABEL,
      ),
    ).toBe(next);
  });
});
