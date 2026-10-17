import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSessionsPayload,
  AgentTool,
  DeleteReport,
  SessionTarget,
} from "./types";

export function listAgentSessions(
  tool: AgentTool,
): Promise<AgentSessionsPayload> {
  return invoke<AgentSessionsPayload>("agent_sessions_list", { tool });
}

/** Removing sessions is permanent, so the backend re-reads its store before it
 * reports one as deleted. */
export function deleteAgentSessions(
  targets: SessionTarget[],
): Promise<DeleteReport> {
  return invoke<DeleteReport>("agent_sessions_delete", { targets });
}
