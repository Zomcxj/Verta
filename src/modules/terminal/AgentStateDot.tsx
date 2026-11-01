import { cn } from "@/lib/utils";
import { type MessageKey, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type AgentStateDot as AgentState,
  DOT_BG,
  MARQUEE_SWEEP_BG,
  MARQUEE_TRACK_BG,
  type StateColourToken,
} from "./agentStateColours";

/**
 * The vocabulary itself - which states exist, and the colour each one starts on - lives in
 * `agentStateColours.ts`, a module that imports nothing, because the settings store reads those
 * defaults while it is being built and this file reads that store. It is re-stated here rather than
 * re-exported, because a re-export of a name cannot share it with the component of the same name
 * (which is what a type and a function may do when both are declared here). Every surface that
 * already speaks about a state goes on getting it from the surface that draws it.
 */
export type AgentStateDot = AgentState;

/**
 * The parts of a marker that its colour has nothing to do with.
 *
 * `verta-state-breathe` is the animation and `verta-state-indicator` is the marker the stylesheet
 * looks for when it decides whether the window being seen matters: an indicator keeps moving while
 * the window is on screen and stops when nobody can see it. Those two are the same for every state
 * and every colour, which is why they are strings of their own rather than a column in a table.
 */
export const DOT_MARKER_CLASS = "verta-state-breathe verta-state-indicator";
export const MARQUEE_TRACK_MARKER_CLASS = "verta-state-indicator";
export const MARQUEE_SWEEP_ANIMATION_CLASS = "verta-state-marquee";

const STATE_LABEL: Record<AgentStateDot, MessageKey> = {
  attention: "tabs.agentState.attention",
  working: "tabs.agentState.working",
  idle: "tabs.agentState.idle",
  finished: "tabs.agentState.finished",
  // Deliberately not "working": a process that exists is all we know.
  background: "tabs.agentState.background",
  trailing: "tabs.agentState.trailing",
};

/** The state's wording, for any surface that needs to say it in words. */
export function agentStateLabelKey(state: AgentStateDot): MessageKey {
  return STATE_LABEL[state];
}

/**
 * The colour one state is drawn in at this moment.
 *
 * There is no fallback here on purpose. The stored table is repaired one state at a time when it is
 * read (`coerceAgentStateColours`), so a state without a colour is not a case this can be handed -
 * and having that answer in one place is worth more than having it in three.
 */
function useStateColour(state: AgentStateDot): StateColourToken {
  return usePreferencesStore((s) => s.agentStateColours[state]);
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
  const colour = useStateColour(state);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the dot is decorative and its label is a hint next to the session's own name; an image role would add a second announcement
    <span
      aria-label={t(agentStateLabelKey(state))}
      data-agent-state={state}
      data-agent-colour={colour}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        DOT_BG[colour],
        DOT_MARKER_CLASS,
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
 * comes from the same preference and the same two strings the dot's does, so the two surfaces cannot
 * describe one session two different ways.
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
  const colour = useStateColour(state);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the bar is decorative and its label is a hint next to the session's own name; an image role would add a second announcement
    <span
      aria-label={t(agentStateLabelKey(state))}
      data-agent-state={state}
      data-agent-colour={colour}
      data-agent-marquee
      className={cn(
        "relative h-1 w-6 shrink-0 overflow-hidden rounded-full",
        MARQUEE_TRACK_BG[colour],
        MARQUEE_TRACK_MARKER_CLASS,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 w-2 rounded-full",
          MARQUEE_SWEEP_BG[colour],
          MARQUEE_SWEEP_ANIMATION_CLASS,
        )}
      />
    </span>
  );
}
