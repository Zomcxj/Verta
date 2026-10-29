import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { parseWorkspaceScopeKey, type WorkspaceEnv } from "@/modules/workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import { isSerializableTab, serializeTabs } from "./serialize";
import { saveTabState, type TabState } from "./tabStorage";

type BootParams = {
  ready: boolean;
  markBooted: () => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
};

/**
 * Start this launch's workspace: load the preferences, then adopt the default environment.
 *
 * Nothing of the last session comes back. The cold tab `useTabs` created is the whole content, and it
 * has no cwd of its own, so the backend lands it where that environment starts a terminal - the
 * desktop on Windows, the distro's own home under WSL. That is the request: one window, in a place
 * that does not depend on where the last one happened to be.
 *
 * Returns whether boot has finished, which the persistence side uses as a gate.
 */
export function useTabRestore({
  ready,
  markBooted,
  adoptWorkspaceEnv,
}: BootParams): boolean {
  const [hydrated, setHydrated] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        // Preferences must load on every start: UI language and window behavior
        // matter just as much when nothing is restored. This is the app's only
        // `init()` call site; do not move it, or returning users stay on defaults.
        await usePreferencesStore
          .getState()
          .init()
          .catch(() => {});
        const fallbackEnv = parseWorkspaceScopeKey(
          usePreferencesStore.getState().defaultWorkspaceEnv,
        );

        // Where this launch starts: the default environment and its own home. The cold tab `useTabs`
        // created is the whole content, and it has no cwd of its own, so the backend lands it there -
        // the desktop on Windows, the distro's home under WSL.
        await adoptWorkspaceEnv(fallbackEnv);
      } catch (e) {
        console.error("[verta] workspace boot failed:", e);
      } finally {
        setHydrated(true);
        markBooted();
      }
    })();
  }, [ready, markBooted, adoptWorkspaceEnv]);

  return hydrated;
}

const DEBOUNCE_MS = 3000;

type PersistParams = {
  tabs: Tab[];
  activeId: number;
  /** Persistence is off until boot finishes, so a write cannot land while the workspace is still
   * being resolved. */
  enabled: boolean;
};

type Snapshot = { tabs: Tab[]; activeId: number };

/**
 * Write the tab list back to disk. Debounced by three seconds, with an immediate
 * flush on window blur / hide / close so nothing is lost when the process is
 * reaped.
 */
export function useTabPersistence({ tabs, activeId, enabled }: PersistParams) {
  const last = useRef<{ json: string; activeTabIndex: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Snapshot>({ tabs, activeId });
  latest.current = { tabs, activeId };

  const flush = useCallback((snap: Snapshot) => {
    const serialized = serializeTabs(snap.tabs);
    const idx = snap.tabs
      .filter(isSerializableTab)
      .findIndex((t) => t.id === snap.activeId);
    // When the active tab itself is not persisted (a private terminal, say), keep the
    // previously recorded index instead of resetting it to zero.
    const activeTabIndex = idx >= 0 ? idx : (last.current?.activeTabIndex ?? 0);
    const json = JSON.stringify(serialized);
    if (
      last.current &&
      last.current.json === json &&
      last.current.activeTabIndex === activeTabIndex
    ) {
      return;
    }
    last.current = { json, activeTabIndex };
    const state: TabState = { tabs: serialized, activeTabIndex };
    void saveTabState(state);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const snap: Snapshot = { tabs, activeId };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      flush(snap);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [tabs, activeId, enabled, flush]);

  useEffect(() => {
    if (!enabled) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush(latest.current);
    };
    const onLeave = () => flush(latest.current);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      flush(latest.current);
    };
  }, [enabled, flush]);
}
