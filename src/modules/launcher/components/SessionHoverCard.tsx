import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  cardPlacement,
  type CardAnchor,
  type CardPlacement,
} from "../lib/cardPlacement";
import type { AgentSession } from "../lib/types";
import { AgentIcon } from "../lib/agentIcon";
import { SessionFacts } from "./SessionFacts";

/** The card never asks for children; a shared empty list keeps it from making one on every render. */
const NO_SUBAGENTS: readonly AgentSession[] = [];

type Props = {
  session: AgentSession;
  /** The row this card is anchored to, in viewport coordinates; null while nothing is hovered. */
  anchor: CardAnchor | null;
  /** The id a row points at with `aria-describedby`. */
  id: string;
};

/**
 * The details of one session row, as **one** card that moves.
 *
 * Deliberately not a tooltip per row: switching rows moves this element from one row to the next
 * with a transition on its `transform`, so the eye follows a panel along the list instead of
 * watching one panel leave and another arrive. That is the part of the edge-dock reference that
 * survives here - its bubble is one native window moved by a spring, and this is one element moved
 * by a transition, which is the same idea at this scale.
 *
 * It is drawn for a row in either density and in either mode, including the manage view: the row
 * itself says as little as a title, and "what is this session" is asked by hovering rather than by
 * opening something first. The facts come from `SessionFacts`, the same block the dialog draws, so
 * the two cannot disagree.
 *
 * A glance, not a record: the id, the directory, the usage, and the parent for a subagent. What a
 * session started is the dialog's answer - the card cannot scroll (it takes no pointer events, or it
 * would keep itself open), and a list it cannot scroll is a list it should not start.
 *
 * Placement is measured before it is shown: the card is committed invisible, its own size is read in
 * the same layout pass, and both the position and the transition are applied before the browser
 * paints. So it is never seen at the window's corner, and the first placement does not animate -
 * only a move between rows does.
 *
 * The text is keyed by session id, so the content of the card fades in when it changes while the
 * card itself keeps moving: a row's details are replaced, the panel is not.
 */
export function SessionHoverCard({ session, anchor, id }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<CardPlacement | null>(null);
  // Switched on a frame after the first placement. Set in the same commit as the transform, the
  // transition is already in effect when the transform changes, and the browser interpolates from
  // `transform: none` - the card flies in from the window's corner. A frame later there is nothing to
  // interpolate from: it is simply where the row is, and only a move to another row animates.
  const [ready, setReady] = useState(false);

  // The effect reads the anchor's numbers rather than the object: the list hands over a fresh object
  // on every render, and re-measuring on each of those would be work with no answer to give.
  const anchorTop = anchor?.top ?? null;
  const anchorLeft = anchor?.left ?? null;
  const anchorRight = anchor?.right ?? null;
  const sessionId = session.id;
  useLayoutEffect(() => {
    const el = ref.current;
    if (
      anchorTop === null ||
      anchorLeft === null ||
      anchorRight === null ||
      el === null
    ) {
      return;
    }
    // Read on purpose: another row's details are another height, and the effect has to run again to
    // put the card in the right place for it.
    void sessionId;
    const rect = el.getBoundingClientRect();
    setPlacement(
      cardPlacement(
        { top: anchorTop, left: anchorLeft, right: anchorRight },
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchorTop, anchorLeft, anchorRight, sessionId]);

  // One frame between the placement and the transition: the first paint has the card already where
  // the row is and nothing to animate from, which is the difference between appearing and flying in.
  useEffect(() => {
    if (placement === null || ready) return;
    const frame = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(frame);
  }, [placement, ready]);

  // Nothing is hovered: the card goes away and forgets where it was, so the next hover starts
  // without a slide in from the last row.
  useEffect(() => {
    if (anchor !== null) return;
    setPlacement(null);
    setReady(false);
  }, [anchor]);

  const shown = anchor !== null && placement !== null;

  return createPortal(
    <div
      ref={ref}
      id={id}
      data-hover-card
      data-ready={ready}
      // As wide as its own content and no wider than 19rem: `w-max` with a `max-w` is
      // min(max-content, cap), which is the width the facts actually ask for. A fixed width either
      // crammed a long directory or floated in empty space beside a short one - and so did a minimum
      // width, which in practice is what bound it (measured: the content wanted 170px and a 13rem
      // floor drew 208px). The widest line is the facts block, whose values break anywhere, so
      // nothing needs a floor to stay legible. The placement measures this width before the card is
      // shown, so one that would run past the window goes to the other side of the row instead of
      // being squeezed.
      className="verta-compact-card verta-float verta-float-mask pointer-events-none fixed top-0 left-0 z-50 flex w-max max-w-[19rem] flex-col rounded-xl bg-popover px-2.5 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg ring-1 ring-foreground/5 dark:ring-foreground/10"
      style={{
        transform:
          placement === null
            ? undefined
            : `translate(${placement.x}px, ${placement.y}px)`,
        opacity: shown ? 1 : 0,
      }}
    >
      <div
        key={session.id}
        data-hover-card-body
        // No `items-start` and no `w-full`: the children stretch to whatever width the card settled
        // on, which is what lets the title wrap instead of widening the card. With items-start each
        // child is sized to its own content and a long title simply overflowed.
        className="verta-compact-card-body flex min-w-0 flex-col gap-1"
      >
        {/* Two lines at most: a session's name is the one thing the row may have truncated, so the
            card has to show enough of it to be recognisable, and a title that wraps further would
            make the card's height a property of how someone happened to name a session. */}
        <span className="flex min-w-0 items-start gap-1.5 font-medium">
          <AgentIcon
            agent={session.tool}
            size={13}
            className="mt-0.5 shrink-0 text-muted-foreground"
          />
          <span className="line-clamp-2 min-w-0">{session.title}</span>
        </span>
        {/* Id, directory, usage - and the parent, only on a subagent's row. The agent is the icon on
            the row this card belongs to; the subagents a session started, and where it came from, are
            the dialog's job. */}
        <SessionFacts session={session} subagents={NO_SUBAGENTS} />
      </div>
    </div>,
    document.body,
  );
}
