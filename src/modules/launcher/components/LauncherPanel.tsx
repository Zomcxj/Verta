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
import { useCallback, useEffect, useMemo, useState } from "react";
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const results = await Promise.allSettled(
      TOOLS.map((tool) => listAgentSessions(tool)),
    );
    const merged: AgentSession[] = [];
    const nextWarnings: string[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        merged.push(...result.value.sessions);
        nextWarnings.push(...result.value.warnings);
      } else {
        // One unreadable store must not hide the other tool's sessions.
        failures.push(`${TOOLS[index]}：${String(result.reason)}`);
      }
    });
    merged.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    setSessions(merged);
    setWarnings(nextWarnings);
    setError(failures.length > 0 ? failures.join("\n") : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
          `有 ${failures.length} 条没能删除：\n${failures
            .map(
              (outcome) =>
                `${outcome.tool} ${outcome.id}：${outcome.reason ?? "未知原因"}`,
            )
            .join("\n")}`,
        );
      }
    } catch (failure) {
      setError(`删除请求失败：${String(failure)}`);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refresh]);

  const nowMs = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          {managing ? "管理会话" : "本机会话"}
        </span>
        <button
          type="button"
          onClick={toggleManaging}
          className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {managing ? "完成" : "管理"}
        </button>
        <button
          type="button"
          disabled={loading || deleting}
          onClick={() => void refresh()}
          className="cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        >
          {loading ? "读取中" : "刷新"}
        </button>
      </div>

      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题或目录"
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
        {error && visible.length === 0 ? null : (
          <SessionList
            sessions={visible}
            activeId={activeSessionId}
            onOpen={onOpenSession}
            formatTime={(updatedAtMs) => relativeTime(nowMs, updatedAtMs)}
            selectable={managing}
            selected={selected}
            onToggle={(session) =>
              setSelected((was) => toggleSelection(was, sessionKey(session)))
            }
          />
        )}
      </div>

      {managing ? (
        <div className="flex shrink-0 items-center gap-1 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          <span>已选 {selected.size} 条</span>
          <button
            type="button"
            onClick={() =>
              setSelected((was) => updateSelection(was, "all", visibleKeys))
            }
            className="cursor-pointer rounded px-1.5 py-0.5 outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            全选
          </button>
          <button
            type="button"
            onClick={() =>
              setSelected((was) => updateSelection(was, "none", visibleKeys))
            }
            className="cursor-pointer rounded px-1.5 py-0.5 outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            清空
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || deleting}
            onClick={openDeleteDialog}
            className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[11px] text-destructive outline-none transition-colors duration-[var(--dur-base)] hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:opacity-40"
          >
            {deleting ? "删除中" : "删除"}
          </button>
        </div>
      ) : (
        <div className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
          {visible.length === topLevel.length
            ? `${topLevel.length} 条`
            : `${visible.length} / ${topLevel.length} 条`}
          {warnings.length > 0 ? `，${warnings.length} 个文件无法解析` : ""}
        </div>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete === null ? "" : deleteWarning(pendingDelete)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Every consequence of the click, in one place, before anything is removed. */
function deleteWarning(pending: PendingDelete): string {
  const { total, byTool, subagents, hasSubagents } = pending.summary;
  const parts = [
    `将从本机永久删除 ${total} 条会话记录（opencode ${byTool.opencode} 条、pi ${byTool.pi} 条），无法撤销。`,
    "删除 opencode 的父会话会连带删除它的子会话。",
    "删除 pi 会话时会连同该会话的产物目录一起删除。",
  ];
  if (hasSubagents) parts.push(`其中 ${subagents} 条是子代理或分叉会话。`);
  if (pending.includesActive) parts.push("其中包含当前已在终端打开的会话。");
  return parts.join("");
}
