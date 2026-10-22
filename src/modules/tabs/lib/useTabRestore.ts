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
 * 恢复出来的标签现在在哪个环境：叶子自己记了就用它，只记了 cwd 就从路径反推。
 *
 * 存下来的 cwd 可能属于另一个环境（之前在 WSL 里，现在偏好是本机）。不推的话，终端会带着
 * Linux 路径去本机启动，Rust 只能按「不可用」回退到家目录。
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
 * 启动时把上次的标签列表接回来；返回「是否已经恢复过」，写盘的那一端用它当闸门。
 *
 * 没有 save 过任何东西就是全新安装：`useTabs` 起的那个冷标签就是全部内容。
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
        // 偏好每次启动都要载：界面语言、窗口行为对一个已有标签列表同样重要。
        // 这里是全应用唯一的 `init()` 调用点，别挪到别处，否则返回的用户会停在默认偏好上。
        await usePreferencesStore
          .getState()
          .init()
          .catch(() => {});
        const fallbackEnv = parseWorkspaceScopeKey(
          usePreferencesStore.getState().defaultWorkspaceEnv,
        );

        // 新格式优先；没有就看老文件里有没有可迁移的那一份。
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
        // 环境跟着标签走：存下来的标签可能停在另一个环境里。
        const env =
          (restoredActive && tabEnvironment(restoredActive, envFallback)) ||
          envFallback;
        const restoredHome = await adoptWorkspaceEnv(env);

        // 标签列表不能空着：空列表的界面是一片虚无。cwd 用这个环境的家目录，
        // 环境解析不出来时留空，交给后端定（本机落桌面，WSL 落 `$HOME`）。
        if (restored.length === 0) {
          restored.push(freshTerminalTab(restoredHome, allocId));
        }

        // 恢复出来的终端各自在自己的环境里，cwd 先授权好，免得一开就报未授权。
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
  /** 恢复完成之前不写盘，否则会把还没读回来的旧内容覆盖掉。 */
  enabled: boolean;
};

type Snapshot = { tabs: Tab[]; activeId: number };

/**
 * 把标签列表写回磁盘。三秒防抖，另外在窗口失焦 / 隐藏 / 关闭时立刻补一次，
 * 进程被系统收走也不会丢。
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
    // 活动标签自己不落盘时（私有终端之类），保留上一次记下的位置，别把它归零。
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
