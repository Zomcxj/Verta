import { useLanguage } from "@/modules/i18n";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  compactCardPlacement,
  type CardAnchor,
  type CardPlacement,
} from "../lib/compactCardPosition";
import { statsLine, statsOf } from "../lib/sessionStats";
import type { AgentSession } from "../lib/types";

type Props = {
  session: AgentSession;
  /** The row this card is anchored to, in viewport coordinates; null while nothing is hovered. */
  anchor: CardAnchor | null;
  /** The id a row points at with `aria-describedby`. */
  id: string;
};

/**
 * The details of one compact session row, as **one** card that moves.
 *
 * Deliberately not a tooltip per row: switching rows moves this element from one row to the next
 * with a transition on its `transform`, so the eye follows a panel along the list instead of
 * watching one panel leave and another arrive. That is the part of the edge-dock reference that
 * survives here - its bubble is one native window moved by a spring, and this is one element moved
 * by a transition, which is the same idea at this scale.
 *
 * Placement is measured before it is shown: the card is committed invisible, its own size is read in
 * the same layout pass, and both the position and the transition are applied before the browser
 * paints. So it is never seen at the window's corner, and the first placement does not animate -
 * only a move between rows does.
 *
 * The text is keyed by session id, so the content of the card fades in when it changes while the
 * card itself keeps moving: a row's details are replaced, the panel is not.
 */
export function CompactSessionCard({ session, anchor, id }: Props) {
  const language = useLanguage();
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
      compactCardPlacement(
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

  const stats = statsOf(session);
  const shown = anchor !== null && placement !== null;

  return createPortal(
    <div
      ref={ref}
      id={id}
      data-compact-card
      data-ready={ready}
      // As wide as its own content and no wider than 19rem: `w-max` with a `max-w` is
      // min(max-content, cap), which is the width the details actually ask for. A fixed width either
      // crammed a long directory or floated in empty space beside a short one - and so did a minimum
      // width, which in practice is what bound it (measured: the content wanted 170px and a 13rem
      // floor drew 208px). The widest line is the numbers, which every session has, so nothing needs
      // a floor to stay legible. The placement measures this width before the card is shown, so one
      // that would run past the window goes to the other side of the row instead of being squeezed.
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
        data-compact-card-body
        // No `items-start` and no `w-full`: the children stretch to whatever width the card settled
        // on, which is what lets the title truncate once the card has hit its cap. With items-start
        // each child is sized to its own content and a long title simply overflowed.
        className="verta-compact-card-body flex min-w-0 flex-col gap-0.5"
      >
        {/* One line: the title is what the row itself already says, and a wrapped title would make
            the card's height depend on how long someone happened to name a session. */}
        <span className="min-w-0 truncate font-medium">{session.title}</span>
        <span>{statsLine(stats, Date.now(), language)}</span>
        <span className="break-all opacity-80">{session.cwd}</span>
      </div>
    </div>,
    document.body,
  );
}
