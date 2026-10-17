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
