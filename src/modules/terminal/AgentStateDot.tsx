import { cn } from "@/lib/utils";
import { type MessageKey, useT } from "@/modules/i18n";

/**
 * The states a live agent session can be in, as the activity store spells them.
 *
 * This lives in the terminal module because more than one surface draws it: the tab strip marks
 * its tabs with it and the session list marks its rows with it, and the colour and the wording of
 * a state have to be the same in both or the two places would describe one session two different
 * ways.
 *
 * Four colours, one of them a mix. `working` and `idle` are two states and one colour
 * because neither is news about the user, and `idle` and `finished` are two states and one colour
 * because a turn that ended and an agent sitting back down at its prompt are the same thing to look
 * at: green says an agent is there and nothing is in flight, and it goes on saying it until the next
 * turn starts. Which of them it is only matters to the wording, and to the store, where the latch
 * that says "an ending nobody has looked at yet" is kept - that latch is what the tray icon and the
 * notifications read, and it is not drawn here.
 *
 * `trailing` is the mix, and deliberately so: a turn that ended with the tool's own background work
 * still running is both halves of the vocabulary at once - nothing is being thought about (green),
 * something is still running (orange) - and picking either one of them would say something untrue.
 */
export type AgentStateDot =
  | "attention"
  | "working"
  | "idle"
  | "finished"
  | "background"
  | "trailing";

/**
 * The colour a state is drawn in, as the bare token, so that one table is the single answer and a
 * test can pin it. A question is blue, work in flight is orange, an agent at rest - however it got
 * there - is green, and a turn that has ended with its tool's own work still running is purple: it
 * is neither of the two states it sits between, and every attempt to draw it as both at once said
 * the wrong thing (see `DOT_CLASS`).
 */
export const STATE_COLOUR: Record<AgentStateDot, string> = {
  attention: "sky-500",
  working: "orange-500",
  idle: "emerald-500",
  finished: "emerald-500",
  // A live process the window cannot see inside. Orange because "an agent is here" is what orange
  // means; a fourth colour would make the vocabulary ask the reader for one more distinction.
  background: "orange-500",
  trailing: "purple-500",
};

/**
 * The classes each state is drawn with.
 *
 * Written out rather than assembled from `STATE_COLOUR`: Tailwind reads class names out of the
 * source as text, so a name it cannot see does not exist. The two tables are kept in step by the
 * test beside this file, not by a template string.
 *
 * `verta-state-breathe` is the animation and `verta-state-indicator` is the marker the stylesheet
 * looks for when it decides whether the window being seen matters: an indicator keeps moving while
 * the window is on screen and stops when nobody can see it.
 *
 * The state that is neither working nor at rest has a colour of its own, and it took three attempts
 * to settle that, each decided by the person who has to look at it:
 *
 * - a gradient from orange to green read as khaki, which is what that blend is: orange (hue 48) and
 *   green (hue 162) interpolate through the yellows, and on a dot six pixels across the transition
 *   is most of the marker, so neither colour is ever seen at its own strength.
 * - a hard stop inside the dot at 65% of its radius read as the wrong way round: a ring one pixel
 *   thick on a six pixel dot is 58% of its area, so what the eye saw was a green dot with an orange
 *   middle however the two were named.
 * - an orange dot with one pixel of green around it was a ring, and was still not what was wanted.
 *
 * So it is drawn in a colour nothing else uses. The lesson written down rather than the sequence:
 * on a marker this small, two colours cannot both be read, and a state that means two things at once
 * is better told apart by a colour of its own than by a picture of the two.
 */
export const DOT_CLASS: Record<AgentStateDot, string> = {
  attention: "bg-sky-500 verta-state-breathe verta-state-indicator",
  working: "bg-orange-500 verta-state-breathe verta-state-indicator",
  idle: "bg-emerald-500 verta-state-breathe verta-state-indicator",
  finished: "bg-emerald-500 verta-state-breathe verta-state-indicator",
  background: "bg-orange-500 verta-state-breathe verta-state-indicator",
  trailing: "bg-purple-500 verta-state-breathe verta-state-indicator",
};

const STATE_LABEL: Record<AgentStateDot, MessageKey> = {
  attention: "tabs.agentState.attention",
  working: "tabs.agentState.working",
  idle: "tabs.agentState.idle",
  finished: "tabs.agentState.finished",
  // Deliberately not "working": a process that exists is all we know.
  background: "tabs.agentState.background",
  trailing: "tabs.agentState.trailing",
};

/**
 * The bar's own colour - the state's colour, held back - and the sweep's.
 *
 * Two tables because a bar and the highlight crossing it are drawn by two elements, and Tailwind
 * reads class names as text. Both are held to `STATE_COLOUR` by the test beside this file.
 *
 * Every state's bar is its own colour, held back: the bed at a quarter and the light crossing it at
 * full strength. The state that is neither working nor at rest is purple here for the same reason
 * it is purple on the dot, and this is the same table read by the other surface.
 */
export const MARQUEE_TRACK_CLASS: Record<AgentStateDot, string> = {
  attention: "bg-sky-500/25 verta-state-indicator",
  working: "bg-orange-500/25 verta-state-indicator",
  idle: "bg-emerald-500/25 verta-state-indicator",
  finished: "bg-emerald-500/25 verta-state-indicator",
  background: "bg-orange-500/25 verta-state-indicator",
  trailing: "bg-purple-500/25 verta-state-indicator",
};

export const MARQUEE_SWEEP_CLASS: Record<AgentStateDot, string> = {
  attention: "bg-sky-500 verta-state-marquee",
  working: "bg-orange-500 verta-state-marquee",
  idle: "bg-emerald-500 verta-state-marquee",
  finished: "bg-emerald-500 verta-state-marquee",
  background: "bg-orange-500 verta-state-marquee",
  trailing: "bg-purple-500 verta-state-marquee",
};

/** The state's wording, for any surface that needs to say it in words. */
export function agentStateLabelKey(state: AgentStateDot): MessageKey {
  return STATE_LABEL[state];
}

/** One session's state as a dot. */
export function AgentStateDot({
  state,
  className,
}: {
  state: AgentStateDot;
  className?: string;
}) {
  const t = useT();
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the dot is decorative and its label is a hint next to the session's own name; an image role would add a second announcement
    <span
      aria-label={t(agentStateLabelKey(state))}
      data-agent-state={state}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        DOT_CLASS[state],
        className,
      )}
    />
  );
}

/**
 * The same state as a bar with a highlight crossing it.
 *
 * The session list draws this rather than the dot: a row's state sits beside its name at the same
 * weight as the name itself, and a bar that is moving is legible out of the corner of an eye in a
 * way a six-pixel dot is not. It is a second drawing of one table, not a second table - the colour
 * and the marker come from the same place the dot's do, so the two surfaces cannot describe one
 * session two different ways.
 *
 * The track carries `verta-state-indicator` (so an unseen window stops it with everything else) and
 * the sweep inside it carries the animation.
 */
export function AgentStateMarquee({
  state,
  className,
}: {
  state: AgentStateDot;
  className?: string;
}) {
  const t = useT();
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the bar is decorative and its label is a hint next to the session's own name; an image role would add a second announcement
    <span
      aria-label={t(agentStateLabelKey(state))}
      data-agent-state={state}
      data-agent-marquee
      className={cn(
        "relative h-1 w-6 shrink-0 overflow-hidden rounded-full",
        MARQUEE_TRACK_CLASS[state],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 w-2 rounded-full",
          MARQUEE_SWEEP_CLASS[state],
        )}
      />
    </span>
  );
}