export type AgentTool = "opencode" | "pi";

export type AgentSession = {
  tool: AgentTool;
  id: string;
  title: string;
  cwd: string;
  updatedAtMs: number;
  parentId: string | null;
  /** Which distro the session came from; `null` means local. */
  distro: string | null;
  /** Conversation turns; `null` when the tool does not record them (shown as an em-dash). */
  turns?: number | null;
  /** Cumulative tokens; `null` when unavailable. */
  tokens?: number | null;
  /** Time of the last **conversation**; falls back to `updatedAtMs`. */
  lastAtMs?: number | null;
};

/** The shape the backend actually returns: the source is stamped on by the requesting side. */
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
  /** Same meaning as `AgentSession.distro`: a delete must carry the same source back. */
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
