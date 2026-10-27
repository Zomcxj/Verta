import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
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
  /**
   * What is painted on the icon right now, and what was already waiting the last time the window
   * was being looked at.
   *
   * Both have to outlive the effect, because the effect re-runs whenever the window is looked at
   * or looked away from, and a value kept inside it starts from scratch each time. Measured on the
   * installed build: the dot stayed green for as long as the app was open - coming back to the
   * window recomputed `null` and compared it against a freshly reset `null`, so the call that
   * would have taken the dot off was never made, and the Rust side went on painting the last
   * colour it had been given.
   */
  const shownRef = useRef<TrayDot | null>(null);
  const knownRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const set = (dot: TrayDot | null) => {
      shownRef.current = dot;
      void invoke("tray_set_dot", { dot }).catch((error: unknown) => {
        // A dot that did not get drawn is not worth breaking anything over.
        console.error("[verta] tray dot failed:", error);
      });
    };
    if (!enabled) {
      if (shownRef.current !== null) set(null);
      return;
    }
    const apply = (state: {
      unseen: Record<number, number>;
      unseenDone: Record<number, number>;
    }) => {
      let dot: TrayDot | null = null;
      if (windowInactive) {
        dot = trayDotFor(state, knownRef.current);
      } else {
        knownRef.current = latchedKeys(state);
      }
      if (dot === shownRef.current) return;
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
 *
 * `known` is what was already waiting when the window last went out of the way; a session in both
 * is not news, and only a question outranks an ending.
 */
export function trayDotFor(
  state: {
    unseen: Record<number, number>;
    unseenDone: Record<number, number>;
  },
  known: ReadonlySet<number> = new Set(),
): TrayDot | null {
  const fresh = (latched: Record<number, number>) =>
    Object.keys(latched).some((key) => !known.has(Number(key)));
  if (fresh(state.unseen)) return "asking";
  if (fresh(state.unseenDone)) return "finished";
  return null;
}

/** The sessions with something waiting on the user's attention, from either latch. */
function latchedKeys(state: {
  unseen: Record<number, number>;
  unseenDone: Record<number, number>;
}): Set<number> {
  const keys = new Set<number>();
  for (const key of [...Object.keys(state.unseen), ...Object.keys(state.unseenDone)]) {
    keys.add(Number(key));
  }
  return keys;
}