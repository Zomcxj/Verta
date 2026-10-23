import type { AgentTool } from "./types";

/** The supported agents. Adding a tool means editing this list only: the session
 * list and the project row's new-session action both read it. */
export const AGENT_TOOLS: AgentTool[] = ["opencode", "pi"];