import { useT } from "@/modules/i18n";
import { countAgentPhases, useAgentActivityStore } from "@/modules/terminal";
import { useShallow } from "zustand/react/shallow";

/**
 * How many sessions are waiting on the user and how many are working.
 *
 * The tab strip says which session and what it is doing; this says how many, which
 * is the part a small window hides: with the tabs scrolled out of view the dots
 * cannot be counted, and a session that starts asking for something should not need
 * a search to notice. Each part carries the same dot the tab does, so the count and
 * the chip read as one thing, and nothing is rendered when nothing is running.
 */
export function AgentActivityBadge() {
  const t = useT();
  const counts = useAgentActivityStore(
    useShallow((state) => countAgentPhases(state.phases)),
  );
  if (counts.attention === 0 && counts.working === 0) return null;
  const waiting = t("header.agentWaiting", { count: counts.attention });
  const working = t("header.agentWorking", { count: counts.working });
  const label = [
    counts.attention > 0 ? waiting : null,
    counts.working > 0 ? working : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      data-agent-counts
      title={label}
      className="hidden shrink-0 items-center gap-2 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground tabular-nums sm:flex"
    >
      {counts.attention > 0 ? (
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="size-1.5 rounded-full bg-amber-500 verta-attention-pulse"
          />
          {waiting}
        </span>
      ) : null}
      {counts.working > 0 ? (
        <span className="flex items-center gap-1">
          <span aria-hidden className="size-1.5 rounded-full bg-sky-500" />
          {working}
        </span>
      ) : null}
    </span>
  );
}