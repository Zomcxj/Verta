import { invoke } from "@tauri-apps/api/core";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { AGENT_TOOLS } from "./tools";
import type {
  AgentSession,
  AgentSessionsPayload,
  AgentTool,
  DeleteReport,
  SessionTarget,
  WireAgentSessionsPayload,
} from "./types";

/**
 * Sessions the opencode service says are in the middle of a turn.
 *
 * `null` when the question could not be asked at all - no opencode running, or one without a
 * service file - which is different from an empty list (the service answered and nothing is
 * running). The caller keeps its write times for the first case: a stopped service must not make
 * every row unmarked.
 *
 * `distro` picks whose service: each distro runs its own on its own loopback interface.
 */
export async function runningAgentSessionIds(
  distro: string | null,
): Promise<string[] | null> {
  try {
    return await invoke<string[] | null>("agent_sessions_running", { distro });
  } catch {
    return null;
  }
}

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

/**
 * Rename a session.
 *
 * Only the name changes: opencode rewrites the row in its database and pi appends a
 * `session_info` line. Both tools show the new name the next time sessions are read
 * (the backend takes the last name it sees).
 */
export function renameAgentSession(session: {
  tool: AgentTool;
  id: string;
  distro: string | null;
}, name: string): Promise<void> {
  return invoke("agent_sessions_rename", {
    tool: session.tool,
    id: session.id,
    name,
    distro: session.distro,
  });
}

export type AgentSessionsLoad = {
  sessions: AgentSession[];
  warnings: string[];
  /** One entry per unreadable source, shown verbatim rather than disguised as "no
   * sessions". */
  failures: string[];
};

/**
 * Read sessions from every source (local, plus each distro when the WSL toggle is on)
 * and every tool in one pass.
 *
 * Both the sessions panel and the project list need this data: the first lists it,
 * the second hangs sessions off project rows, and doing it separately would run the
 * same scan twice.
 */
export async function loadAllAgentSessions(): Promise<AgentSessionsLoad> {
  const wslEnabled = usePreferencesStore.getState().wslEnabled;
  const env = useWorkspaceEnvStore.getState();
  const distros = wslEnabled ? env.distros.map((d) => d.name) : [];
  if (wslEnabled && distros.length === 0) {
    // Right after the toggle turns on, distros have not been enumerated yet, so refresh
    // once, otherwise sessions inside distros are missed.
    await env.refreshDistros().catch(() => []);
  }
  const sources: (string | null)[] = [
    null,
    ...(wslEnabled
      ? useWorkspaceEnvStore.getState().distros.map((d) => d.name)
      : []),
  ];

  const requests = sources.flatMap((distro) =>
    AGENT_TOOLS.map((tool) => ({ tool, distro })),
  );
  const results = await Promise.allSettled(
    requests.map((request) => listAgentSessions(request.tool, request.distro)),
  );

  const sessions: AgentSession[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  results.forEach((result, index) => {
    const { tool, distro } = requests[index];
    if (result.status === "fulfilled") {
      sessions.push(...result.value.sessions);
      warnings.push(...result.value.warnings);
    } else {
      // One unreadable store must not hide the others.
      const source = distro ? `${tool}（${distro}）` : tool;
      failures.push(`${source}：${String(result.reason)}`);
    }
  });
  sessions.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return { sessions, warnings, failures };
}