import { describe, expect, it } from "vitest";
import type { Tab, TerminalTab } from "./useTabs";
import { warmTargets } from "./warmTargets";

/**
 * Warming decides what a launch spawns, so these cases are the whole rule: an agent that is going
 * to run anyway starts at launch, and a plain terminal nobody asked for does not.
 */
function terminal(id: number, extra: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    kind: "terminal",
    cold: true,
    paneTree: {
      kind: "leaf",
      id: id * 10,
      cwd: "F:/x",
      workspace: { kind: "local" },
    },
    activeLeafId: id * 10,
    ...extra,
  } as TerminalTab;
}

describe("which restored tabs a launch warms", () => {
  it("warms a restored session tab even while another tab is active", () => {
    // The reported case: the agent took 4.4 to 13.9 s to paint its own screen, and it only started
    // when the tab was activated, so the user sat through that inside a covered pane.
    const tabs = [
      terminal(1, { pendingResume: true, sessionId: "ses_a" }),
      terminal(2, { pendingResume: true, sessionId: "ses_b" }),
    ] as Tab[];
    expect(warmTargets(tabs, 2).map((tab) => tab.id)).toEqual([1, 2]);
  });

  it("leaves a plain terminal cold until it is asked for", () => {
    // Nothing waits on it, and warming it would spawn a shell per restored tab at every launch.
    const tabs = [terminal(1), terminal(2, { pendingResume: true, sessionId: "ses_a" })] as Tab[];
    expect(warmTargets(tabs, 2).map((tab) => tab.id)).toEqual([2]);
  });

  it("warms the active tab whatever it is", () => {
    const tabs = [terminal(1), terminal(2)] as Tab[];
    expect(warmTargets(tabs, 1).map((tab) => tab.id)).toEqual([1]);
  });

  it("never returns a tab that is already warm", () => {
    const tabs = [
      terminal(1, { cold: false }),
      terminal(2, { pendingResume: true, cold: false }),
    ] as Tab[];
    expect(warmTargets(tabs, 1)).toEqual([]);
  });

  it("treats a session tab with no resume marker as a plain terminal", () => {
    // `sessionId` alone is not an intent to run: the marker is what the restore writes when it means
    // to resume, and without it nothing would start even if the tab were warmed.
    const tabs = [terminal(1, { sessionId: "ses_a" })] as Tab[];
    expect(warmTargets(tabs, 2)).toEqual([]);
  });
});
