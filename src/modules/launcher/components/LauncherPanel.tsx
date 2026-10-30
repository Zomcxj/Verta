import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { listen } from "@tauri-apps/api/event";
import { type MessageKey, useT } from "@/modules/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { renameAgentSession } from "../lib/sessions";
import { type SessionGroupBy, groupBySource } from "../lib/sessionGroups";
import { relativeToRoot } from "../lib/sessionPaths";
import { AGENT_TOOLS } from "../lib/tools";
import {
  type DeletionSummary,
  deletionSummary,
  type SessionKey,
  selectedTargets,
  sessionKey,
  toggleSelection,
  updateSelection,
} from "../lib/selection";
import {
  deleteAgentSessions,
  listAgentSessions,
  runningAgentSessionIds,
} from "../lib/sessions";
import type { AgentSession, AgentTool, SessionTarget } from "../lib/types";
import { topLevelSessions } from "../lib/visibleSessions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useAgentActivityStore } from "@/modules/terminal";
import { useWindowHidden } from "@/modules/theme/WindowActivityBridge";
import type { Tab } from "@/modules/tabs/lib/useTabs";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import {
  ACTIVE_TICK_MS,
  ACTIVE_WINDOW_BY_TOOL,
  activeByWindow,
  activeWithService,
  backgroundStateById,
  sessionStateById,
  waitingFirst,
} from "../lib/sessionActivity";
import { SessionList, type SessionRowActions } from "./SessionList";

const TOOLS: AgentTool[] = AGENT_TOOLS;

/**
 * The last list read, kept at module scope.
 *
 * The sidebar swaps panels with a `key`, so leaving the sessions list for the file tree and coming
 * back mounts this component again with nothing. Module scope is the one thing that survives that,
 * so the panel draws what it had while the read happens again instead of flashing an empty list.
 * Only a display cache: nothing decides anything from it, and a read replaces it.
 */
let cachedSessions: AgentSession[] = [];

/** One source the list reads from: a tool on this machine, or in one distro. */
type SessionRequest = { tool: AgentTool; distro: string | null };

/** Identity of a source, for tracking which ones are still being read. */
function sourceKeyOf(request: SessionRequest): string {
  return `${request.distro ?? ""}::${request.tool}`;
}

/** The sources a read has not answered yet, as a set of `sourceKeyOf` values. */
function pendingFor(requests: readonly SessionRequest[]): Set<string> {
  return new Set(requests.map(sourceKeyOf));
}

/**
 * Copy to the clipboard, and say something either way: a menu item that does
 * nothing at all is the most unsettling outcome there is.
 */
function copyText(text: string, copied: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(copied))
    .catch((error) => toast.error(String(error)));
}

type PendingDelete = {
  targets: SessionTarget[];
  summary: DeletionSummary;
  includesActive: boolean;
};

type Props = {
  activeSessionId: string | null;
  onOpenSession: (session: AgentSession) => void;
  /** The open tabs, so a row can be marked when its session is running in one. */
  tabs: readonly Tab[];
  /** Current workspace root: "Copy relative path" resolves against it, and the item
   * is absent without one. */
  workspaceRoot?: string | null;
};

export function LauncherPanel({
  activeSessionId,
  onOpenSession,
  tabs,
  workspaceRoot = null,
}: Props) {
  const [query, setQuery] = useState("");
  const t = useT();
  // Seeded from the last read, so a remount shows the list it showed before rather than nothing.
  const [sessions, setSessions] = useState<AgentSession[]>(() => cachedSessions);
  /** Whether a read has finished at least once: an unread empty list is not an empty list. */
  const [hasRead, setHasRead] = useState(() => cachedSessions.length > 0);
  /**
   * Sources whose read has not come back yet.
   *
   * Not the same as "no rows yet". A distro is read by running a query inside it, which takes
   * seconds on a large store, so this machine's rows arrive long before the distro's. Rendering the
   * list as soon as one source answers showed a list that was missing its WSL block with nothing to
   * say why - which reads as "the switch did not work", the one thing enabling it was meant to
   * change. A source counts as read when its request settles, whether it succeeded or failed.
   */
  const [pendingSources, setPendingSources] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  /** Session being renamed in place (`sessionKey`); null when none. */
  const [renaming, setRenaming] = useState<SessionKey | null>(null);
  /** Default is one block sorted by time; `tool` splits it into per-agent sections. */
  const [groupBy, setGroupBy] = useState<SessionGroupBy>("all");

  /**
   * Reading the list while the user picks rows for deletion makes the list jump
   * as sessions re-sort, and a mis-tick on a destructive action is not
   * recoverable. Freshness waits until the selection is finished.
   */
  const pausedRef = useRef(false);
  pausedRef.current = managing || deleting || pendingDelete !== null;

  const wslEnabled = usePreferencesStore((s) => s.wslEnabled);
  const wslDistros = useWorkspaceEnvStore((s) => s.distros);
  const refreshDistros = useWorkspaceEnvStore((s) => s.refreshDistros);

  // Only ask for distros when the toggle is on; while it is off we do not even
  // enumerate them.
  useEffect(() => {
    if (wslEnabled) void refreshDistros();
  }, [wslEnabled, refreshDistros]);

  /** Session sources: local, plus every distro when the toggle is on. */
  const sources = useMemo<(string | null)[]>(
    () => (wslEnabled ? [null, ...wslDistros.map((d) => d.name)] : [null]),
    [wslEnabled, wslDistros],
  );

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      // A background refresh must not flash the list: the spinner is for people
      // who asked, not for a change that arrived on its own.
      if (!options?.silent) setLoading(true);
      setError(null);
      const requests = sources.flatMap((distro) =>
        TOOLS.map((tool) => ({ tool, distro })),
      );
      // Every source starts out unanswered. A distro is read by running a query inside it, so its
      // rows arrive seconds after this machine's; until they do, the list is missing a block it is
      // about to have, and drawing it as complete reads as "the switch did nothing".
      setPendingSources(pendingFor(requests));
      const merged: AgentSession[] = [];
      const nextWarnings: string[] = [];
      const failures: string[] = [];
      // Settled per source rather than all at once: a slow distro no longer holds back the rows
      // that are already answered.
      await Promise.all(
        requests.map(async (request) => {
          const key = sourceKeyOf(request);
          try {
            const value = await listAgentSessions(request.tool, request.distro);
            merged.push(...value.sessions);
            nextWarnings.push(...value.warnings);
          } catch (error) {
            // One unreadable store must not hide the others.
            const source = request.distro
              ? `${request.tool}（${request.distro}）`
              : request.tool;
            failures.push(`${source}：${String(error)}`);
          } finally {
            setPendingSources((prev) => {
              if (!prev.has(key)) return prev;
              const next = new Set(prev);
              next.delete(key);
              return next;
            });
            merged.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
            cachedSessions = merged;
            setSessions([...merged]);
          }
        }),
      );
      setHasRead(true);
      setWarnings(nextWarnings);
      setError(failures.length > 0 ? failures.join("\n") : null);
      setLoading(false);
    },
    [sources],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Rename a session. Nothing but the name changes: opencode rewrites the row in
   * its database and pi appends a `session_info` line, and the backend re-reads
   * the list afterwards so the UI shows the name as actually stored.
   */
  const renameSession = useCallback(
    async (session: AgentSession, name: string) => {
      const next = name.trim();
      if (!next || next === session.title) return;
      try {
        await renameAgentSession(session, next);
        await refresh({ silent: true });
      } catch (error) {
        toast.error(String(error));
      }
    },
    [refresh],
  );

  /**
   * Everything a row's context menu needs, in one object: the rows are memoised, and an object built
   * inline would be a new one on every render, which would re-render every row in the list. The
   * callbacks that go into it are stable for the same reason.
   */
  const rowActions = useMemo<SessionRowActions>(
    () => ({
      onOpen: onOpenSession,
      onCopyAbsolute: (session) => copyText(session.cwd, t("launcher.copied")),
      onCopyRelative: (session) => {
        const relative = relativeToRoot(workspaceRoot, session.cwd);
        if (relative) copyText(relative, t("launcher.copied"));
      },
      onCopyId: (session) => copyText(session.id, t("launcher.copied")),
      onStartRename: (session) => setRenaming(sessionKey(session)),
      canCopyRelative: relativeToRoot(workspaceRoot, "") !== null,
      renameId: renaming,
      onRenameSubmit: (session, name) => {
        setRenaming(null);
        void renameSession(session, name);
      },
      onRenameCancel: () => setRenaming(null),
    }),
    [onOpenSession, t, workspaceRoot, renaming, renameSession],
  );

  const toggleRow = useCallback((session: AgentSession) => {
    setSelected((was) => toggleSelection(was, sessionKey(session)));
  }, []);

  // The backend watches both session stores and reports a change once per
  // burst. That is what makes a session started in a terminal appear here
  // without pressing Refresh.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen("verta://agent-sessions-changed", () => {
      if (!disposed && !pausedRef.current) void refresh({ silent: true });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // No watcher available: the manual Refresh button still works.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  // Leaving the selection flow catches up on whatever arrived while paused.
  useEffect(() => {
    if (!managing) void refresh({ silent: true });
  }, [managing, refresh]);

  /**
   * Which of these sessions are running right now, and how.
   *
   * Subscribing to the three maps and deriving from them is what keeps a row's dot
   * and its place in the list in step with the tab strip: the store changes when a
   * state changes, and there is one source for both surfaces.
   */
  const phases = useAgentActivityStore((s) => s.phases);
  const agents = useAgentActivityStore((s) => s.agents);
  const leafPty = useAgentActivityStore((s) => s.leafPty);
  const unseenDone = useAgentActivityStore((s) => s.unseenDone);
  const states = useMemo(
    () => sessionStateById({ tabs, leafPty, phases, agents, unseenDone }),
    [tabs, leafPty, phases, agents, unseenDone],
  );

  /**
   * Sessions written to recently, from the times the list already carries.
   *
   * No query of its own: `lastAtMs` arrives with the rows, and the rows are re-read whenever the
   * session watcher says something changed. What the tick is for is the other direction - writes
   * stop silently, and without re-answering "is anything still recent" the last mark would stay lit
   * until something unrelated moved. It stops while the window is put away, where nobody can see it.
   */
  const [tick, setTick] = useState(0);
  const windowHidden = useWindowHidden();
  useEffect(() => {
    if (windowHidden) return;
    const timer = setInterval(() => setTick((n) => n + 1), ACTIVE_TICK_MS);
    return () => clearInterval(timer);
  }, [windowHidden]);

  /**
   * Sessions the opencode service says are mid-turn, refreshed on the same slow tick.
   *
   * The write times go quiet during a long tool call; the service knows the turn has not finished.
   * Asked on the tick rather than pushed, because the service is a local HTTP endpoint and this is
   * the one place that already wakes up on a schedule. A source that cannot be asked contributes
   * nothing, and the write times carry the list alone.
   */
  const [serviceRunning, setServiceRunning] = useState<ReadonlySet<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the re-ask trigger; the effect reads nothing from it, and without it the answer would be the one from mount forever
  useEffect(() => {
    if (windowHidden) return;
    let live = true;
    void (async () => {
      const answers = await Promise.all(
        sources.map((distro) => runningAgentSessionIds(distro)),
      );
      if (!live) return;
      // `null` from every source means the question could not be asked at all; that is not the
      // same as "nothing is running", so it is kept distinct.
      if (answers.every((ids) => ids === null)) {
        setServiceRunning(null);
        return;
      }
      const ids = new Set<string>();
      for (const answer of answers) for (const id of answer ?? []) ids.add(id);
      setServiceRunning(ids);
    })();
    return () => {
      live = false;
    };
  }, [sources, tick, windowHidden]);

  const topLevel = useMemo(() => topLevelSessions(sessions), [sessions]);

  /** What the rows draw: the tab's own reading where there is one, recent writes elsewhere. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the manual re-answer trigger; nothing in the callback reads it, and without it the last mark would stay lit after writes stop
  const rowStates = useMemo(
    // A remount starts from the list it had, so the rows and their times are there on the first
    // frame; nothing has to be cached on the marks' behalf.
    () =>
      backgroundStateById(
        states,
        activeWithService(
          activeByWindow(topLevel, Date.now(), ACTIVE_WINDOW_BY_TOOL),
          serviceRunning,
        ),
        topLevel,
      ),
    [states, topLevel, tick, serviceRunning],
  );
  // Managing deliberately shows the subagent sessions this list otherwise hides.
  const listed = managing ? sessions : topLevel;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return listed;
    return listed.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle),
    );
  }, [query, listed]);

  const visibleKeys = useMemo(() => visible.map(sessionKey), [visible]);

  /**
   * Group by source (local / each distro). With a single source no source heading
   * is drawn, so the look stays as it was.
   *
   * Within each group, `groupBy` decides the layout: `all` is one block in reverse
   * chronological order, `tool` is one section per agent. Source and agent nest
   * small-inside-large because local and WSL sessions are separate stores;
   * lumping them under one "opencode" heading leaves no way to tell which is read.
   */
  const groups = useMemo(
    () => groupBySource(visible, TOOLS, groupBy),
    [visible, groupBy],
  );

  /** Source headings only earn their space with multiple sources or per-agent
   * sections; otherwise they are a wasted line. */
  const showSourceHeadings = groups.length > 1 || groupBy === "tool";

  const toggleManaging = useCallback(() => {
    setManaging((was) => !was);
    setSelected(new Set());
    setError(null);
  }, []);

  const openDeleteDialog = useCallback(() => {
    const chosen = sessions.filter((session) =>
      selected.has(sessionKey(session)),
    );
    if (chosen.length === 0) return;
    setPendingDelete({
      targets: selectedTargets(sessions, selected),
      summary: deletionSummary(chosen),
      includesActive: chosen.some((session) => session.id === activeSessionId),
    });
  }, [activeSessionId, selected, sessions]);

  const confirmDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    const targets = pendingDelete.targets;
    setPendingDelete(null);
    setDeleting(true);
    setError(null);
    try {
      const report = await deleteAgentSessions(targets);
      const failures = report.outcomes.filter((outcome) => !outcome.deleted);
      // Reported after the refresh, so the list already shows what survived.
      setSelected(new Set());
      await refresh();
      if (failures.length > 0) {
        setError(
          t("launcher.deleteFailed", {
            count: failures.length,
            failures: failures
              .map((outcome) =>
                t("launcher.failureLine", {
                  tool: outcome.tool,
                  id: outcome.id,
                  reason: outcome.reason ?? t("launcher.unknownReason"),
                }),
              )
              .join("\n"),
          }),
        );
      }
    } catch (failure) {
      setError(t("launcher.deleteRequestFailed", { message: String(failure) }));
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refresh, t]);


  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("rail.sessions")}
        </span>
        <button
          type="button"
          onClick={toggleManaging}
          className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {managing ? t("launcher.done") : t("launcher.manage")}
        </button>
        <button
          type="button"
          disabled={loading || deleting}
          onClick={() => void refresh()}
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          {loading ? t("launcher.loading") : t("launcher.refresh")}
        </button>
      </div>

      <div className="flex shrink-0 flex-col gap-1 px-2 pb-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("launcher.search")}
          className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        />
        {/* Default is "all": one straight chronological list. The agent mode splits it
            into sections ordered like the tool list. */}
        <div
          role="tablist"
          aria-label={t("launcher.groupBy")}
          className="flex items-center gap-0.5 self-start rounded-md bg-foreground/[0.05] p-0.5"
        >
          {(["all", "tool"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={groupBy === mode}
              onClick={() => setGroupBy(mode)}
              className={cn(
                "cursor-pointer rounded px-1.5 py-0.5 text-[10px] outline-none transition-colors duration-[var(--dur-base)] focus-visible:ring-2 focus-visible:ring-primary/40",
                groupBy === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "all" ? t("launcher.groupAll") : t("launcher.groupByTool")}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div
          className={cn(
            "mx-2 mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5",
            "text-[11px] break-words whitespace-pre-line text-destructive",
          )}
        >
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && visible.length === 0
          ? null
          : groups.map((group) => (
              <div key={group.distro ?? "local"}>
                {showSourceHeadings ? (
                  <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-muted-foreground">
                    {group.distro
                      ? t("launcher.sourceWsl", { distro: group.distro })
                      : t("launcher.sourceLocal")}
                  </div>
                ) : null}
                {group.sections.map((section) => (
                  <div key={section.tool ?? "all"}>
                    {section.tool ? (
                      <div className="px-3 pt-1 pb-0.5 text-[10px] text-muted-foreground/80">
                        {section.tool}
                      </div>
                    ) : null}
                    <SessionList
                      // Waiting first, inside the section it belongs to: the
                      // grouping itself is the user's choice and is left alone.
                      // Not while managing either - a row that moves under the
                      // cursor is how the wrong session gets ticked.
                      sessions={
                        managing
                          ? section.sessions
                          : waitingFirst(section.sessions, rowStates)
                      }
                      activeId={activeSessionId}
                      states={rowStates}
                      onOpen={onOpenSession}
                      selectable={managing}
                      actions={rowActions}
                      selected={selected}
                      onToggle={toggleRow}
                      // Only the first read counts: a refresh over an empty list the user has
                      // already seen is not news.
                      // "Reading" covers a source still outstanding, not only the very first read:
                      // the list is incomplete until every source it asked has answered.
                      reading={!hasRead || pendingSources.size > 0}
                    />
                  </div>
                ))}
              </div>
            ))}
      </div>

      {managing ? (
        <div className="flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          <span>{t("launcher.selectedCount", { count: selected.size })}</span>
          <button
            type="button"
            onClick={() =>
              setSelected((was) => updateSelection(was, "all", visibleKeys))
            }
            className="cursor-pointer rounded px-1.5 py-0.5 outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t("launcher.selectAll")}
          </button>
          <button
            type="button"
            onClick={() =>
              setSelected((was) => updateSelection(was, "none", visibleKeys))
            }
            className="cursor-pointer rounded px-1.5 py-0.5 outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {t("launcher.clear")}
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || deleting}
            onClick={openDeleteDialog}
            className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[11px] text-destructive outline-none transition-colors duration-[var(--dur-base)] hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-40"
          >
            {deleting ? t("launcher.deleting") : t("launcher.delete")}
          </button>
        </div>
      ) : (
        <div
          className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground"
          // Warnings can come from anywhere (parse failures, a missing tool database
          // in the distro), so the text has to be readable, not just a count.
          title={warnings.length > 0 ? warnings.join("\n") : undefined}
        >
          {visible.length === topLevel.length
            ? t("launcher.countAll", { total: topLevel.length })
            : t("launcher.count", {
                shown: visible.length,
                total: topLevel.length,
              })}
          {warnings.length > 0
            ? t("launcher.unparsed", { count: warnings.length })
            : ""}
        </div>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("launcher.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete === null ? "" : deleteWarning(pendingDelete, t)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("launcher.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("launcher.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Every consequence of the click, in one place, before anything is removed. */
function deleteWarning(
  pending: PendingDelete,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const { total, byTool, subagents, hasSubagents } = pending.summary;
  const parts = [t("launcher.deleteBody", { total })];
  // Mention each tool's side effects only when that kind of session is actually
  // selected, and without naming the tool: a name list grows with every new agent
  // and reads like calling users out.
  if (byTool.opencode > 0) parts.push(t("launcher.deleteWarnChildren"));
  if (byTool.pi > 0) parts.push(t("launcher.deleteWarnArtifacts"));
  if (hasSubagents) parts.push(t("launcher.deleteSubagents", { count: subagents }));
  if (pending.includesActive) parts.push(t("launcher.deleteWarnActive"));
  return parts.join("");
}
