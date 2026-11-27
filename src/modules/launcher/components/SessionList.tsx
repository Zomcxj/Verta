import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  AgentStateMarquee,
  type AgentStateDot as AgentState,
} from "@/modules/terminal/AgentStateDot";
import { useLanguage, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { SessionListDensity } from "@/modules/settings/store";
import { AgentIcon } from "../lib/agentIcon";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { parentCountKey } from "../lib/sessionInfo";
import { type SessionKey, sessionKey } from "../lib/selection";
import {
  lastTalkedDayLabel,
  statsOf,
  tokensLabel,
  turnsLabel,
} from "../lib/sessionStats";
import type { AgentSession } from "../lib/types";
import { SessionHoverCard } from "./SessionHoverCard";
import type { CardAnchor } from "../lib/cardPlacement";

/** Everything the context-menu items need. Paths are computed by the UI: a relative
 *  path against the session cwd's parent is meaningless, so it is resolved against the
 *  current workspace root, and without a root only the absolute path is offered. */
export type SessionRowActions = {
  onOpen: (session: AgentSession) => void;
  /** Place this session in its own git worktree and open it there. */
  onWorktree?: (session: AgentSession) => void;
  onCopyAbsolute: (session: AgentSession) => void;
  onCopyRelative: (session: AgentSession) => void;
  onCopyId: (session: AgentSession) => void;
  /** Open the details dialog for this session. */
  onInfo: (session: AgentSession) => void;
  /** False when no relative path can be computed (no workspace root), greying out that item. */
  canCopyRelative: boolean;
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
  /** Context menu; omitted means no menu. */
  actions?: SessionRowActions;
  /** The sessions filed under each one, for the manage view's row badges. */
  subagentsByParent?: ReadonlyMap<string, readonly AgentSession[]>;
  /**
   * Nothing has been read yet. An empty list and an unread one are different things: saying "no
   * sessions" while the first read is still running is a claim nobody has checked.
   */
  reading?: boolean;
};

/**
 * One row per session. The list is memoised together with the row: a session row carries a context
 * menu, and the list carries one hover card with the popper layers behind the menu, which is a dozen
 * Radix components per row - and the panel around this list re-renders for reasons that have nothing
 * to do with the rows (a tab switch, the query box, managing mode). `LauncherPanel` keeps the props
 * it hands down stable so this holds.
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
  subagentsByParent,
  reading = false,
}: Props) {
  const t = useT();
  const density = usePreferencesStore((s) => s.sessionListDensity);
  const cardId = useId();
  /**
   * Which row the card is anchored to, and where that row is on screen.
   *
   * One card for the whole list, so moving between rows moves it. The row is held by key rather than
   * by object, so a read that lands while the pointer rests - the watcher fires on its own - draws
   * the session as it is now instead of as it was when the pointer arrived; a row that is gone after
   * that read takes the card with it. The row element itself is kept as well, because a scroll moves
   * the row without any pointer event: the anchor is recomputed from the element, not remembered as
   * a number.
   */
  const [hovered, setHovered] = useState<{
    key: SessionKey;
    anchor: CardAnchor;
  } | null>(null);
  const hoveredRowRef = useRef<HTMLElement | null>(null);
  const hoverRow = useCallback((session: AgentSession, el: HTMLElement) => {
    hoveredRowRef.current = el;
    setHovered({ key: sessionKey(session), anchor: rowAnchor(el) });
  }, []);
  const clearRow = useCallback(() => {
    hoveredRowRef.current = null;
    setHovered(null);
  }, []);
  // A scroll under a stationary pointer moves the row the card is anchored to: the card follows it,
  // in the capture phase so any scrolling ancestor counts.
  useEffect(() => {
    if (hovered === null) return;
    const follow = () => {
      const el = hoveredRowRef.current;
      if (el === null) return;
      setHovered((was) =>
        was === null ? was : { ...was, anchor: rowAnchor(el) },
      );
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [hovered]);
  if (sessions.length === 0) {
    return (
      <div
        data-session-empty={reading ? "reading" : "empty"}
        className="px-3 py-6 text-center text-xs text-muted-foreground"
      >
        {reading
          ? t("launcher.loading")
          : selectable
            ? t("launcher.emptySelectable")
            : t("launcher.empty")}
      </div>
    );
  }
  // The card is drawn for every row, in either density and in either mode. A row says a title and,
  // in the standard density, three numbers; what a session *is* - its id, its directory, and the
  // session it belongs to - is what the card adds, one hover away wherever the list is drawn.
  // Managing included: a tick takes a parent's children along, so "which session is this" is asked
  // most often there, and it is asked by moving the pointer rather than by opening something.
  const hoveredSession =
    hovered === null
      ? null
      : (sessions.find((session) => sessionKey(session) === hovered.key) ??
        null);
  const showCard = hovered !== null && hoveredSession !== null;
  return (
    // Which density was drawn, the way a row carries `data-session-id`: a probe measuring the two
    // modes has to know which one it is looking at, and counting lines is a guess.
    <div
      data-session-density={density}
      className="flex flex-col gap-0.5 px-1.5 pb-2"
      // The pointer leaving the list is what closes the card: clearing it row by row would blink it
      // every time the pointer crossed the two-pixel gap between two rows.
      onPointerLeave={clearRow}
    >
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
          childCount={
            subagentsByParent?.get(parentCountKey(session.tool, session.id))
              ?.length ?? 0
          }
          onHover={hoverRow}
          describedBy={
            showCard && hovered?.key === sessionKey(session) ? cardId : undefined
          }
        />
      ))}
      {showCard && hovered !== null && hoveredSession !== null ? (
        <SessionHoverCard
          session={hoveredSession}
          anchor={hovered.anchor}
          id={cardId}
        />
      ) : null}
    </div>
  );
});

/** Where a row is on screen, which is what the card is anchored to. */
function rowAnchor(el: HTMLElement): CardAnchor {
  const rect = el.getBoundingClientRect();
  return { top: rect.top, left: rect.left, right: rect.right };
}


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
  childCount,
  onHover,
  describedBy,
}: {
  session: AgentSession;
  active: boolean;
  /** How much this row says at rest; see `SessionListDensity`. */
  density: SessionListDensity;
  /** This session's live state, or null when nothing is running for it. */
  state: AgentState | null;
  selectable: boolean;
  checked: boolean;
  /** Tells the list which row the card should be anchored to; the list has no card without it. */
  onHover?: (session: AgentSession, el: HTMLElement) => void;
  /** How many sessions this one started, drawn only while managing: a tick takes them along. */
  childCount: number;
  /** Set on the one row the card is describing, so a screen reader gets the details too. */
  describedBy?: string;
} & Pick<Props, "onOpen" | "onToggle" | "actions">) {
  const t = useT();
  const language = useLanguage();
  const stats = statsOf(session);
  const row = (
    <button
      type="button"
      // The session's own id, the way a tab carries `data-tab-id`: a probe (and a
      // person reading the DOM) can tell which row is which without guessing from
      // the title.
      data-session-id={session.id}
      // No native tooltip, in either density: the card that appears on hover says the title in full
      // and more, and two popups on one hover is worse than the one. What the browser said was only
      // the title, so nothing is lost.
      aria-describedby={describedBy}
      // The card follows the pointer and, for someone tabbing through the list, the focus.
      onPointerEnter={(event) => onHover?.(session, event.currentTarget)}
      onFocus={(event) => onHover?.(session, event.currentTarget)}
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
          {/* The running light for this session's agent, in the same colour the tab strip
              would draw: a bar reads as a state from across the window where a dot at this
              row's weight is easy to miss, and it is only drawn where there is an agent. */}
          {state !== null ? <AgentStateMarquee state={state} /> : null}
          {session.parentId !== null ? (
            <span className="shrink-0 rounded border border-border/60 px-1 text-[9px] leading-4 text-muted-foreground">
              {t("launcher.subagent")}
            </span>
          ) : null}
          {/* While managing, a parent says how many rows come with it: the tick removes the
              children too, and that has to be visible before the tick rather than in the dialog
              after it. */}
          {selectable && childCount > 0 ? (
            <span
              data-subagent-count={childCount}
              title={t("launcher.subagentCount", { count: childCount })}
              className="shrink-0 rounded border border-border/60 px-1 text-[9px] leading-4 text-muted-foreground"
            >
              {`↳${childCount}`}
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
            <span className="shrink-0">
              {turnsLabel(stats.turns, language)}
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0">
              {tokensLabel(stats.tokens, language)}
            </span>
            <span aria-hidden>·</span>
            <span className="truncate">
              {lastTalkedDayLabel(Date.now(), stats.lastAtMs, language)}
            </span>
          </span>
        ) : null}
      </span>
    </button>
  );

  // The row carries the context menu; the details card is not here at all. It belongs to the list,
  // because it is one card that moves - a card per row could only ever appear and disappear.
  // The menu is attached in the manage view as well. There the rows are checkboxes, so the reading
  // items are what is left of it - open would leave the mode the list was put in - but "what is this
  // session, and what will I lose" is the question the manage view exists to answer, and it has to be
  // askable from the row itself, including from a subagent's row.
  const body = actions ? (
    <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
  ) : (
    row
  );

  if (!actions) return body;

  return (
    <ContextMenu>
      {body}
      <ContextMenuContent className="min-w-44">
        {selectable ? null : (
          <>
            <ContextMenuItem onSelect={() => actions.onOpen(session)}>
              {t("launcher.open")}
            </ContextMenuItem>
            {actions.onWorktree ? (
              <ContextMenuItem
                onSelect={() => actions.onWorktree?.(session)}
              >
                {t("launcher.worktree")}
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
          </>
        )}
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
        <ContextMenuItem onSelect={() => actions.onInfo(session)}>
          {t("launcher.info")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
