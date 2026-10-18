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

export type AgentSessionsLoad = {
  sessions: AgentSession[];
  warnings: string[];
  /** 每个读不出来的来源一条，界面原样显示，不要伪装成「没有会话」。 */
  failures: string[];
};

/**
 * 一次读齐所有来源（本机，加上 WSL 开关打开时的每个发行版）与所有工具的会话。
 *
 * 会话面板与项目列表都要这份数据：前者直接列出来，后者用它把会话挂到项目行上，
 * 不然同一次扫描要跑两遍。
 */
export async function loadAllAgentSessions(): Promise<AgentSessionsLoad> {
  const wslEnabled = usePreferencesStore.getState().wslEnabled;
  const env = useWorkspaceEnvStore.getState();
  const distros = wslEnabled ? env.distros.map((d) => d.name) : [];
  if (wslEnabled && distros.length === 0) {
    // 开关刚打开、还没枚举过发行版时补一次，否则会漏掉发行版里的会话。
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