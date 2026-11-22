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

/**
 * Whether the leaf the layer was opened for still exists anywhere in the window.
 *
 * This is the other half of `sessionOpeningVisible`, and the two are not the same question.
 * Switching to another tab makes the layer invisible - it belongs to one tab and must not hang over
 * someone else's terminal - but it must not end it: the session is still starting, and coming back
 * has to show the same transition rather than the launch command the transition exists to hide.
 * Only closing the tab (or the pane) ends it, because then there is no pane left to cover.
 */
export function sessionOpeningAlive(
  tabs: Tab[],
  leafId: number | null,
): boolean {
  if (leafId === null) return false;
  return tabs.some(
    (tab) => tab.kind === "terminal" && leafIds(tab.paneTree).includes(leafId),
  );
}
/**
 * One session that is starting, and which agent it is starting.
 *
 * The list holds every start, not just the newest, because sessions are opened one after another and
 * each one covers its own pane until its own UI is painted. Holding a single entry meant the newest
 * start replaced the older ones: the older panes were uncovered while their sessions were still
 * starting, and their screens already held the resume command - reported as "连续点击多个会话，只有
 * 最后一个切标签切回加载动画还在，其它的都变成了终端指令".
 */
export type SessionOpeningStart = {
  readonly leafId: number;
  readonly tool: string | null;
  /**
   * The start's own token, which is what `hideSessionOpening` needs.
   *
   * It travels with the entry rather than in a single "current token" ref: several starts can be
   * pending at once, and a tab closing has to lift its own cover without touching the others.
   */
  readonly token: number;
};

/** The same list with this start added; a leaf that is already there keeps its place. */
export function addSessionOpening(
  starts: readonly SessionOpeningStart[],
  leafId: number,
  tool: string | null,
  token: number,
): readonly SessionOpeningStart[] {
  if (starts.some((start) => start.leafId === leafId)) return starts;
  return [...starts, { leafId, tool, token }];
}

/** The same list without this start. Unknown leaves are ignored. */
export function dropSessionOpening(
  starts: readonly SessionOpeningStart[],
  leafId: number,
): readonly SessionOpeningStart[] {
  const next = starts.filter((start) => start.leafId !== leafId);
  return next.length === starts.length ? starts : next;
}

/** The start for a leaf, or `null` when that session is not starting. */
export function sessionOpeningFor(
  starts: readonly SessionOpeningStart[],
  leafId: number | null,
): SessionOpeningStart | null {
  if (leafId === null) return null;
  return starts.find((start) => start.leafId === leafId) ?? null;
}

/**
 * Which start the layer should be drawn for, given the tab on screen.
 *
 * There is one layer, because there is one tab on screen; this picks the start that belongs to it.
 */
export function sessionOpeningOnScreen(
  starts: readonly SessionOpeningStart[],
  tabs: Tab[],
  activeId: number,
): SessionOpeningStart | null {
  const active = tabs.find(
    (tab): tab is Tab & { kind: "terminal" } =>
      tab.id === activeId && tab.kind === "terminal",
  );
  if (active === undefined) return null;
  const leaves = leafIds(active.paneTree);
  return starts.find((start) => leaves.includes(start.leafId)) ?? null;
}
