import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import {
  type AgentPhase,
  flashForPhaseChange,
  useAgentActivityStore,
} from "@/modules/terminal/lib/agentActivity";
import { getWindowHidden } from "@/modules/theme/windowActivity";

async function flash(attention: "ask" | "done"): Promise<void> {
  try {
    await invoke("window_flash_taskbar", { attention });
  } catch (error) {
    // The window is still usable without a flashing button; never break on this.
    console.error("[verta] taskbar flash failed:", error);
  }
}

/**
 * Flashes the taskbar button when an agent wants the user.
 *
 * The signal is the activity store, whose phases the judge reads off each agent's own
 * screen: `finished` is what it reports when an agent that was working has stopped, and
 * `attention` is a question the agent is waiting on. Nothing here is inferred from
 * silence any more, because the two things that inference used could not tell those two
 * apart:
 *
 * - whether the shell still had a child process - measured to answer "nothing is running"
 *   while an agent this app launched was running (Windows records a process's parent when
 *   the process is created, and the launcher that starts an agent exits immediately);
 * - whether output had stopped moving - a turn waiting on a slow tool is quiet for
 *   minutes without waiting on the user.
 *
 * So the flash used to fire for a long build and stay silent for a question. Watching the
 * store also means there is no polling left: it changes when the screen does, twice a
 * second at most, and each change is a phase that can be compared with the last one seen.
 */
export function useAgentAttentionFlash({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) return;
    /** The last phase seen for each pty, so a flash is a change and not a standing state. */
    const seen = new Map<number, AgentPhase | undefined>();
    /** The wait already flashed for each pty, which is what tells one wait from the next. */
    const announced = new Map<number, number | undefined>();

    const react = (announce: boolean) => {
      const state = useAgentActivityStore.getState();
      // The same question the notifications ask, and for the same reason: a flashing taskbar button
      // is visible whether or not the window is in front of the user, so while the window can be
      // seen its own dots and its bell are the surface and a flash on top of them is noise. Read,
      // not subscribed to, for the reason the notification hook gives: this effect's memory of what
      // has been announced lives in these maps and would not survive a re-subscribe.
      const windowSeen = !getWindowHidden();
      for (const key of Object.keys(state.agents)) {
        const ptyId = Number(key);
        const phase = state.phases[ptyId];
        const previous = seen.get(ptyId);
        seen.set(ptyId, phase);
        if (!announce || windowSeen) continue;
        const sinceMs = state.unseen[ptyId];
        const flashable = flashForPhaseChange(previous, phase, sinceMs);
        if (!flashable) continue;
        // One flash per wait: the latch stays set for as long as the agent is blocked, and
        // the moment it started is what makes this wait this one rather than the next.
        if (flashable === "ask") {
          if (sinceMs === announced.get(ptyId)) continue;
          announced.set(ptyId, sinceMs);
        }
        void flash(flashable);
      }
      // A pty that is gone cannot flash again: forget what was remembered about it.
      for (const ptyId of [...seen.keys()]) {
        if (!(ptyId in state.agents)) {
          seen.delete(ptyId);
          announced.delete(ptyId);
        }
      }
    };

    // The first read only fills in what is already true. An agent that was already
    // waiting when the taskbar watching started is not news.
    react(false);
    return useAgentActivityStore.subscribe(() => react(true));
  }, [enabled]);
}