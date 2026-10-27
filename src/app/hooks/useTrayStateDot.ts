import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { useAgentActivityStore } from "@/modules/terminal/lib/agentActivity";
import { useWindowInactive } from "@/modules/theme/WindowActivityBridge";

/** What the tray icon's corner says, or nothing at all. */
export type TrayDot = "asking" | "finished";

/**
 * The dot on the tray icon, and which of the two colours it carries.
 *
 * The tray is what keeps this app reachable while its window is out of the way, so the dot is the
 * one signal that works then, and it is read from the two latches rather than from the phases: a
 * question nobody has looked at, and a turn that ended while nobody was there. Both are cleared by
 * looking - which is what clicking the tray does - so the icon goes quiet the moment the window is
 * in front again, and it says nothing at all the rest of the time: an agent that has just been
 * opened, or one that has been sitting at its prompt, or one whose turn is in flight, is not news
 * about the user.
 *
 * A question outranks an ending, because only one of the two is waiting for an answer.
 *
 * Rust paints it; this only says when the answer changes, because a repaint on every store write
 * would be a repaint on every judge tick. Turning the switch off takes the dot with it.
 */
export function useTrayStateDot({ enabled }: { enabled: boolean }): void {
  const windowInactive = useWindowInactive();
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
      unseen: Record<number, number>;
      unseenDone: Record<number, number>;
    }) => {
      const dot = windowInactive ? trayDotFor(state) : null;
      if (dot === shown) return;
      shown = dot;
      set(dot);
    };
    apply(useAgentActivityStore.getState());
    return useAgentActivityStore.subscribe((state) => apply(state));
  }, [enabled, windowInactive]);
}

/**
 * What the icon should say, from the two latches alone.
 *
 * Both of them mean "there is something here you have not looked at", which is the whole of what
 * an icon can usefully say while the window is behind something else: `unseen` is a session that
 * asked for something, `unseenDone` is a turn that ended. Nothing else is read - not `working`,
 * not `idle` - because an agent that is merely open or merely busy has nothing to tell the user.
 */
export function trayDotFor(state: {
  unseen: Record<number, number>;
  unseenDone: Record<number, number>;
}): TrayDot | null {
  if (Object.keys(state.unseen).length > 0) return "asking";
  if (Object.keys(state.unseenDone).length > 0) return "finished";
  return null;
}