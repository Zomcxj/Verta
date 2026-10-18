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
import { relativeTime } from "../lib/relativeTime";
import {
  type DeletionSummary,
  deletionSummary,
  selectedTargets,
  sessionKey,
  toggleSelection,
  updateSelection,
} from "../lib/selection";
import { deleteAgentSessions, listAgentSessions } from "../lib/sessions";
import type { AgentSession, AgentTool, SessionTarget } from "../lib/types";
import { topLevelSessions } from "../lib/visibleSessions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { SessionList } from "./SessionList";

const TOOLS: AgentTool[] = ["opencode", "pi"];

type PendingDelete = {
  targets: SessionTarget[];
  summary: DeletionSummary;
  includesActive: boolean;
};

type Props = {
  activeSessionId: string | null;
  onOpenSession: (session: AgentSession) => void;
};

export function LauncherPanel({ activeSessionId, onOpenSession }: Props) {
  const [query, setQuery] = useState("");
  const t = useT();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
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

  // 只有开关打开时才去问发行版；关着的时候连发行版列表都不枚举。
  useEffect(() => {
    if (wslEnabled) void refreshDistros();
  }, [wslEnabled, refreshDistros]);

  /** 会话来源：本机，加上开关打开时的每个发行版。 */
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
      const results = await Promise.allSettled(
        requests.map((request) =>
          listAgentSessions(request.tool, request.distro),
        ),
      );
      const merged: AgentSession[] = [];
      const nextWarnings: string[] = [];
      const failures: string[] = [];
      results.forEach((result, index) => {
        const { tool, distro } = requests[index];
        if (result.status === "fulfilled") {
          merged.push(...result.value.sessions);
          nextWarnings.push(...result.value.warnings);
        } else {
          // One unreadable store must not hide the others.
          const source = distro ? `${tool}（${distro}）` : tool;
          failures.push(`${source}：${String(result.reason)}`);
        }
      });
      merged.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      setSessions(merged);
      setWarnings(nextWarnings);
      setError(failures.length > 0 ? failures.join("\n") : null);
      setLoading(false);
    },
    [sources],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const topLevel = useMemo(() => topLevelSessions(sessions), [sessions]);
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
   * 按来源分组（本机 / 各发行版）。只有一个来源时不显示分组标题，外观与从前一致；
   * 空列表也保留一个空分组，好让列表自身的空状态文案照常出现。
   */
  const groups = useMemo(() => {
    const bySource = new Map<string, AgentSession[]>();
    for (const session of visible) {
      const key = session.distro ?? "";
      const bucket = bySource.get(key);
      if (bucket) bucket.push(session);
      else bySource.set(key, [session]);
    }
    const entries = [...bySource.entries()].map(([key, sessions]) => ({
      distro: key === "" ? null : key,
      sessions,
    }));
    return entries.length > 0 ? entries : [{ distro: null, sessions: [] }];
  }, [visible]);

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

  const nowMs = Date.now();

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

      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("launcher.search")}
          className="w-full rounded-md border border-border/60 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        />
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
                {groups.length > 1 ? (
                  <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-muted-foreground">
                    {group.distro
                      ? t("launcher.sourceWsl", { distro: group.distro })
                      : t("launcher.sourceLocal")}
                  </div>
                ) : null}
                <SessionList
                  sessions={group.sessions}
                  activeId={activeSessionId}
                  onOpen={onOpenSession}
                  formatTime={(updatedAtMs) => relativeTime(nowMs, updatedAtMs)}
                  selectable={managing}
                  selected={selected}
                  onToggle={(session) =>
                    setSelected((was) =>
                      toggleSelection(was, sessionKey(session)),
                    )
                  }
                />
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
          // 提示可能来自任何来源（解析失败、发行版里没有某个工具的库），文字要能读到，
          // 不能只留一个数字。
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
  const parts = [
    t("launcher.deleteBody", {
      total,
      opencode: byTool.opencode,
      pi: byTool.pi,
    }),
    t("launcher.deleteWarnOpencode"),
    t("launcher.deleteWarnPi"),
  ];
  if (hasSubagents) parts.push(t("launcher.deleteSubagents", { count: subagents }));
  if (pending.includesActive) parts.push(t("launcher.deleteWarnActive"));
  return parts.join("");
}
