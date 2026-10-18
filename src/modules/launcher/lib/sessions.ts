import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSessionsPayload,
  AgentTool,
  DeleteReport,
  SessionTarget,
  WireAgentSessionsPayload,
} from "./types";

/**
 * `distro` picks whose store to read: `null` is this machine, a name is that
 * WSL distro's, which the backend reads by running the query inside it. The
 * source is stamped on every row here, so a row can never travel on without
 * the distro it belongs to.
 */
export function listAgentSessions(
  tool: AgentTool,
  distro: string | null,
): Promise<AgentSessionsPayload> {
  return invoke<WireAgentSessionsPayload>("agent_sessions_list", {
    tool,
    distro,
  }).then((payload) => ({
    sessions: payload.sessions.map((session) => ({ ...session, distro })),
    warnings: payload.warnings,
  }));
}

/** Removing sessions is permanent, so the backend re-reads its store before it
 * reports one as deleted. */
export function deleteAgentSessions(
  targets: SessionTarget[],
): Promise<DeleteReport> {
  return invoke<DeleteReport>("agent_sessions_delete", { targets });
}