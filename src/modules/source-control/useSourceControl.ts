import {
  native,
  type GitRepoInfo,
  type GitStatusSnapshot,
} from "@/lib/native";
import { useT } from "@/modules/i18n";
import {
  getRepoSnapshot,
  rememberRepoSnapshot,
  repoSnapshotKey,
} from "@/modules/source-control/repoSnapshots";
import {
  listenFsChanged,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { changeTouchesRepo } from "@/lib/repoPath";
import { useWorkspaceEnvStore, workspaceScopeKey } from "@/modules/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const AUTO_FETCH_THROTTLE_MS = 5 * 60_000;
const AUTO_FETCH_LRU_LIMIT = 16;
const FOCUS_REFRESH_MIN_INTERVAL_MS = 1500;
/**
 * How long a burst of change events is gathered before the repository is read again.
 *
 * A commit typed in a terminal rewrites several things inside `.git` in quick succession, and a
 * save in the editor arrives per write-behind flush; one read per burst answers all of it. Short
 * enough that the list settles within a blink of the command finishing.
 */
const REPO_CHANGE_REREAD_MS = 300;
// Skip the context-change refetch when the data is this fresh and the new path
// is still inside the loaded repo (cd-within-repo produces identical status).
//
// Raised from 2 s to match what a switch actually costs: `git status` on a repository with 64
// changed files measured 0.41 s end to end, while the panel took 2-3 s to show them, because a
// switch back inside the same repository re-ran the read every two seconds. A short window like
// that only ever means "ask again" for the one interaction this is here to make fast - moving
// between tabs. The status is still re-read on every context change that leaves the repository,
// on focus, and by the panel's own refresh, so nothing here makes the numbers stale.
const SC_STATUS_TTL_MS = 30_000;

type SourceControlRefreshMode = "auto" | "always" | "never";
type SourceControlRemoteAction = "fetch" | "pull" | "push";
type SourceControlRemoteActionMode =
  | "contextual"
  | SourceControlRemoteAction;

type SourceControlRemoteActionResult = {
  ok: boolean;
  action: SourceControlRemoteAction | null;
  error?: string;
  blocked?: "diverged" | "missing-upstream" | "no-repo";
};

export type SourceControlSummary = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
  applyStatus: (
    updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
  ) => void;
  refresh: (options?: {
    remote?: SourceControlRefreshMode;
  }) => Promise<void>;
  runRemoteAction: (
    mode?: SourceControlRemoteActionMode,
  ) => Promise<SourceControlRemoteActionResult>;
};

type SourceControlSummaryState = {
  contextPath: string | null;
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
  hasRepo: boolean;
  isLoading: boolean;
  localError: string | null;
  busyAction: SourceControlRemoteAction | null;
  lastRemoteError: string | null;
};

type RefreshableSourceControlState = Pick<
  SourceControlSummaryState,
  | "contextPath"
  | "repo"
  | "status"
  | "hasRepo"
  | "isLoading"
  | "localError"
  | "lastRemoteError"
>;

const EMPTY_STATE: SourceControlSummaryState = {
  contextPath: null,
  repo: null,
  status: null,
  hasRepo: false,
  isLoading: false,
  localError: null,
  busyAction: null,
  lastRemoteError: null,
};

type InflightRefresh = {
  contextKey: string;
  mode: SourceControlRefreshMode;
  promise: Promise<void>;
};

function sourceControlContextKey(
  workspaceKey: string,
  contextPath: string | null,
): string {
  return `${workspaceKey}\0${contextPath ?? ""}`;
}

function normalizedContextPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

export function repositoryContainsContext(
  repoRoot: string | null,
  contextPath: string | null,
): boolean {
  if (!repoRoot || !contextPath) return false;
  let root = normalizedContextPath(repoRoot);
  let context = normalizedContextPath(contextPath);
  const windowsPaths =
    (/^[A-Za-z]:\//.test(root) && /^[A-Za-z]:\//.test(context)) ||
    (root.startsWith("//") && context.startsWith("//"));
  if (windowsPaths) {
    root = root.toLowerCase();
    context = context.toLowerCase();
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return context === root || context.startsWith(prefix);
}

type ContextRefreshPlan =
  /** Disabled: drop everything. */
  | "reset"
  /** Run `git status` for the new context. */
  | "refresh"
  /** Fresh data already covers this context: just record the new path. */
  | "reuse"
  /** Nobody is looking and the loaded repo no longer applies: drop it, no git. */
  | "clear"
  /** Nobody is looking: leave the loaded snapshot alone, no git. */
  | "keep";

/**
 * What a context change (or a consumer appearing) should do.
 *
 * While no live consumer is on screen (`live` false) git is never run: the
 * snapshot is only kept if it still describes the repository the context is in,
 * because a rail badge showing another repo's change count is worse than none.
 * When a consumer appears the same decision runs with `live` true, so stale
 * data is refreshed on open instead of in the background.
 */
export function planContextRefresh(input: {
  enabled: boolean;
  live: boolean;
  contextPath: string | null;
  repoRoot: string | null;
  hasRepo: boolean;
  /** Milliseconds since the last completed refresh. */
  ageMs: number;
}): ContextRefreshPlan {
  if (!input.enabled) return "reset";
  const sameRepo = repositoryContainsContext(input.repoRoot, input.contextPath);
  if (!input.live) {
    if (!input.hasRepo && input.repoRoot === null) return "keep";
    return sameRepo ? "keep" : "clear";
  }
  if (input.ageMs < SC_STATUS_TTL_MS && sameRepo && input.hasRepo) {
    return "reuse";
  }
  return "refresh";
}

export function beginSourceControlRefresh<
  T extends RefreshableSourceControlState,
>(current: T, contextPath: string, reuseCurrentRepository: boolean): T {
  return {
    ...current,
    contextPath,
    repo: reuseCurrentRepository ? current.repo : null,
    status: reuseCurrentRepository ? current.status : null,
    hasRepo: reuseCurrentRepository ? current.hasRepo : false,
    isLoading: true,
    localError: null,
    lastRemoteError: reuseCurrentRepository ? current.lastRemoteError : null,
  };
}

function normalizeError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function getContextualAction(
  status: GitStatusSnapshot | null,
): SourceControlRemoteAction | null {
  if (!status?.upstream) return null;
  if (status.ahead > 0 && status.behind > 0) return null;
  if (status.behind > 0) return "pull";
  if (status.ahead > 0) return "push";
  return "fetch";
}

function touchAutoFetch(map: Map<string, number>, key: string): void {
  map.delete(key);
  map.set(key, Date.now());
  while (map.size > AUTO_FETCH_LRU_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export type UseSourceControlOptions = {
  /**
   * A live consumer (Source Control panel, git tab, explorer decorations) is on
   * screen. While false the hook runs no `git status` on window focus or when
   * the context changes; it refreshes once a consumer appears. Default true.
   */
  live?: boolean;
};

export function useSourceControl(
  contextPath: string | null,
  enabled: boolean = true,
  { live = true }: UseSourceControlOptions = {},
): SourceControlSummary {
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const workspaceKey = workspaceScopeKey(workspaceEnv);
  const t = useT();
  // The refresh effects below depend on `refresh`, so the translated fallback is
  // read through a ref: switching language must not re-run `git status`.
  const unknownError = t("scm.unknownError");
  const unknownErrorRef = useRef(unknownError);
  unknownErrorRef.current = unknownError;
  const [state, setState] = useState<SourceControlSummaryState>({
    contextPath: null,
    repo: null,
    status: null,
    hasRepo: false,
    isLoading: false,
    localError: null,
    busyAction: null,
    lastRemoteError: null,
  });
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const inflightRef = useRef<InflightRefresh | null>(null);
  const autoFetchByRepoRef = useRef(new Map<string, number>());
  const enabledRef = useRef(enabled);
  const lastRefreshAtRef = useRef(0);
  const resetWorkspaceKeyRef = useRef(workspaceKey);
  const contextKey = sourceControlContextKey(workspaceKey, contextPath);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (resetWorkspaceKeyRef.current === workspaceKey) return;
    resetWorkspaceKeyRef.current = workspaceKey;
    requestIdRef.current++;
    inflightRef.current = null;
    autoFetchByRepoRef.current.clear();
    setState({
      contextPath: null,
      repo: null,
      status: null,
      hasRepo: false,
      isLoading: false,
      localError: null,
      busyAction: null,
      lastRemoteError: null,
    });
  }, [workspaceKey]);

  const applyStatus = useCallback(
    (updater: (status: GitStatusSnapshot) => GitStatusSnapshot) => {
      setState((current) => {
        if (!current.status) return current;
        const next = updater(current.status);
        if (next === current.status) return current;
        return { ...current, status: next };
      });
    },
    [],
  );

  const doRefresh = useCallback(
    async (remoteMode: SourceControlRefreshMode): Promise<void> => {
      const refreshContextKey = contextKey;
      if (
        !enabledRef.current ||
        refreshContextKey !== contextKeyRef.current
      ) {
        return;
      }
      const requestId = ++requestIdRef.current;
      const isCurrentRequest = () =>
        requestId === requestIdRef.current &&
        refreshContextKey === contextKeyRef.current;

      if (!contextPath) {
        if (!isCurrentRequest()) return;
        setState({
          contextPath: null,
          repo: null,
          status: null,
          hasRepo: false,
          isLoading: false,
          localError: null,
          busyAction: null,
          lastRemoteError: null,
        });
        return;
      }

      const activeRoot = stateRef.current.repo?.repoRoot ?? null;
      const reusableRoot = repositoryContainsContext(activeRoot, contextPath)
        ? activeRoot
        : null;

      // A snapshot of this repository already exists: paint it before asking git anything.
      //
      // `reusableRoot` is the same-repository case and already keeps the current state. The other
      // case - a switch into a repository this window has seen before - is what the snapshot cache
      // is for; without it the panel is blank until the live read lands, which is the 5.7 s the
      // user reported. The live read below still runs and replaces this when it arrives.
      const cachedSnapshot = reusableRoot
        ? null
        : getRepoSnapshot(repoSnapshotKey(contextPath, workspaceKey));
      if (cachedSnapshot) {
        // `repo` and `status` are set from the same snapshot, so they always describe one
        // repository; the older `beginSourceControlRefresh(current, ..., true)` shape reused
        // `current.repo` and would have paired the previous repository with this context path.
        setState({
          contextPath,
          repo: cachedSnapshot.repo,
          status: cachedSnapshot.status,
          hasRepo: true,
          isLoading: true,
          busyAction: null,
          localError: null,
          lastRemoteError: null,
        });
      } else {
        setState((current) =>
          beginSourceControlRefresh(current, contextPath, !!reusableRoot),
        );
      }

      try {
        let repo: GitRepoInfo | null;
        let status: GitStatusSnapshot | null;

        if (reusableRoot) {
          try {
            repo = stateRef.current.repo ?? null;
            status = await native.gitStatus(reusableRoot);
            if (!isCurrentRequest()) return;
            if (!repo || repo.repoRoot !== reusableRoot) {
              repo = {
                repoRoot: reusableRoot,
                branch: status.branch,
                upstream: status.upstream,
                isDetached: status.isDetached,
              };
            }
          } catch {
            const snapshot = await native.gitPanelSnapshot(contextPath);
            if (!isCurrentRequest()) return;
            if (!snapshot.repo) {
              setState((current) => ({
                ...current,
                repo: null,
                status: null,
                hasRepo: false,
                isLoading: false,
                localError: null,
              }));
              return;
            }
            repo = snapshot.repo;
            status = snapshot.status ?? null;
          }
        } else {
          const snapshot = await native.gitPanelSnapshot(contextPath);
          if (!isCurrentRequest()) return;
          if (!snapshot.repo) {
            setState((current) => ({
              ...current,
              repo: null,
              status: null,
              hasRepo: false,
              isLoading: false,
              localError: null,
            }));
            return;
          }
          repo = snapshot.repo;
          status = snapshot.status ?? null;
        }

        if (!repo) {
          setState((current) => ({
            ...current,
            repo: null,
            status: null,
            hasRepo: false,
            isLoading: false,
            localError: null,
          }));
          return;
        }

        let nextRemoteError = stateRef.current.lastRemoteError;
        const shouldAutoFetch =
          repo.upstream &&
          remoteMode !== "never" &&
          (remoteMode === "always" ||
            Date.now() -
              (autoFetchByRepoRef.current.get(repo.repoRoot) ?? 0) >=
              AUTO_FETCH_THROTTLE_MS);

        // The list is shown from `git status` first, and the fetch lands behind it.
        //
        // Measured on this machine: `git status` costs 0.11 s, while the automatic fetch in front
        // of it made a switch into another repository take **5.7 s** with an empty panel the whole
        // time - the user is switching sessions, not asking to talk to a remote. The fetch still
        // runs (it is what makes "behind 3" mean the remote as it is now), it just no longer stands
        // between the user and their file list; its result replaces the counts when it arrives.
        if (!repo) {
          return;
        }
        setState((current) => ({
          ...current,
          repo,
          status,
          hasRepo: true,
          isLoading: false,
          localError: null,
          lastRemoteError: nextRemoteError,
        }));
        // Kept for the next switch to this repository, so that tab paints instead of waiting.
        rememberRepoSnapshot(repoSnapshotKey(repo.repoRoot, workspaceKey), {
          repo,
          status,
          at: Date.now(),
        });

        if (!shouldAutoFetch) return;

        // Every update below re-checks `isCurrentRequest`: the user may have switched away again
        // while the fetch was in flight, and a stale repository must not overwrite the new one.
        try {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          nextRemoteError = null;
          if (!isCurrentRequest()) return;
          const fetched = await native.gitStatus(repo.repoRoot);
          if (!isCurrentRequest()) return;
          setState((current) => ({
            ...current,
            status: fetched,
            hasRepo: true,
            isLoading: false,
            localError: null,
            lastRemoteError: nextRemoteError,
          }));
          // The fetch moved the remote-tracking refs, so the remembered ahead/behind is now wrong.
          rememberRepoSnapshot(repoSnapshotKey(repo.repoRoot, workspaceKey), {
            repo,
            status: fetched,
            at: Date.now(),
          });
        } catch (error) {
          if (!isCurrentRequest()) return;
          setState((current) => ({
            ...current,
            lastRemoteError: normalizeError(error, unknownErrorRef.current),
          }));
        }
      } catch (error) {
        if (!isCurrentRequest()) return;
        setState((current) => ({
          ...current,
          repo: null,
          hasRepo: false,
          status: null,
          isLoading: false,
          localError: normalizeError(error, unknownErrorRef.current),
        }));
      } finally {
        if (isCurrentRequest()) {
          lastRefreshAtRef.current = Date.now();
        }
      }
    },
    [contextKey, contextPath, workspaceKey],
  );

  const refresh = useCallback(
    async (options?: { remote?: SourceControlRefreshMode }) => {
      const remoteMode = options?.remote ?? "never";
      const inflight = inflightRef.current;
      if (inflight?.contextKey === contextKey) {
        const cur = inflight.mode;
        const upgrade =
          (cur === "never" && remoteMode !== "never") ||
          (cur === "auto" && remoteMode === "always");
        if (!upgrade) return inflight.promise;
      }
      const run = doRefresh(remoteMode).finally(() => {
        if (inflightRef.current?.promise === run) {
          inflightRef.current = null;
        }
      });
      inflightRef.current = { contextKey, mode: remoteMode, promise: run };
      return run;
    },
    [contextKey, doRefresh],
  );

  const runRemoteAction = useCallback(
    async (
      mode: SourceControlRemoteActionMode = "contextual",
    ): Promise<SourceControlRemoteActionResult> => {
      const { repo, status } = stateRef.current;
      if (!repo || !status) {
        return { ok: false, action: null, blocked: "no-repo" };
      }
      if (!status.upstream) {
        return { ok: false, action: null, blocked: "missing-upstream" };
      }

      const action = mode === "contextual" ? getContextualAction(status) : mode;
      if (!action) {
        return { ok: false, action: null, blocked: "diverged" };
      }

      setState((current) => ({ ...current, busyAction: action }));
      const actionContextKey = contextKeyRef.current;
      const isCurrentContext = () =>
        actionContextKey === contextKeyRef.current;

      try {
        if (action === "fetch") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
        } else if (action === "pull") {
          await native.gitFetch(repo.repoRoot);
          touchAutoFetch(autoFetchByRepoRef.current, repo.repoRoot);
          await native.gitPullFfOnly(repo.repoRoot);
        } else {
          await native.gitPush(repo.repoRoot);
        }
        if (isCurrentContext()) {
          setState((current) => ({ ...current, lastRemoteError: null }));
          await refresh({ remote: "never" });
        }
        return { ok: true, action };
      } catch (error) {
        const message = normalizeError(error, unknownErrorRef.current);
        if (isCurrentContext()) {
          setState((current) => ({ ...current, lastRemoteError: message }));
          await refresh({ remote: "never" }).catch(() => {});
        }
        return { ok: false, action, error: message };
      } finally {
        setState((current) => ({ ...current, busyAction: null }));
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (!enabled) {
      requestIdRef.current++;
      setState(EMPTY_STATE);
      return;
    }
    setState((current) => ({ ...current, lastRemoteError: null }));
    const run = () => {
      const current = stateRef.current;
      const plan = planContextRefresh({
        enabled,
        live,
        contextPath,
        repoRoot: current.repo?.repoRoot ?? null,
        hasRepo: current.hasRepo,
        ageMs: Date.now() - lastRefreshAtRef.current,
      });
      switch (plan) {
        case "refresh":
          void refresh({ remote: "never" });
          return;
        case "reuse":
          setState((s) =>
            s.contextPath === contextPath ? s : { ...s, contextPath },
          );
          return;
        case "clear":
          // Drop any refresh still in flight for the context we just left.
          requestIdRef.current++;
          setState(EMPTY_STATE);
          return;
        default:
          return;
      }
    };
    // A consumer that is on screen with nothing to show (a freshly opened
    // panel after a snapshot was dropped) must not wait for an idle slot, or it
    // would flash "no repository" first.
    const current = stateRef.current;
    if (live && contextPath && !current.hasRepo && !current.isLoading) {
      run();
      return;
    }
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 600 })
        : (window.setTimeout(run, 0) as unknown as number);
    return () => {
      if (typeof window.cancelIdleCallback === "function") {
        try {
          window.cancelIdleCallback(idle as number);
        } catch {
          /* noop */
        }
      } else {
        window.clearTimeout(idle as number);
      }
    };
  }, [refresh, contextPath, enabled, live]);

  useEffect(() => {
    if (!enabled || !live) return;
    let timer = 0;
    const onFocus = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        const elapsed = Date.now() - lastRefreshAtRef.current;
        if (elapsed < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
        void refresh({ remote: "never" });
      }, 400);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer) window.clearTimeout(timer);
    };
  }, [refresh, enabled, live]);

  const liveRef = useRef(live);
  liveRef.current = live;

  /**
   * The directories a change to this repository reports through, as one string so the effect below
   * does not re-register on every status read.
   *
   * The working tree is watched as itself, and the metadata inside it has to be asked for by name:
   * the listing filter drops `.git` for the explorer, and a commit touches nothing outside it. It
   * is watched one level in - `refs/heads` is where a commit lands, `refs/remotes/<remote>` is
   * where a fetch or a push lands - because the watcher only goes one directory deep.
   */
  const repoWatchKey = useMemo(() => {
    const root = state.repo?.repoRoot;
    if (!enabled || !root) return "";
    const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
    const upstream = state.status?.upstream ?? state.repo?.upstream ?? "";
    const remote = upstream.slice(0, upstream.indexOf("/"));
    return [
      normalized,
      `${normalized}/.git`,
      `${normalized}/.git/refs/heads`,
      ...(remote ? [`${normalized}/.git/refs/remotes/${remote}`] : []),
    ].join("\n");
  }, [state.repo?.repoRoot, state.repo?.upstream, state.status?.upstream, enabled]);

  /**
   * Register the watch the panel needs to hear about a commit it did not make.
   *
   * Without this the panel is blind to everything except its own buttons and a window focus: a
   * `git commit` typed in a terminal rewrites the index and a ref, and nothing told the panel to
   * read them again - which is the whole report, "提交后要刷新才知道全部提交了".
   *
   * Registered for as long as the repository is known, not only while the panel is on screen: the
   * terminal that commits is the tab on screen at that moment, with the panel behind it, and a
   * watch registered when the panel is looked at again is registered after the commit is over.
   */
  useEffect(() => {
    if (repoWatchKey === "") return;
    const [root, ...metadata] = repoWatchKey.split("\n");
    watchAdd([root]);
    if (metadata.length > 0) watchAdd(metadata, [], { includeSkipped: true });
    return () => {
      // Exactly what this effect added: the refcounts are shared with the explorer's own watches.
      watchRemove([root]);
      if (metadata.length > 0) watchRemove(metadata);
    };
  }, [repoWatchKey]);

  const pendingRereadRef = useRef(false);

  /**
   * Answer those events with one narrow read of this repository.
   *
   * A read while the panel is off screen is a read nobody sees, and the event does not come again,
   * so it is remembered instead and settled the moment the panel is looked at - the same trade the
   * project list makes for a pull typed in a terminal.
   */
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let timer = 0;
    void listenFsChanged((paths) => {
      if (disposed) return;
      if (!changeTouchesRepo(paths, stateRef.current.repo?.repoRoot ?? null)) {
        return;
      }
      if (!liveRef.current) {
        pendingRereadRef.current = true;
        return;
      }
      if (timer) return;
      // Throttled by deferring, never by dropping: a commit is followed by more writes inside
      // `.git` a moment later, and a dropped one is exactly the "still stale until I refresh"
      // this effect exists to remove. Measured with `scm-follows-external-change.mjs`: the first
      // version returned early when the previous read was too recent, and a file removed 200 ms
      // after it appeared never left the list.
      const wait = Math.max(
        REPO_CHANGE_REREAD_MS,
        FOCUS_REFRESH_MIN_INTERVAL_MS -
          (Date.now() - lastRefreshAtRef.current),
      );
      timer = window.setTimeout(() => {
        timer = 0;
        void refresh({ remote: "never" }).catch(() => {});
      }, wait);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [refresh, enabled]);

  // A change that arrived while the panel was hidden is settled when it is looked at.
  useEffect(() => {
    if (!enabled || !live || !pendingRereadRef.current) return;
    pendingRereadRef.current = false;
    void refresh({ remote: "never" }).catch(() => {});
  }, [live, enabled, refresh]);

  return useMemo<SourceControlSummary>(
    () => ({
      contextPath: state.contextPath,
      repo: state.repo,
      status: state.status,
      upstream: state.status?.upstream ?? state.repo?.upstream ?? null,
      ahead: state.status?.ahead ?? 0,
      behind: state.status?.behind ?? 0,
      hasRepo: state.hasRepo,
      isLoading: state.isLoading,
      localError: state.localError,
      busyAction: state.busyAction,
      lastRemoteError: state.lastRemoteError,
      applyStatus,
      refresh,
      runRemoteAction,
    }),
    [state, applyStatus, refresh, runRemoteAction],
  );
}
