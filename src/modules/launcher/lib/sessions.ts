import { invoke } from "@tauri-apps/api/core";
import type { AgentSessionsPayload, AgentTool } from "./types";

export function listAgentSessions(
  tool: AgentTool,
): Promise<AgentSessionsPayload> {
  return invoke<AgentSessionsPayload>("agent_sessions_list", { tool });
}
