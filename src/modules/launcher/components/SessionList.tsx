import { cn } from "@/lib/utils";
import type { AgentSession } from "../lib/types";

type Props = {
  sessions: AgentSession[];
  activeId: string | null;
  onOpen: (session: AgentSession) => void;
  formatTime: (updatedAtMs: number) => string;
};

export function SessionList({ sessions, activeId, onOpen, formatTime }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        没有会话记录
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 px-1.5 pb-2">
      {sessions.map((session) => (
        <SessionButton
          key={session.id}
          session={session}
          active={session.id === activeId}
          onOpen={onOpen}
          formatTime={formatTime}
        />
      ))}
    </div>
  );
}

function SessionButton({
  session,
  active,
  onOpen,
  formatTime,
}: {
  session: AgentSession;
  active: boolean;
} & Pick<Props, "onOpen" | "formatTime">) {
  return (
    <button
      type="button"
      title={`${session.title}\n${session.cwd}\n${session.id}`}
      onClick={() => onOpen(session)}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none",
        "transition-colors duration-[var(--dur-base)] focus-visible:ring-2 focus-visible:ring-primary/40",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "hover:bg-foreground/[0.045]",
      )}
    >
      <span className="truncate text-xs text-foreground">{session.title}</span>
      <span className="truncate text-[10px] text-muted-foreground">
        {session.tool} · {formatTime(session.updatedAtMs)} · {session.cwd}
      </span>
    </button>
  );
}
