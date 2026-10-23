import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { findLeaf, isLeaf, type PaneNode } from "@/modules/terminal/lib/panes";
import {
  envForPath,
  parseWorkspaceScopeKey,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  freshTerminalTab,
  hydrateTabs,
  isSerializableTab,
  serializeTabs,
} from "./serialize";
import {
  loadLegacyTabState,
  loadTabState,
  saveTabState,
  type TabState,
} from "./tabStorage";

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

type BootParams = {
  ready: boolean;
  allocId: () => number;
  replaceTabs: (tabs: Tab[], activeId: number) => void;
  markBooted: () => void;
  adoptWorkspaceEnv: (env: WorkspaceEnv) => Promise<string | null>;
};

/**
 * Reattach last session's tab list on startup; returns whether a restore has run,
 * which the persistence side uses as a gate.
 *
 * Nothing ever saved means a fresh install: the cold tab created by `useTabs` is the
 * whole content.
 */
export function useTabRestore({
  ready,
  allocId,
  replaceTabs,
  markBooted,
  adoptWorkspaceEnv,
}: BootParams): boolean {
  const [hydrated, setHydrated] = useState(false);
  const done = useRef(false);
  // The restore runs once and must not re-run when the language changes, so the
  // name a preview tab falls back to is read through a ref rather than a dep.
  const previewLabel = useT()("tabs.preview");
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
        const fallbackEnv = parseWorkspaceScopeKey(
          usePreferencesStore.getState().defaultWorkspaceEnv,
        );

        // Prefer the current format; otherwise look for a migratable legacy file.
        const current = await loadTabState();
        const saved = current
          ? { ...current, env: null }
          : await loadLegacyTabState();
        if (!saved) {
          await adoptWorkspaceEnv(fallbackEnv);
          return;
        }

        const envFallback = saved.env ?? fallbackEnv;
        const restored = hydrateTabs(
          saved.tabs,
          allocId,
          previewLabelRef.current,
          envFallback,
        );
        const idx = Math.max(0, Math.trunc(saved.activeTabIndex) || 0);
        const restoredActive = restored[idx] ?? restored[0] ?? null;
        // The env follows the tabs: stored tabs may sit in a different env.
        const env =
          (restoredActive && tabEnvironment(restoredActive, envFallback)) ||
          envFallback;
        const restoredHome = await adoptWorkspaceEnv(env);

        // The tab list must not be empty; an empty list renders nothing at all. The
        // cwd is this env's home, or empty when the env cannot be resolved, letting
        // the backend decide (desktop locally, `$HOME` in WSL).
        if (restored.length === 0) {
          restored.push(freshTerminalTab(restoredHome, allocId));
        }

        // Restored terminals each live in their own env, so authorize the cwds up
        // front to avoid an unauthorized error the moment one opens.
        await Promise.allSettled(
          uniqueCwds(restored).map((cwd) =>
            native.workspaceAuthorize(cwd, envForPath(cwd, env)),
          ),
        );

        const activeTab = restored[idx] ?? restored[0];
        replaceTabs(restored, activeTab.id);
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
  /** Persistence is off until the restore finishes, otherwise it overwrites the old
   * content before it has been read back. */
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
