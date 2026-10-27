import { useT } from "@/modules/i18n";
import {
  AgentStateDot,
  countAgentPhases,
  useAgentActivityStore,
} from "@/modules/terminal";
import { useShallow } from "zustand/react/shallow";

/**
 * How many sessions are waiting on the user.
 *
 * The tab strip says which session and what it is doing; this says how many, which is the part
 * a small window hides: with the tabs scrolled out of view the dots cannot be counted, and a
 * session that starts asking for something should not need a search to notice. It carries the
 * same dot the tab does, so the count and the chip read as one thing, and nothing is rendered
 * when nothing is waiting.
 *
 * A count of sessions that are merely *working* was here as well and is deliberately gone: the
 * running dot on each tab already says which sessions are busy, and how many of them there are
 * is not something the user acts on.
 */
export function AgentActivityBadge() {
  const t = useT();
  const counts = useAgentActivityStore(
    useShallow((state) => countAgentPhases(state.phases)),
  );
  if (counts.attention === 0) return null;
  const waiting = t("header.agentWaiting", { count: counts.attention });
  return (
    <span
      data-agent-counts
      title={waiting}
      className="hidden shrink-0 items-center gap-2 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground tabular-nums sm:flex"
    >
      <span className="flex items-center gap-1">
        <AgentStateDot state="attention" />
        {waiting}
      </span>
    </span>
  );
}