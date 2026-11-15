import type { Tab } from "./useTabs";

/**
 * The cold tabs a launch warms: the ones something is already waiting on.
 *
 * Warming is the only thing that makes a restored tab spawn anything at all, because
 * `selectLiveTerminals` never mounts a cold one. Two kinds qualify.
 *
 * The active tab always does, since that is the pane on screen.
 *
 * And a restored session tab does, because it is going to run its agent either way. Starting that
 * agent at launch rather than at the tab's first activation is the whole point: it takes seconds to
 * paint its own screen (measured on this machine, 2026-11-13: 4.4 to 5.9 s for opencode, 6.6 to
 * 13.9 s for pi), so a tab warmed at launch is already live by the time the user opens it, while a
 * tab warmed on activation shows them a covered pane for that long.
 *
 * A plain terminal is deliberately not here. Nothing is waiting on it, and warming it would spawn a
 * shell per restored tab at every launch for a pane nobody has asked to see yet.
 */
export function warmTargets(tabs: readonly Tab[], activeId: number): Tab[] {
  return tabs.filter(
    (tab) =>
      tab.cold === true &&
      (tab.id === activeId ||
        (tab.kind === "terminal" && tab.pendingResume === true)),
  );
}
