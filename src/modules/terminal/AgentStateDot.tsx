import { cn } from "@/lib/utils";
import { type MessageKey, useT } from "@/modules/i18n";

/**
 * The four states a live agent session can be in, as the activity store spells
 * them.
 *
 * This lives in the terminal module because more than one surface draws it: the
 * tab strip marks its tabs with it and the session list marks its rows with it,
 * and the colour and the wording of a state have to be the same in both or the
 * two places would describe one session two different ways.
 */
export type AgentStateDot = "attention" | "working" | "finished" | "idle";

/**
 * A question it is waiting on is amber, work in flight is sky, a turn that just
 * finished is green, and an agent sitting at its prompt is a quiet grey. The
 * pulse on the amber dot is the finite one the stylesheet already defines for a
 * waiting approval, so a session that stays blocked does not animate for as long
 * as it sits there (see the motion budget in VERTA.md).
 */
const DOT_CLASS: Record<AgentStateDot, string> = {
  attention: "bg-amber-500 verta-attention-pulse",
  working: "bg-sky-500",
  finished: "bg-emerald-500",
  idle: "bg-muted-foreground/50",
};

const DOT_LABEL: Record<AgentStateDot, MessageKey> = {
  attention: "tabs.agentState.attention",
  working: "tabs.agentState.working",
  finished: "tabs.agentState.finished",
  idle: "tabs.agentState.idle",
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