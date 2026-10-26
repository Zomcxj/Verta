import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import {
  countUnseenAttention,
  useAgentActivityStore,
} from "@/modules/terminal/lib/agentActivity";

/**
 * The waiting dot on the tray icon.
 *
 * The tray is what keeps this app reachable while its window is hidden, so the dot is the one
 * signal that works when nothing else can be seen: it stands for the same latch the bell's
 * list is built from - a session waiting on the user that the user has not looked at - so the
 * icon and the list can never disagree about whether anything is waiting.
 *
 * Rust paints it; this only says when the answer changes, because a repaint on every store
 * write would be a repaint on every judge tick. Turning the switch off takes the dot with it,
 * and so does looking at the wait.
 */
export function useTrayAttentionDot({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    const set = (on: boolean) => {
      void invoke("tray_set_attention", { on }).catch((error: unknown) => {
        // A dot that did not get drawn is not worth breaking anything over.
        console.error("[verta] tray dot failed:", error);
      });
    };
    if (!enabled) {
      set(false);
      return;
    }
    // The icon starts without a dot, so an empty answer needs no call at all.
    let shown = false;
    const apply = (unseen: Record<number, number>) => {
      const on = countUnseenAttention(unseen) > 0;
      if (on === shown) return;
      shown = on;
      set(on);
    };
    apply(useAgentActivityStore.getState().unseen);
    return useAgentActivityStore.subscribe((state) => apply(state.unseen));
  }, [enabled]);
}
