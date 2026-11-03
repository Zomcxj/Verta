import { useEffect, useRef } from "react";
import type { Tab } from "@/modules/tabs";
import { leafIds, leafScreenTail, ptyIdForLeaf } from "@/modules/terminal";
import { applySignal, useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import {
  emptyJudgeEntry,
  type JudgeEntry,
  judgeTail,
} from "@/modules/terminal/lib/agentJudge";
import {
  collectSessionClaims,
  sessionsRunningNow,
} from "@/modules/terminal/lib/sessionServicePhase";
import { runningAgentSessionIds } from "@/modules/launcher";

/**
 * Half a second: fast enough that a state dot follows the agent to within a blink,
 * slow enough that reading a few dozen screen rows costs nothing. Nothing in a tick
 * crosses the IPC boundary, so the cadence is the terminal model's, not the
 * backend's.
 */
const TICK_MS = 500;

/**
 * Two seconds between asks of the opencode service. A turn opening or closing is not news the way a
 * footer repaint is - it is the coarse "is anything running" question - and every ask is an HTTP
 * request, so this is slower than the screen's tick on purpose.
 */
const SERVICE_TICK_MS = 2000;

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
  // The ptys each tab is showing, and the session it resumed. The service answers about sessions
  // and the store is keyed by pty, so this is the only place the two can be joined.
  const claimsRef = useRef<
    { kind: string; sessionId?: string; ptys: readonly number[] }[]
  >([]);
  claimsRef.current = tabs
    .filter((tab) => tab.kind === "terminal")
    .map((tab) => ({
      kind: tab.kind,
      sessionId: tab.sessionId,
      ptys: leafIds(tab.paneTree)
        .map((leafId) => ptyIdForLeaf(leafId))
        .filter((ptyId): ptyId is number => ptyId !== null),
    }));

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
        // Only an *ending* is cleared by looking: a turn that finished while the user was
        // elsewhere becomes news they have now seen. A question is not - it is still waiting for an
        // answer, and the phase leaving `attention` is what clears that latch (see `applySignal`).
        if (store.foregroundLeaves.has(leafId)) {
          store.markDoneSeen([ptyId]);
        }
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

  /**
   * The session a tab resumed, asked of the service that runs it.
   *
   * The screen judge reads a footer and guesses; the service knows, and for a session opened from
   * the list it is worth asking. Only the positive answer is used (see `sessionsRunningNow`), so a
   * service that is slow, between turns or not there at all cannot make a working session look
   * idle - the worst it can do is fail to add a mark the screen was already adding.
   *
   * Asked on its own slower cadence: the answer moves when a turn opens or closes, and each ask is
   * one HTTP request to the service's loopback interface. A tick that outlives the interval is
   * skipped rather than queued, so a stopping service cannot pile requests up.
   */
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const ask = async () => {
      if (inFlight) return;
      const claims = collectSessionClaims(claimsRef.current);
      if (claims.length === 0) return;
      inFlight = true;
      try {
        const ids = await runningAgentSessionIds(null);
        if (stopped) return;
        const running = ids === null ? null : new Set(ids);
        for (const { ptyId } of sessionsRunningNow(claims, running)) {
          // `working` is the store's own word for work in flight. The agent's name is left to the
          // screen judge, which is the one that sees the agent's chrome.
          applySignal({ id: ptyId, kind: "working" });
        }
      } finally {
        inFlight = false;
      }
    };
    void ask();
    const timer = window.setInterval(() => void ask(), SERVICE_TICK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
}