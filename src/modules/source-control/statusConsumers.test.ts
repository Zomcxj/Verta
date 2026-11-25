import { describe, expect, it } from "vitest";
import type { SidebarViewId } from "@/modules/sidebar";
import { isGitTabKind, isStatusLive, statusConsumers } from "./statusConsumers";

const base = {
  gitPanelOpen: false,
  sidebarCollapsed: false,
  sidebarView: "explorer" as SidebarViewId,
  activeTabKind: "terminal" as string | undefined,
  explorerGitDecorations: false,
};
const live = (over: Partial<typeof base>) =>
  isStatusLive(statusConsumers({ ...base, ...over }));

describe("statusConsumers", () => {
  it("is idle when nothing that shows git state is on screen", () => {
    expect(live({})).toBe(false);
    expect(live({ activeTabKind: "editor" })).toBe(false);
    expect(live({ activeTabKind: undefined })).toBe(false);
  });

  it("goes live for the Git panel while it is expanded", () => {
    // Since the Git panel moved to the right, whether it is live depends only on its own open state, not on the sidebar.
    expect(live({ gitPanelOpen: true })).toBe(true);
    expect(
      statusConsumers({ ...base, gitPanelOpen: true, sidebarCollapsed: true })
        .panel,
    ).toBe(true);
  });

  it("goes live for a visible git tab even with the sidebar collapsed", () => {
    for (const kind of ["git-diff", "git-history", "git-commit-file"]) {
      expect(live({ activeTabKind: kind, sidebarCollapsed: true })).toBe(true);
    }
    expect(isGitTabKind("ai-diff")).toBe(false);
    expect(isGitTabKind("terminal")).toBe(false);
  });

  it("treats explorer decorations as a consumer only while the explorer is on screen", () => {
    expect(live({ explorerGitDecorations: true })).toBe(true);
    expect(live({ explorerGitDecorations: true, sidebarCollapsed: true })).toBe(
      false,
    );
    // With the session list on screen the file tree is not, so there are no decorations to draw.
    expect(
      statusConsumers({
        ...base,
        sidebarView: "launcher",
        explorerGitDecorations: true,
      }).explorerDecorations,
    ).toBe(false);
  });

  it("is idle with the explorer open and decorations off", () => {
    // Nothing that shows git state is on screen: the panel is closed, the tab is a terminal, and
    // the file tree draws no decorations. This used to be the case that kept the header's change
    // badge stale on purpose; the badge is gone, so all it says now is that the plain case is idle.
    expect(statusConsumers({ ...base, explorerGitDecorations: false })).toEqual(
      { panel: false, gitTab: false, explorerDecorations: false },
    );
  });
});