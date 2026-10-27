import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { type AgentPhase, useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";

/** What the tray icon's corner says, or nothing at all. */
export type TrayDot = "asking" | "finished";

/**
 * The dot on the tray icon, and which of the two colours it carries.
 *
 * The tray is what keeps this app reachable while its window is hidden, so the dot is the one
 * signal that works when nothing else can be seen. It is the same fold the window's own dots
 * use, minus "work in flight": a question outranks a turn that has ended, and a session that is
 * only working leaves the icon plain, because that is not news about the user. The two colours
 * are the window's own, so an icon and a tab never describe one session two different ways.
 *
 * A question is read from the live phase rather than from the latch: the latch is cleared the
 * moment the user looks, and this dot is for the times nobody is looking, so the two agree where
 * it matters. A session with no agent on it at all is not counted - a shell sitting at its
 * prompt is not a turn that ended.
 *
 * Rust paints it; this only says when the answer changes, because a repaint on every store write
 * would be a repaint on every judge tick. Turning the switch off takes the dot with it.
 */
export function useTrayStateDot({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    const set = (dot: TrayDot | null) => {
      void invoke("tray_set_dot", { dot }).catch((error: unknown) => {
        // A dot that did not get drawn is not worth breaking anything over.
        console.error("[verta] tray dot failed:", error);
      });
    };
    if (!enabled) {
      set(null);
      return;
    }
    // The icon starts plain, so no dot needs no call at all.
    let shown: TrayDot | null = null;
    const apply = (state: {
      phases: Record<number, AgentPhase | undefined>;
      agents: Record<number, string>;
    }) => {
      let asking = false;
      let finished = false;
      for (const key of Object.keys(state.agents)) {
        const phase = state.phases[Number(key)];
        if (phase === "attention") asking = true;
        // `idle` with an agent on it is a turn that has ended and nothing else: the store's
        // own "at rest", which the window draws as the same green dot.
        else if (phase === "finished" || phase === "idle") finished = true;
      }
      const dot: TrayDot | null = asking
        ? "asking"
        : finished
          ? "finished"
          : null;
      if (dot === shown) return;
      shown = dot;
      set(dot);
    };
    apply(useAgentActivityStore.getState());
    return useAgentActivityStore.subscribe((state) => apply(state));
  }, [enabled]);
}