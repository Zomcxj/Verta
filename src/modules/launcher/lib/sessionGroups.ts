import type { AgentSession, AgentTool } from "./types";

/**
 * 会话列表怎么摆：`all` 全部放一块（按时间排），`tool` 按 agent 分开一段一段。
 *
 * 默认 `all`：大多数时候人只想知道「最近聊了什么」，再照 agent 分一次家反而要多扫几眼。
 * 只有真的按工具找的时候，才切成 `tool`。
 */
export type SessionGroupBy = "all" | "tool";

/** 按时间倒序 —— 两个分组都遵守它，切来切去不会换顺序。 */
export function sortByRecent(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export type SessionGroup = {
  /** `null` 是全部放一块那一组（不画标题）；否则是某个 agent。 */
  tool: AgentTool | null;
  sessions: AgentSession[];
};

/**
 * 按 agent 分段。
 *
 * 段的顺序跟着 `tools` 走（也就是设置里定下来的工具顺序），不跟着会话数或时间走 ——
 * 不然一段新消息进来整块列表就会换位置。没有会话的工具**不出现**，
 * 空列表给一组 `tool: null` 的空段，好让列表自己的空状态文案照常出现。
 */
export function groupByTool(
  sessions: readonly AgentSession[],
  tools: readonly AgentTool[],
  groupBy: SessionGroupBy,
): SessionGroup[] {
  if (groupBy === "all") {
    return [{ tool: null, sessions: sortByRecent(sessions) }];
  }
  const known = new Set<string>(tools);
  const groups: SessionGroup[] = tools.map((tool) => ({
    tool,
    sessions: sortByRecent(sessions.filter((session) => session.tool === tool)),
  }));
  // 存储里出现了不认识的工具名：照样列出来，别悄悄吞掉。
  const others = sessions.filter((session) => !known.has(session.tool));
  if (others.length > 0) {
    groups.push({ tool: null, sessions: sortByRecent(others) });
  }
  const nonEmpty = groups.filter((group) => group.sessions.length > 0);
  if (nonEmpty.length === 0) return [{ tool: tools[0] ?? null, sessions: [] }];
  return nonEmpty;
}
