import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * The window during which a side panel's width change is drawn as a slide instead of a jump.
 *
 * Both side panels are `react-resizable-panels` panels. Measured against this build, a 220px sidebar
 * carries its width as `flex: 16.07 1 0px` - the same `flex` shorthand a drag rewrites - so the
 * animatable number is `flex-grow` and `flex-basis` stays at 0. One CSS transition on that number is
 * the whole animation. Only while a toggle is in flight, though: dragging a divider rewrites it on
 * every pointer move, and a transition there would leave the edge trailing behind the pointer
 * instead of following it. Hence a flag that is on for exactly the length of one programmatic change.
 *
 * `flushSync` is what makes the flag land *before* the change. The transition has to be on the
 * element at the moment the width is rewritten, and a batched update would put the attribute in the
 * DOM afterwards - which is the same placement-then-transition two-step the compact session card
 * documents, for the same reason.
 *
 * The window closes on `transitionend` from the panel group; the timer is only for the case where no
 * transition ran at all, because a flag left on would make every later divider drag animate.
 */

/** Long enough for any of the duration tokens, short enough that a stuck flag corrects itself. */
const SLIDE_FALLBACK_MS = 600;

export type PanelSlide = {
  /** Whether a toggle is in flight; the group carries `data-panel-slide` while it is. */
  sliding: boolean;
  /** Runs a programmatic collapse or expand inside the animated window. */
  slide: (change: () => void) => void;
  /** Ends the window. Safe to call when nothing is sliding. */
  endSlide: () => void;
};

export function usePanelSlide(): PanelSlide {
  const [sliding, setSliding] = useState(false);
  const timerRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (!timerRef.current) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = 0;
  }, []);

  const endSlide = useCallback(() => {
    clearTimer();
    setSliding(false);
  }, [clearTimer]);

  const slide = useCallback(
    (change: () => void) => {
      clearTimer();
      flushSync(() => setSliding(true));
      change();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = 0;
        setSliding(false);
      }, SLIDE_FALLBACK_MS);
    },
    [clearTimer],
  );

  useEffect(() => clearTimer, [clearTimer]);

  return { sliding, slide, endSlide };
}
