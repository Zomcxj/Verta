import { useEffect, useRef } from "react";
import type { Tab } from "@/modules/tabs";
import { leafIds, leafScreenTail, ptyIdForLeaf } from "@/modules/terminal";
import { applySignal, useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import {
  emptyJudgeEntry,
  type JudgeEntry,
  judgeTail,
} from "@/modules/terminal/lib/agentJudge";

/**
 * Half a second: fast enough that a state dot follows the agent to within a blink,
 * slow enough that reading a few dozen screen rows costs nothing. Nothing in a tick
 * crosses the IPC boundary, so the cadence is the terminal model's, not the
 * backend's.
 */
const TICK_MS = 500;

/**
 * Reads each terminal's screen and keeps the agent activity store in step with it.
 *
 * This is the source of the store's phases: the native `verta:agent-signal` event
 * carries the same signal shape but nothing emits it, and the silence heuristic in
 * `useAgentAttentionFlash` only drives the taskbar button. The judge is what makes
 * the tab dots and the notification layers (plan two) report what is really on
 * screen: working, blocked on the user, or idle.
 *
 * Every terminal tab is watched, not only the ones opened for an agent: an agent
 * started by typing `opencode` into a plain shell is exactly the case the tail
 * judge is for, and it does not need the tab to have declared itself first.
 */
export function useAgentStateJudge({ tabs }: { tabs: readonly Tab[] }): void {
  // Read on every tick, so opening or closing a tab never re-creates the interval.
  const leavesRef = useRef<number[]>([]);
  leavesRef.current = tabs.flatMap((tab) =>
    tab.kind === "terminal" ? leafIds(tab.paneTree) : [],
  );

  useEffect(() => {
    const entries = new Map<number, JudgeEntry>();
    let stopped = false;

    const tick = () => {
      const leaves = leavesRef.current;
      const store = useAgentActivityStore.getState();
      for (const leafId of [...entries.keys()]) {
        if (!leaves.includes(leafId)) {
          entries.delete(leafId);
          store.clearLeafPty(leafId);
        }
      }
      const now = Date.now();
      for (const leafId of leaves) {
        if (stopped) return;
        // The store is keyed by pty, because that is what a signal names and what
        // the tab's icons are derived from. The leaf -> pty mirror is kept for the
        // tab strip, which has to see a dot appear without a render of its own.
        const ptyId = ptyIdForLeaf(leafId);
        if (ptyId === null) continue;
        store.setLeafPty(leafId, ptyId);
        const tail = leafScreenTail(leafId);
        if (tail === null) continue;
        const current = entries.get(leafId);
        const entry =
          current && current.id === ptyId ? current : emptyJudgeEntry(ptyId);
        // No `await` anywhere above: one screen read per leaf, in this process.
        const outcome = judgeTail(entry, tail, now);
        entries.set(leafId, outcome.entry);
        if (outcome.kind === "report") {
          for (const signal of outcome.signals) applySignal(signal);
        }
      }
    };

    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
}