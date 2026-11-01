import type { AgentTool } from "@/modules/launcher/lib/types";
import type { Tab } from "./useTabs";

/**
 * The agent this tab says it is for, or null when this tab is not one for an agent.
 *
 * One predicate for the two things that have to agree: the icon the tab draws, and whether the tab
 * earns the state marker. They were written a few lines apart in one file and still disagreed. The
 * icon asked whether `agent` was truthy; the marker asked whether it was not `null`; and a tab
 * opened any other way than "for an agent" - Ctrl+T, a block tab - does not carry the property at
 * all, so `undefined !== null` was true and every terminal tab was marked. It went unnoticed because
 * a tab that is not for an agent usually has no state in the activity store either, which hides the
 * marker for a reason of its own; the moment the judge found an agent on that tab's screen the dot
 * appeared, which is the tab the marker was asked to stop marking.
 *
 * Measured on the dev build (2026-11-01), reading `tab.agent` off the chip's own props: a Ctrl+T tab
 * is `{ kind: "terminal" }` with no `agent` key, and a tab opened for a session is
 * `{ kind: "terminal", agent: "opencode" }`.
 *
 * The case this is drawn for: a shell an agent was *typed into* is deliberately not marked - its
 * icon is still the terminal's, and the person this is drawn for asked for the two to agree
 * ("图标是 agent 的才有呼吸灯").
 */
export function tabAgentIcon(tab: Tab): AgentTool | null {
  return tab.kind === "terminal" && tab.agent ? tab.agent : null;
}
