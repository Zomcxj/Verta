export type AgentTool = "opencode" | "pi";

export type AgentSession = {
  tool: AgentTool;
  id: string;
  title: string;
  cwd: string;
  updatedAtMs: number;
  parentId: string | null;
  /** 会话来自哪个发行版；`null` 是本机。 */
  distro: string | null;
};

/** 后端真正发回的形状：来源由发起请求的那一侧盖上去。 */
export type WireSession = Omit<AgentSession, "distro">;

export type AgentSessionsPayload = {
  sessions: AgentSession[];
  warnings: string[];
};

export type WireAgentSessionsPayload = {
  sessions: WireSession[];
  warnings: string[];
};

/** What the backend accepts: an id, never a path. */
export type SessionTarget = {
  tool: AgentTool;
  id: string;
  /** 与 `AgentSession.distro` 同义：删除必须带回同一个来源。 */
  distro: string | null;
};

export type DeleteOutcome = {
  tool: AgentTool;
  id: string;
  deleted: boolean;
  reason: string | null;
};

export type DeleteReport = {
  deleted: number;
  outcomes: DeleteOutcome[];
};
