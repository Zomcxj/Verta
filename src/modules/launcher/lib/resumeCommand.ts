import { IS_WINDOWS } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import type { AgentTool } from "./types";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

type ResumeTarget = {
  tool: AgentTool;
  id: string;
  cwd: string;
};

/**
 * 会话 id 会被直接拼进命令行，所以先按白名单校验；任何不合规的字符都拒绝执行，
 * 而不是转义后放行。
 */
export function resumeCommand(
  { tool, id, cwd }: ResumeTarget,
  windows = IS_WINDOWS,
): string {
  if (!SESSION_ID.test(id)) {
    throw new Error(`会话 id 含非法字符，拒绝构造 resume 命令：${id}`);
  }
  if (tool === "opencode") {
    // opencode 是 --session <id> 加位置参数 directory。cwd 必须一起传：
    // 在别的目录里 --session 会找不到这个会话而静默新建一个。
    return `opencode --session ${id} ${quoteShellArg(cwd, windows)}`;
  }
  // pi 在自己的 cwd 下按 id 找会话，cwd 由终端的工作目录承担。
  return `pi --session ${id}`;
}
