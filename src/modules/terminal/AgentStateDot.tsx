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
 * `working` and `idle` are two states and one colour. They are not the same thing to say - an
 * agent with a turn in flight and one sitting at its prompt are different screens - but neither is
 * news about the user, so the same orange carries both and only the label beside it tells them
 * apart. Green is the one that has something to say: a turn that ended and that the user has not
 * looked at yet.
 */
export type AgentStateDot = "attention" | "working" | "idle" | "finished";

/**
 * A question is blue, work in flight and an agent at rest are both orange, and a turn that ended
 * while nobody was looking is green. All four breathe (the stepped animation in the stylesheet,
 * which stops entirely while the window is not being looked at), so a state reads from across a
 * window rather than needing a legend.
 */
const DOT_CLASS: Record<AgentStateDot, string> = {
  attention: "bg-sky-500 verta-state-breathe",
  working: "bg-orange-500 verta-state-breathe",
  idle: "bg-orange-500 verta-state-breathe",
  finished: "bg-emerald-500 verta-state-breathe",
};

const DOT_LABEL: Record<AgentStateDot, MessageKey> = {
  attention: "tabs.agentState.attention",
  working: "tabs.agentState.working",
  idle: "tabs.agentState.idle",
  finished: "tabs.agentState.finished",
};

/** The state's wording, for any surface that needs to say it in words. */
export function agentStateLabelKey(state: AgentStateDot): MessageKey {
  return DOT_LABEL[state];
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