import { describe, expect, it } from "vitest";
import {
  type EditorTab,
  planFileTabOpen,
  planMarkdownTabOpen,
  type Tab,
  type TerminalTab,
} from "./useTabs";

const terminal: TerminalTab = {
  id: 1,
  kind: "terminal",
  title: "shell",
  paneTree: { kind: "leaf", id: 2 },
  activeLeafId: 2,
};

function editor(id: number, path: string, preview: boolean): EditorTab {
  return {
    id,
    kind: "editor",
    title: path,
    path,
    dirty: false,
    preview,
  };
}

describe("planFileTabOpen", () => {
  it("returns the allocated tab id synchronously for line targeting", () => {
    const plan = planFileTabOpen([terminal], "/repo/main.rs", true, () => 3);

    expect(plan.tabId).toBe(3);
    expect(plan.tabs[plan.tabs.length - 1]).toMatchObject({
      id: 3,
      kind: "editor",
      path: "/repo/main.rs",
      preview: false,
    });
  });

  it("reuses the tab that already has the file open", () => {
    const tabs: Tab[] = [terminal, editor(3, "/repo/main.rs", false)];

    const plan = planFileTabOpen(tabs, "/repo/main.rs", true, () => 5);

    expect(plan.tabId).toBe(3);
    expect(plan.tabs).toBe(tabs);
  });

  it("promotes an existing preview in place", () => {
    const preview = editor(3, "/repo/main.rs", true);
    const tabs: Tab[] = [terminal, preview];

    const plan = planFileTabOpen(tabs, "/repo/main.rs", true, () => 5);

    expect(plan.tabId).toBe(3);
    expect(plan.tabs).not.toBe(tabs);
    expect(plan.tabs).toContainEqual(
      expect.objectContaining({ id: 3, preview: false }),
    );
  });

  it("reuses the preview slot instead of opening a second preview", () => {
    const tabs: Tab[] = [terminal, editor(4, "/repo/old.ts", true)];

    const plan = planFileTabOpen(tabs, "/repo/old.ts", false, () => 5);

    expect(plan.tabId).toBe(4);
    expect(plan.tabs).toBe(tabs);
  });

  it("replaces the preview slot, keeping its place in the strip", () => {
    const tabs: Tab[] = [terminal, editor(4, "/repo/old.ts", true)];

    const plan = planFileTabOpen(tabs, "/repo/new.ts", false, () => 5);

    expect(plan.tabId).toBe(5);
    expect(plan.tabs.map((t) => t.id)).toEqual([1, 5]);
    expect(plan.tabs).toContainEqual(
      expect.objectContaining({
        id: 5,
        path: "/repo/new.ts",
        preview: true,
      }),
    );
  });
});

describe("planMarkdownTabOpen", () => {
  it("reuses an open markdown tab", () => {
    const tabs: Tab[] = [
      terminal,
      {
        id: 3,
        kind: "markdown",
        title: "README.md",
        path: "/repo/README.md",
      },
    ];

    const reused = planMarkdownTabOpen(tabs, "/repo/README.md", () => {
      throw new Error("should not allocate");
    });

    expect(reused).toEqual({ tabs, tabId: 3 });
  });

  it("allocates a new markdown tab for a path that is not open", () => {
    const plan = planMarkdownTabOpen([terminal], "/repo/README.md", () => 4);

    expect(plan.tabId).toBe(4);
    expect(plan.tabs).toContainEqual(
      expect.objectContaining({
        id: 4,
        kind: "markdown",
        path: "/repo/README.md",
      }),
    );
  });

  it("normalizes path separators when reusing a markdown tab", () => {
    const tabs: Tab[] = [
      terminal,
      {
        id: 3,
        kind: "markdown",
        title: "README.md",
        path: "C:\\repo\\README.md",
      },
    ];

    const plan = planMarkdownTabOpen(tabs, "C:/repo/README.md", () => {
      throw new Error("should not allocate");
    });

    expect(plan).toEqual({ tabs, tabId: 3 });
  });

  it("preserves markdown and regular files in a mixed launch batch", () => {
    const markdownPlan = planMarkdownTabOpen(
      [terminal],
      "/repo/README.md",
      () => 3,
    );
    const filePlan = planFileTabOpen(
      markdownPlan.tabs,
      "/repo/main.rs",
      true,
      () => 4,
    );

    expect(filePlan.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "markdown",
          path: "/repo/README.md",
        }),
        expect.objectContaining({ kind: "editor", path: "/repo/main.rs" }),
      ]),
    );
  });
});
