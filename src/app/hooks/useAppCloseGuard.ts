import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { isLeafAgentBusy } from "@/modules/terminal/lib/agentActivity";

async function anyTerminalBusy(tabs: Tab[]): Promise<boolean> {
  const leaves = tabs.flatMap((t) =>
    t.kind === "terminal" ? leafIds(t.paneTree) : [],
  );
  if (leaves.length === 0) return false;
  // The screen is asked first: it is free, and it is the only thing that can see an agent
  // this app launched, because the process query cannot (measured). Nothing is asked of
  // the kernel when the screen already says busy.
  if (leaves.some(isLeafAgentBusy)) return true;
  const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
  return checks.some(Boolean);
}

export type AppCloseBlocker = {
  dirtyEditors: number;
  busyTerminal: boolean;
};

/**
 * The opt-out only covers running processes, so it stays hidden whenever the
 * same prompt is also the last warning before discarding unsaved buffers.
 */
export function canOptOutOfAppClosePrompt(blocker: AppCloseBlocker): boolean {
  return blocker.busyTerminal && blocker.dirtyEditors === 0;
}

export function useAppCloseGuard(tabsRef: RefObject<Tab[]>) {
  const [pendingAppClose, setPendingAppClose] =
    useState<AppCloseBlocker | null>(null);
  const t = useT();
  const closing = useRef(false);

  const quitApp = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      await invoke("app_quit");
    } catch (error) {
      toast.error(t("app.closeWindowFailed"), {
        description: String(error),
      });
    } finally {
      closing.current = false;
    }
  }, [t]);

  const requestAppQuit = useCallback(async () => {
    // Opting out skips the per-leaf IPC entirely; it never relaxes the
    // unsaved-changes guard below.
    const busyTerminal =
      usePreferencesStore.getState().confirmCloseRunningTerminal &&
      (await anyTerminalBusy(tabsRef.current));
    // Count after the await so edits made during the IPC check are seen.
    const dirtyEditors = tabsRef.current.filter(
      (tab) => tab.kind === "editor" && tab.dirty,
    ).length;
    if (dirtyEditors > 0 || busyTerminal) {
      setPendingAppClose({ dirtyEditors, busyTerminal });
    } else {
      await quitApp();
    }
  }, [tabsRef, quitApp]);

  const confirmAppClose = useCallback(() => {
    setPendingAppClose(null);
    void quitApp();
  }, [quitApp]);

  // Merely registering this listener makes Tauri withhold the close, and the JS side
  // then destroys the window itself unless the handler stops it. So the close is
  // always stopped here and both outcomes are driven from this code: with close-to-tray
  // on, Rust has already hidden the window and nothing else may happen (the tray is the
  // way back); with it off, the guard below asks about unsaved work before the app
  // leaves. Rust reads the same preference through tray_set_close_to_tray, so the two
  // sides never disagree about which close this is.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        if (usePreferencesStore.getState().closeToTray) return;
        await requestAppQuit();
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [requestAppQuit]);

  const cancelAppClose = useCallback(() => setPendingAppClose(null), []);

  return {
    pendingAppClose,
    confirmAppClose,
    cancelAppClose,
    requestAppQuit,
  };
}
