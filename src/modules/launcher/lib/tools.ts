import type { AgentTool } from "./types";

/** 支持的 agent。加新工具只改这里：会话列表与项目行的「新建会话」都读它。 */
export const AGENT_TOOLS: AgentTool[] = ["opencode", "pi"];