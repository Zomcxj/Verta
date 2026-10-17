import { cn } from "@/lib/utils";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { sessionKey } from "../lib/selection";
import type { AgentSession } from "../lib/types";

type Props = {
  sessions: AgentSession[];
  activeId: string | null;
  onOpen: (session: AgentSession) => void;
  formatTime: (updatedAtMs: number) => string;
  /** Managing turns a row into a checkbox: clicking it selects, not opens. */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (session: AgentSession) => void;
};

export function SessionList({
  sessions,
  activeId,
  onOpen,
  formatTime,
  selectable = false,
  selected,
  onToggle,
}: Props) {
  if (sessions.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        {selectable ? "没有可管理的会话" : "没有会话记录"}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 px-1.5 pb-2">
      {sessions.map((session) => (
        <SessionButton
          key={sessionKey(session)}
          session={session}
          active={session.id === activeId}
          onOpen={onOpen}
          formatTime={formatTime}
          selectable={selectable}
          checked={selected?.has(sessionKey(session)) ?? false}
          onToggle={onToggle}
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
  selectable,
  checked,
  onToggle,
}: {
  session: AgentSession;
  active: boolean;
  selectable: boolean;
  checked: boolean;
} & Pick<Props, "onOpen" | "formatTime" | "onToggle">) {
  return (
    <button
      type="button"
      title={`${session.title}\n${session.cwd}\n${session.id}`}
      onClick={() =>
        selectable && onToggle ? onToggle(session) : onOpen(session)
      }
      className={cn(
        "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none",
        "transition-colors duration-[var(--dur-base)] focus-visible:ring-2 focus-visible:ring-primary/40",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "hover:bg-foreground/[0.045]",
      )}
    >
      {selectable ? (
        <span
          aria-hidden
          data-checked={checked}
          className={cn(
            "mt-[1px] flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-input/90",
            "data-[checked=true]:bg-primary data-[checked=true]:text-primary-foreground",
            "text-transparent",
          )}
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <AgentIcon
            agent={session.tool}
            size={13}
            className="shrink-0 text-muted-foreground"
          />
          <span className="truncate text-xs text-foreground">
            {session.title}
          </span>
          {session.parentId !== null ? (
            <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] leading-4 text-muted-foreground">
              子代理
            </span>
          ) : null}
        </span>
        <span className="truncate text-[10px] text-muted-foreground">
          {formatTime(session.updatedAtMs)} · {session.cwd}
        </span>
      </span>
    </button>
  );
}
