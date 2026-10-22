import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { AgentIcon } from "../lib/agentIcon";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { sessionKey } from "../lib/selection";
import {
  lastTalkedDayLabel,
  statsOf,
  tokensLabel,
  turnsLabel,
} from "../lib/sessionStats";
import type { AgentSession } from "../lib/types";

/** 右键菜单里那几项要拿到的东西。路径由界面自己算（相对路径以会话 cwd 的父级为基准没意义，
 *  所以相对路径按「相对于当前工作区根」算，拿不到根就只给绝对路径）。 */
export type SessionRowActions = {
  onOpen: (session: AgentSession) => void;
  onCopyAbsolute: (session: AgentSession) => void;
  onCopyRelative: (session: AgentSession) => void;
  onCopyId: (session: AgentSession) => void;
  onStartRename: (session: AgentSession) => void;
  /** 相对路径算不出来（没有工作区根）时为 false，那一项就灰着。 */
  canCopyRelative: boolean;
  renameId: string | null;
  onRenameSubmit: (session: AgentSession, name: string) => void;
  onRenameCancel: () => void;
};

type Props = {
  sessions: AgentSession[];
  activeId: string | null;
  onOpen: (session: AgentSession) => void;
  /** Managing turns a row into a checkbox: clicking it selects, not opens. */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (session: AgentSession) => void;
  /** 右键菜单与就地改名；不传就不渲染菜单（管理模式下用不到）。 */
  actions?: SessionRowActions;
};

export function SessionList({
  sessions,
  activeId,
  onOpen,
  selectable = false,
  selected,
  onToggle,
  actions,
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
          selectable={selectable}
          checked={selected?.has(sessionKey(session)) ?? false}
          onToggle={onToggle}
          actions={actions}
        />
      ))}
    </div>
  );
}

function SessionButton({
  session,
  active,
  onOpen,
  selectable,
  checked,
  onToggle,
  actions,
}: {
  session: AgentSession;
  active: boolean;
  selectable: boolean;
  checked: boolean;
} & Pick<Props, "onOpen" | "onToggle" | "actions">) {
  const stats = statsOf(session);
  const renaming = actions?.renameId === session.id;
  const row = (
    <button
      type="button"
      // 悬停提示只留会话名与 id 之外的两句：路径已经不显示了，别在 tooltip 里又塞一遍。
      title={session.title}
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
          {renaming && actions ? (
            <RenameField
              value={session.title}
              onSubmit={(name) => actions.onRenameSubmit(session, name)}
              onCancel={actions.onRenameCancel}
            />
          ) : (
            <span className="truncate text-xs text-foreground">
              {session.title}
            </span>
          )}
          {session.parentId !== null ? (
            <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] leading-4 text-muted-foreground">
              子代理
            </span>
          ) : null}
        </span>
        {/* 路径不再显示：换成这个会话「聊了多少、多大、什么时候」——
            这三样比路径更能帮人认出是哪一场。 */}
        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="shrink-0">{turnsLabel(stats.turns)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{tokensLabel(stats.tokens)}</span>
          <span aria-hidden>·</span>
          <span className="truncate">
            {lastTalkedDayLabel(Date.now(), stats.lastAtMs)}
          </span>
        </span>
      </span>
    </button>
  );

  if (!actions || selectable || renaming) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={() => actions.onOpen(session)}>
          打开
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.onCopyAbsolute(session)}>
          复制绝对路径
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!actions.canCopyRelative}
          onSelect={() => actions.onCopyRelative(session)}
        >
          复制相对路径
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onCopyId(session)}>
          复制会话 id
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.onStartRename(session)}>
          改会话名…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** 就地改名：回车提交、Esc 取消、失焦也算提交（跟文件重命名一个手感）。 */
function RenameField({
  value,
  onSubmit,
  onCancel,
}: {
  value: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // 进来就选中原名：改名多半是「改掉一部分」，不是从空白重打。
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          done.current = true;
          onSubmit(draft);
        } else if (event.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) onSubmit(draft);
      }}
      className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0 text-xs text-foreground outline-none focus:border-foreground/40"
    />
  );
}
