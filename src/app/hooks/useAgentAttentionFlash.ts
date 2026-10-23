import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds, leafOutputBytes } from "@/modules/terminal";
import {
  advanceAgentWatch,
  EMPTY_AGENT_WATCH,
  type AgentWatch,
} from "@/modules/terminal/lib/agentAttention";

/** One second: fast enough that the flash follows the agent, slow enough that
 *  the per-leaf process query stays off the radar. */
const TICK_MS = 1000;

async function flash(attention: "ask" | "done"): Promise<void> {
  try {
    await invoke("window_flash_taskbar", { attention });
  } catch (error) {
    // The window is still usable without a flashing button; never break a tick.
    console.error("[verta] taskbar flash failed:", error);
  }
}

/**
 * Flashes the taskbar button when an agent needs the user.
 *
 * Only tabs that were opened for an agent are watched (`tab.agent`), because the
 * signal is inferred from silence and a plain shell goes silent all the time.
 * Nothing here runs when the preference is off.
 */
export function useAgentAttentionFlash({
  tabs,
  enabled,
}: {
  tabs: readonly Tab[];
  enabled: boolean;
}): void {
  // The interval reads this on every tick, so it never needs re-creating when a
  // tab opens or closes.
  const leavesRef = useRef<number[]>([]);
  leavesRef.current = enabled
    ? tabs.flatMap((tab) =>
        tab.kind === "terminal" && tab.agent ? leafIds(tab.paneTree) : [],
      )
    : [];

  useEffect(() => {
    if (!enabled) return;
    const watches = new Map<number, AgentWatch>();
    let stopped = false;

    const sampleLeaf = async (leafId: number, now: number) => {
      let hasChild: boolean;
      let bytes: number;
      try {
        hasChild = await leafHasForegroundProcess(leafId);
        bytes = leafOutputBytes(leafId);
      } catch {
        // The leaf is gone; drop it so a stale "done" cannot be reported later.
        watches.delete(leafId);
        return;
      }
      if (stopped) return;
      const next = advanceAgentWatch(watches.get(leafId) ?? EMPTY_AGENT_WATCH, { bytes, hasChild }, now);
      watches.set(leafId, next.watch);
      if (next.attention) await flash(next.attention);
    };

    const tick = async () => {
      const leaves = leavesRef.current;
      for (const leafId of [...watches.keys()]) {
        if (!leaves.includes(leafId)) watches.delete(leafId);
      }
      const now = Date.now();
      for (const leafId of leaves) {
        if (stopped) return;
        await sampleLeaf(leafId, now);
      }
    };

    const timer = window.setInterval(() => void tick(), TICK_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
}
