import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import { relativeTime } from "../lib/relativeTime";
import { listAgentSessions } from "../lib/sessions";
import type { AgentSession, AgentTool } from "../lib/types";
import { SessionList } from "./SessionList";

const TOOLS: { id: AgentTool; label: string }[] = [
  { id: "opencode", label: "opencode" },
  { id: "pi", label: "pi" },
];

type Props = {
  activeSessionId: string | null;
  onOpenSession: (session: AgentSession) => void;
};

export function LauncherPanel({ activeSessionId, onOpenSession }: Props) {
  const [tool, setTool] = useState<AgentTool>("opencode");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (target: AgentTool) => {
    setLoading(true);
    setError(null);
    try {
      const payload = await listAgentSessions(target);
      setSessions(payload.sessions);
      setWarnings(payload.warnings);
    } catch (failure) {
      // Keep the previous rows on screen but never hide the failure: an
      // unreadable store must not look like "no sessions".
      setError(String(failure));
      setWarnings([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(tool);
  }, [refresh, tool]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        session.cwd.toLowerCase().includes(needle),
    );
  }, [query, sessions]);

  const nowMs = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tool === item.id}
            onClick={() => setTool(item.id)}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1 text-[11px] outline-none",
              "transition-colors duration-[var(--dur-base)] focus-visible:ring-2 focus-visible:ring-primary/40",
              tool === item.id
                ? "bg-foreground/[0.07] text-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          disabled={loading}
          onClick={() => void refresh(tool)}
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
        <div className="mx-2 mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] break-words text-destructive">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionList
          sessions={visible}
          activeId={activeSessionId}
          onOpen={onOpenSession}
          formatTime={(updatedAtMs) => relativeTime(nowMs, updatedAtMs)}
        />
      </div>

      <div className="shrink-0 border-t border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
        {visible.length} / {sessions.length} 条
        {warnings.length > 0 ? `，${warnings.length} 个文件无法解析` : ""}
      </div>
    </div>
  );
}
