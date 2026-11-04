import { native } from "@/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { findLeaf, isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import {
  envForPath,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  hydrateTabs,
  isSerializableTab,
  serializeTabs,
} from "./serialize";
import { loadTabState, saveTabState, type TabState } from "./tabStorage";

type BootParams = {
  ready: boolean;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
  /** The label a preview tab falls back to when its url has no host. Read once:
   * the restore runs once and must not re-run when the language changes. */
  previewLabel: string;
};

/**
 * Which env a restored tab lives in: trust the env stored on the leaf, and infer it
 * from the path when only a cwd was saved.
 *
 * A saved cwd may belong to another env (it was WSL before, while the preference is
 * local now). Without inferring, the terminal starts locally with a Linux path and
 * Rust can only fall back to the home directory as "unusable".
 */
export function tabEnvironment(
  tab: Tab,
  fallback: WorkspaceEnv,
): WorkspaceEnv | null {
  if (tab.kind !== "terminal") return null;
  const leaf = findLeaf(tab.paneTree, tab.activeLeafId);
  if (!leaf) return null;
  if (leaf.workspace) return leaf.workspace;
  return leaf.cwd ? envForPath(leaf.cwd, fallback) : null;
}

function uniqueCwds(tabs: Tab[]): string[] {
  const set = new Set<string>();
  const walk = (n: PaneNode) => {
    if (isLeaf(n)) {
      if (n.cwd) set.add(n.cwd);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const t of tabs) if (t.kind === "terminal") walk(t.paneTree);
  return [...set];
}

/**
 * Boot: load the preferences, then either bring back the tab list the last window
 * left behind (`restoreTabsOnLaunch` on and something saved) or start in the default
 * environment with the cold tab `useTabs` created.
 *
 * Restored tabs come back `cold`; activating one warms it, and a session tab marked
 * `pendingResume` runs its resume command at that moment (App owns that sequence).
 *
 * Returns whether boot has finished, which the persistence side uses as a gate.
 */
export function useTabRestore({
  ready,
  allocId,
  replaceTabs,
  markBooted,
  adoptWorkspaceEnv,
  previewLabel,
}: BootParams): boolean {
  const [hydrated, setHydrated] = useState(false);
  const done = useRef(false);
  const previewLabelRef = useRef(previewLabel);
  previewLabelRef.current = previewLabel;

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      try {
        // Preferences must load on every start: UI language and window behavior
        // matter just as much when a tab list is restored. This is the app's only
        // `init()` call site; do not move it, or returning users stay on defaults.
        await usePreferencesStore
          .getState()
          .init()
          .catch(() => {});
        const fallbackEnv = LOCAL_WORKSPACE;

        const restoreOn =
          usePreferencesStore.getState().restoreTabsOnLaunch;
        const saved = restoreOn ? await loadTabState() : null;

        if (saved) {
          const restored = hydrateTabs(
            saved.tabs,
            allocId,
            previewLabelRef.current,
            fallbackEnv,
          );
          if (restored.length > 0) {
            const idx = Math.max(0, Math.trunc(saved.activeTabIndex) || 0);
            // The env follows the tabs: the last window may have been working in
            // another environment than the default one.
            const activeTab = restored[idx] ?? restored[0];
            const env =
              tabEnvironment(activeTab, fallbackEnv) || fallbackEnv;
            await adoptWorkspaceEnv(env);

            // Restored terminals each live in their own env, so authorize the cwds up
            // front to avoid an unauthorized error the moment one opens.
            await Promise.allSettled(
              uniqueCwds(restored).map((cwd) =>
                native.workspaceAuthorize(cwd, envForPath(cwd, env)),
              ),
            );
            // A restored notes tab is not granted here: its view resolves the folder
            // through `notes_dir` (which authorizes) the first time the tab is shown,
            // and the tab carries the folder it had so the view can tell a move.

            replaceTabs(restored, activeTab.id);
            return;
          }
        }

        // Nothing saved (or nothing restorable): the cold tab is the whole content,
        // and the backend lands it where the default environment starts a terminal -
        // the desktop on Windows, the distro's home under WSL.
        await adoptWorkspaceEnv(fallbackEnv);
      } catch (e) {
        console.error("[verta] tab restore failed:", e);
      } finally {
        setHydrated(true);
        markBooted();
      }
    })();
  }, [ready, allocId, replaceTabs, markBooted, adoptWorkspaceEnv]);

  return hydrated;
}

const DEBOUNCE_MS = 3000;

type PersistParams = {
  tabs: Tab[];
  activeId: number;
  /** Persistence is off until boot finishes, so a write cannot land while the workspace is still
   * being resolved, and cannot overwrite the saved list before it has been read back. */
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
