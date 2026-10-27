import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { useEffect, useRef } from "react";
import { useT } from "@/modules/i18n";
import {
  sessionExcerpt,
  tabForPty,
} from "@/modules/notifications/lib/attentions";
import { noticeForPhaseChange } from "@/modules/notifications/lib/notificationRule";
import { tappedPty } from "@/modules/notifications/lib/notificationTap";
import {
  type AgentPhase,
  isForegroundPty,
  useAgentActivityStore,
} from "@/modules/terminal/lib/agentActivity";
import { leafScreenTail } from "@/modules/terminal/lib/terminalSessionApi";
import { labelFor, type Tab } from "@/modules/tabs";

/**
 * Telling the user about an agent when the window is out of the way.
 *
 * The phases arrive from the store, which the judge keeps in step with what each agent's own
 * screen shows, and they keep arriving while the window is hidden in the tray (measured: the
 * renderer keeps its cadence there), so nothing here needs a timer of its own. Which changes
 * are worth a notification is the rule in `notificationRule`, and the latch behind it is the
 * one the bell's list reads, so a toast and that list never disagree about what is waiting.
 *
 * Two platform facts shape this. The click has to be listened for *before* anything is sent,
 * because the plugin only routes a click when a listener exists at the time the notification
 * is made. And a notification is sent with the session's pty in it, so the click can find the
 * tab the session is drawn in now rather than where it was when the news was made.
 */
export function useAgentNotifications({
  enabled,
  tabs,
  onJump,
}: {
  enabled: boolean;
  tabs: readonly Tab[];
  onJump: (tabId: number) => void;
}): void {
  const t = useT();
  // Read on every change rather than captured: a closed or reordered tab must not make the
  // click go somewhere else, and the effect below must not be torn down for it.
  const tabsRef = useRef<readonly Tab[]>(tabs);
  tabsRef.current = tabs;
  const onJumpRef = useRef(onJump);
  onJumpRef.current = onJump;
  const tRef = useRef(t);
  tRef.current = t;

  // The click: bring the window back, then go to the session. Everything is caught - a
  // notification is a courtesy, and nothing about it may break the app.
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onAction((action) => {
      // The payload is what the plugin stored with the notification: the session it is about,
      // which is all a click needs, since `tabForPty` finds the tab it is drawn in from it.
      const ptyId = tappedPty(action);
      if (ptyId === null) return;
      void invoke("tray_focus_main").catch((error: unknown) => {
        console.error("[verta] raising the window for a notification failed:", error);
      });
      const where = tabForPty(
        tabsRef.current,
        useAgentActivityStore.getState().leafPty,
        ptyId,
      );
      if (where) onJumpRef.current(where.tabId);
    })
      .then((listener) => {
        if (disposed) void listener.unregister();
        else unlisten = () => void listener.unregister();
      })
      .catch((error: unknown) => {
        console.error("[verta] listening for notification clicks failed:", error);
      });
    // Windows grants this to a desktop app; asking is here so a refusal is a log line in
    // the one place that knows, rather than a notification that silently never appears.
    void isPermissionGranted()
      .then((granted) => (granted ? true : requestPermission().then((p) => p === "granted")))
      .then((granted) => {
        if (!granted) console.warn("[verta] desktop notifications are not permitted");
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    /** The last phase seen for each pty, so a notification is a change and not a standing state. */
    const seen = new Map<number, AgentPhase | undefined>();
    /** The wait already announced for each pty, by the moment it started. */
    const announced = new Map<number, number | undefined>();

    const send = (
      verdict: "waiting" | "done",
      ptyId: number,
      title: string,
      body: string,
    ) => {
      try {
        // Returns nothing; a platform that cannot show it says so by throwing.
        sendNotification({ title, body, extra: { ptyId, verdict } });
      } catch (error) {
        // The window is still usable without a notification; never break on this.
        console.error("[verta] desktop notification failed:", error);
      }
    };

    const react = (announce: boolean) => {
      const state = useAgentActivityStore.getState();
      for (const key of Object.keys(state.agents)) {
        const ptyId = Number(key);
        const phase = state.phases[ptyId];
        const previous = seen.get(ptyId);
        seen.set(ptyId, phase);
        if (!announce) continue;
        const sinceMs = state.unseen[ptyId];
        const verdict = noticeForPhaseChange(previous, phase, {
          sinceMs,
          announcedSinceMs: announced.get(ptyId),
          foreground: isForegroundPty(state.leafPty, state.foregroundLeaves, ptyId),
        });
        if (!verdict) continue;
        const where = tabForPty(tabsRef.current, state.leafPty, ptyId);
        const tab = where
          ? tabsRef.current.find((candidate) => candidate.id === where.tabId)
          : undefined;
        if (!where || !tab) continue;
        const title = labelFor(tab);
        if (verdict === "waiting") {
          announced.set(ptyId, sinceMs);
          send(
            "waiting",
            ptyId,
            tRef.current("notifications.toast.waiting.title", { title }),
            sessionExcerpt(
              // Every leaf of that session, the one it is drawn in first: a leaf whose own
              // session is gone is left in the mirror, and reading only that one reads nothing.
              [
                where.leafId,
                ...Object.keys(state.leafPty)
                  .map(Number)
                  .filter(
                    (leafId) =>
                      leafId !== where.leafId &&
                      state.leafPty[leafId] === ptyId,
                  ),
              ],
              leafScreenTail,
            ),
          );
        } else {
          send(
            "done",
            ptyId,
            tRef.current("notifications.toast.done.title", { title }),
            tRef.current("notifications.toast.done.body"),
          );
        }
      }
      // A pty that is gone cannot be waiting on anyone: forget what was remembered about it.
      for (const ptyId of [...seen.keys()]) {
        if (!(ptyId in state.agents)) {
          seen.delete(ptyId);
          announced.delete(ptyId);
        }
      }
    };

    // The first read only fills in what is already true: a question that was on screen
    // before this started watching is not news.
    react(false);
    return useAgentActivityStore.subscribe(() => react(true));
  }, [enabled]);
}