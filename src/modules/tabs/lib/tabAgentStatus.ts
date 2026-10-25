import {
  type AgentTabStatus,
  tabAgentStatus,
  type useAgentActivityStore,
} from "@/modules/terminal/lib/agentActivity";

type ActivityState = Pick<
  ReturnType<typeof useAgentActivityStore.getState>,
  "phases" | "agents" | "leafPty"
>;

/** Shared result for tabs with no agent state (and for non-terminal tabs). */
export const NO_AGENT_STATUS: AgentTabStatus = Object.freeze({
  state: null,
  agent: null,
});

/** The ptys a tab's leaves are showing, keyed through the store's leaf map. */
export function ptyIdsForLeaves(
  state: Pick<ActivityState, "leafPty">,
  leafIds: readonly number[],
): number[] {
  const ptyIds: number[] = [];
  for (const leafId of leafIds) {
    const ptyId = state.leafPty[leafId];
    if (typeof ptyId === "number") ptyIds.push(ptyId);
  }
  return ptyIds;
}

/**
 * One tab's agent status from its leaves.
 *
 * Meant to be used as a store selector wrapped in `useShallow`, exactly like
 * `selectTabAgentStatus`: the maps change whenever *any* pty changes phase, but the
 * `{ state, agent }` pair is two primitives, so shallow equality keeps every other
 * tab from re-rendering. Deriving the ptys from the store (rather than from the
 * session registry at render time) is what lets a dot appear the moment the judge
 * reports the agent, without waiting for the tab strip to render for another reason.
 */
export function selectTabAgentStatusFromLeaves(
  state: ActivityState,
  leafIds: readonly number[],
): AgentTabStatus {
  if (leafIds.length === 0) return NO_AGENT_STATUS;
  return tabAgentStatus(
    state.phases,
    state.agents,
    ptyIdsForLeaves(state, leafIds),
  );
}

/**
 * One tab's agent status, derived from the global activity maps.
 *
 * Meant to be used as a store selector wrapped in `useShallow`: the maps change
 * whenever *any* pty changes phase, but a tab's `{ state, agent }` pair is two
 * primitives, so shallow equality keeps every other tab from re-rendering.
 * Subscribing to `phases`/`agents` directly would re-render all tabs on every
 * agent signal.
 */
export function selectTabAgentStatus(
  state: ActivityState,
  ptyIds: readonly number[],
): AgentTabStatus {
  if (ptyIds.length === 0) return NO_AGENT_STATUS;
  return tabAgentStatus(state.phases, state.agents, ptyIds);
}
