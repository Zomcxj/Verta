import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { relativeTime } from "../lib/relativeTime";
import { listAgentSessions } from "../lib/sessions";
import type { AgentSession, AgentTool } from "../lib/types";
import { topLevelSessions } from "../lib/visibleSessions";
import { SessionList } from "./SessionList";

const TOOLS: AgentTool[] = ["opencode", "pi"];

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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return topLevel;
    return topLevel.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle),
    );
  }, [query, topLevel]);

  const nowMs = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center px-2 py-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">
          本机会话
        </span>
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh()}
          className="ml-auto cursor-pointer rounded-md px-2 py-1 text-[11px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
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
          />
        )}
      </div>

      <div className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
        {visible.length === topLevel.length
          ? `${topLevel.length} 条`
          : `${visible.length} / ${topLevel.length} 条`}
        {warnings.length > 0 ? `，${warnings.length} 个文件无法解析` : ""}
      </div>
    </div>
  );
}
