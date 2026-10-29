import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AgentStateMarquee, type AgentStateDot as AgentState } from "@/modules/terminal/AgentStateDot";
import { useLanguage, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { SessionListDensity } from "@/modules/settings/store";
import { AgentIcon } from "../lib/agentIcon";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { memo, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { sessionKey } from "../lib/selection";
import {
  lastTalkedDayLabel,
  statsLine,
  statsOf,
  tokensLabel,
  turnsLabel,
} from "../lib/sessionStats";
import type { AgentSession } from "../lib/types";

/** Everything the context-menu items need. Paths are computed by the UI: a relative
 *  path against the session cwd's parent is meaningless, so it is resolved against the
 *  current workspace root, and without a root only the absolute path is offered. */
export type SessionRowActions = {
  onOpen: (session: AgentSession) => void;
  onCopyAbsolute: (session: AgentSession) => void;
  onCopyRelative: (session: AgentSession) => void;
  onCopyId: (session: AgentSession) => void;
  onStartRename: (session: AgentSession) => void;
  /** False when no relative path can be computed (no workspace root), greying out that item. */
  canCopyRelative: boolean;
  renameId: string | null;
  onRenameSubmit: (session: AgentSession, name: string) => void;
  onRenameCancel: () => void;
};

type Props = {
  sessions: readonly AgentSession[];
  activeId: string | null;
  /** Live state per session id, for the sessions running in a tab right now. */
  states?: ReadonlyMap<string, AgentState>;
  onOpen: (session: AgentSession) => void;
  /** Managing turns a row into a checkbox: clicking it selects, not opens. */
  selectable?: boolean;
  selected?: ReadonlySet<string>;
  onToggle?: (session: AgentSession) => void;
  /** Context menu and in-place rename; omitted means no menu (not needed in manage mode). */
  actions?: SessionRowActions;
};

/**
 * One row per session. The list is memoised together with the row: a session row carries a context
 * menu, and in the compact density a tooltip as well, with the popper layers behind them, which is a
 * dozen Radix components per row - and the panel around this list re-renders for reasons that have
 * nothing to do with the rows (a tab switch, the query box, managing mode). `LauncherPanel` keeps the
 * props it hands down stable so this holds.
 */
export const SessionList = memo(function SessionList({
  sessions,
  activeId,
  states,
  onOpen,
  selectable = false,
  selected,
  onToggle,
  actions,
}: Props) {
  const t = useT();
  const density = usePreferencesStore((s) => s.sessionListDensity);
  if (sessions.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground">
        {selectable ? t("launcher.emptySelectable") : t("launcher.empty")}
      </div>
    );
  }
  return (
    // Which density was drawn, the way a row carries `data-session-id`: a probe measuring the two
    // modes has to know which one it is looking at, and counting lines is a guess.
    <div data-session-density={density} className="flex flex-col gap-0.5 px-1.5 pb-2">
      {sessions.map((session) => (
        <SessionButton
          key={sessionKey(session)}
          session={session}
          active={session.id === activeId}
          density={density}
          state={states?.get(session.id) ?? null}
          onOpen={onOpen}
          selectable={selectable}
          checked={selected?.has(sessionKey(session)) ?? false}
          onToggle={onToggle}
          actions={actions}
        />
      ))}
    </div>
  );
});

const SessionButton = memo(function SessionButton({
  session,
  active,
  density,
  state,
  onOpen,
  selectable,
  checked,
  onToggle,
  actions,
}: {
  session: AgentSession;
  active: boolean;
  /** How much this row says at rest; see `SessionListDensity`. */
  density: SessionListDensity;
  /** This session's live state, or null when nothing is running for it. */
  state: AgentState | null;
  selectable: boolean;
  checked: boolean;
} & Pick<Props, "onOpen" | "onToggle" | "actions">) {
  const t = useT();
  const language = useLanguage();
  const stats = statsOf(session);
  const renaming = actions?.renameId === session.id;
  const row = (
    <button
      type="button"
      // The session's own id, the way a tab carries `data-tab-id`: a probe (and a
      // person reading the DOM) can tell which row is which without guessing from
      // the title.
      data-session-id={session.id}
      // The tooltip keeps only the session title: the path is no longer shown, so it must
      // not sneak back in through a tooltip. Except in the compact row, which has a popup of
      // its own: two popups on one hover, and the native one knowing only the title, is worse
      // than the one.
      title={density === "standard" ? session.title : undefined}
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
          {/* The running light for this session's agent, in the same colour the tab strip
              would draw: a bar reads as a state from across the window where a dot at this
              row's weight is easy to miss, and it is only drawn where there is an agent. */}
          {state !== null ? <AgentStateMarquee state={state} /> : null}
          {session.parentId !== null ? (
            <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] leading-4 text-muted-foreground">
              {t("launcher.subagent")}
            </span>
          ) : null}
        </span>
        {/* The path is gone: show how much this session talked about, how big it is,
            and when instead: these identify a session better than a path. The compact row
            keeps them, one hover away, so nothing is lost by hiding the line. */}
        {density === "standard" ? (
          <span
            data-session-meta=""
            className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground"
          >
            <span className="shrink-0">{turnsLabel(stats.turns, language)}</span>
            <span aria-hidden>·</span>
            <span className="shrink-0">{tokensLabel(stats.tokens, language)}</span>
            <span aria-hidden>·</span>
            <span className="truncate">
              {lastTalkedDayLabel(Date.now(), stats.lastAtMs, language)}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  );

  const trigger =
    actions && !selectable && !renaming ? (
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
    ) : (
      row
    );

  // The two triggers have to land on the same element, so their `asChild` slots are chained and
  // the row is the only thing at the end of that chain. A Root that renders nothing cannot sit
  // between them: the props would be merged onto it and never reach the row.
  const body =
    density === "compact" ? (
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        {/* The sheet behind this is a one-line pill (`inline-flex` / `items-center`), so the three
            lines have to be told to stack. */}
        <TooltipContent
          side="right"
          className="max-w-72 flex-col items-start gap-0.5 text-[11px] leading-relaxed"
        >
          <span className="font-medium">{session.title}</span>
          <span>{statsLine(stats, Date.now(), language)}</span>
          <span className="break-all opacity-80">{session.cwd}</span>
        </TooltipContent>
      </Tooltip>
    ) : (
      trigger
    );

  if (!actions || selectable || renaming) return body;

  return (
    <ContextMenu>
      {body}
      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={() => actions.onOpen(session)}>
          {t("launcher.open")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.onCopyAbsolute(session)}>
          {t("launcher.copyAbsPath")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!actions.canCopyRelative}
          onSelect={() => actions.onCopyRelative(session)}
        >
          {t("launcher.copyRelPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onCopyId(session)}>
          {t("launcher.copySessionId")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.onStartRename(session)}>
          {t("launcher.renameSession")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

/** In-place rename: Enter commits, Esc cancels, and blur also commits (the same feel
 * as renaming a file). */
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
  // Select the existing name on entry: renaming usually means changing part of it, not
  // retyping from scratch.
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
