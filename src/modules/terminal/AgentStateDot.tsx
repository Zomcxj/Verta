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
 * There are three colours and four states. `working` and `idle` are two states and one colour
 * because neither is news about the user, and `idle` and `finished` are two states and one colour
 * because a turn that ended and an agent sitting back down at its prompt are the same thing to look
 * at: green says an agent is there and nothing is in flight, and it goes on saying it until the next
 * turn starts. Which of them it is only matters to the wording, and to the store, where the latch
 * that says "an ending nobody has looked at yet" is kept - that latch is what the tray icon and the
 * notifications read, and it is not drawn here.
 */
export type AgentStateDot = "attention" | "working" | "idle" | "finished";

/**
 * The colour a state is drawn in, as the bare token, so that one table is the single answer and a
 * test can pin it. A question is blue, work in flight is orange, and an agent at rest - however it
 * got there - is green.
 */
export const STATE_COLOUR: Record<
  AgentStateDot,
  "sky-500" | "orange-500" | "emerald-500"
> = {
  attention: "sky-500",
  working: "orange-500",
  idle: "emerald-500",
  finished: "emerald-500",
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
 */
export const DOT_CLASS: Record<AgentStateDot, string> = {
  attention: "bg-sky-500 verta-state-breathe verta-state-indicator",
  working: "bg-orange-500 verta-state-breathe verta-state-indicator",
  idle: "bg-emerald-500 verta-state-breathe verta-state-indicator",
  finished: "bg-emerald-500 verta-state-breathe verta-state-indicator",
};

const STATE_LABEL: Record<AgentStateDot, MessageKey> = {
  attention: "tabs.agentState.attention",
  working: "tabs.agentState.working",
  idle: "tabs.agentState.idle",
  finished: "tabs.agentState.finished",
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
      aria-label={t(DOT_LABEL[state])}
      data-agent-state={state}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        DOT_CLASS[state],
        className,
      )}
    />
  );
}