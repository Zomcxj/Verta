export type AgentTool = "opencode" | "pi";

export type AgentSession = {
  tool: AgentTool;
  id: string;
  title: string;
  cwd: string;
  updatedAtMs: number;
  parentId: string | null;
};

export type AgentSessionsPayload = {
  sessions: AgentSession[];
  warnings: string[];
};

/** What the backend accepts: an id, never a path. */
export type SessionTarget = {
  tool: AgentTool;
  id: string;
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
