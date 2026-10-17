import { cn } from "@/lib/utils";
import { foldSessions } from "../lib/sessionTree";
import type { AgentSession } from "../lib/types";

type Props = {
  sessions: AgentSession[];
  activeId: string | null;
  onOpen: (session: AgentSession) => void;
  formatTime: (updatedAtMs: number) => string;
};

export function SessionList({ sessions, activeId, onOpen, formatTime }: Props) {
  const rows = foldSessions(sessions);
  if (rows.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        没有会话记录
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 px-1.5 pb-2">
      {rows.map((row) => (
        <div key={row.parent.id} className="flex flex-col gap-0.5">
          <SessionButton
            session={row.parent}
            active={row.parent.id === activeId}
            onOpen={onOpen}
            formatTime={formatTime}
          />
          {row.children.length > 0 ? (
            <div className="ml-3 flex flex-col gap-0.5 border-l border-border/60 pl-1.5">
              {row.children.map((child) => (
                <SessionButton
                  key={child.id}
                  session={child}
                  active={child.id === activeId}
                  onOpen={onOpen}
                  formatTime={formatTime}
                />
              ))}
            </div>
          ) : null}
        </div>
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
