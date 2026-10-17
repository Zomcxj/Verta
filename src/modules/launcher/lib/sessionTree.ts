import type { AgentSession } from "./types";

export type SessionRow = {
  parent: AgentSession;
  children: AgentSession[];
};

/**
 * 子会话（子代理）默认折叠在父会话下面。父不在列表里的会话按顶层处理，
 * 出现父子成环时同样降级成顶层，保证任何一条会话都不会从界面上消失。
 */
export function foldSessions(sessions: AgentSession[]): SessionRow[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, AgentSession[]>();
  const roots: AgentSession[] = [];

  for (const session of sessions) {
    const parentId = session.parentId;
    if (parentId && parentId !== session.id && byId.has(parentId)) {
      const bucket = children.get(parentId);
      if (bucket) bucket.push(session);
      else children.set(parentId, [session]);
    } else {
      roots.push(session);
    }
  }

  const rows: SessionRow[] = [];
  const claimed = new Set<string>();
  const take = (session: AgentSession) => {
    if (claimed.has(session.id)) return;
    claimed.add(session.id);
    const kids = children.get(session.id) ?? [];
    for (const kid of kids) claimed.add(kid.id);
    rows.push({ parent: session, children: kids });
  };

  for (const root of roots) take(root);
  // 环里的会话不会出现在 roots，这里兜住它们。
  for (const session of sessions) take(session);

  for (const row of rows) {
    row.children.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  return rows;
}
