import { leafIds } from "@/modules/terminal";
import type { Tab } from "@/modules/tabs";

/**
 * Whether the session transition belongs to the tab on screen right now.
 *
 * The layer covers one tab: the one a session was opened into. Clicking a session and
 * closing that tab straight away (or switching to another one) used to leave the animation
 * spinning over whatever terminal was on screen by then, until a blind fallback timer ran
 * out, so this is looked up rather than assumed. A leaf lives in exactly one tab, which is
 * what ties the two together; every pane of that tab shares the same layer.
 */
export function sessionOpeningVisible(
  tabs: Tab[],
  activeId: number,
  leafId: number | null,
): boolean {
  if (leafId === null) return false;
  return tabs.some(
    (tab) =>
      tab.id === activeId &&
      tab.kind === "terminal" &&
      leafIds(tab.paneTree).includes(leafId),
  );
}