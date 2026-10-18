import { IS_WINDOWS } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import type { AgentTool } from "./types";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

type ResumeTarget = {
  tool: AgentTool;
  id: string;
  cwd: string;
  /** 会话属于哪个发行版；给了就按 WSL 的规矩来（POSIX 引号 + 选对二进制）。 */
  distro?: string | null;
};

/**
 * 发行版里的 `opencode` 很可能就是 Windows 那个 exe（WSL interop）。它按自身所在的文件系统
 * 解析主目录，于是会去读写另一个库：实测同一个 cwd 下，PATH 上的 `/mnt/d/...` 看不见发行版的
 * 会话，而 `~/.npm-global/bin/opencode` 看得见。所以先把发行版文件系统内的几处安装位置放到
 * PATH 前面，找不到再回落到发行版自己的 PATH。
 */
const WSL_OPENCODE =
  'env PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH" opencode';

/**
 * 会话 id 会被直接拼进命令行，所以先按白名单校验；任何不合规的字符都拒绝执行，
 * 而不是转义后放行。
 */
export function resumeCommand(
  { tool, id, cwd, distro }: ResumeTarget,
  windows = IS_WINDOWS,
): string {
  if (!SESSION_ID.test(id)) {
    throw new Error(`会话 id 含非法字符，拒绝构造 resume 命令：${id}`);
  }
  if (tool === "opencode") {
    // opencode 是 --session <id> 加位置参数 directory。cwd 必须一起传：
    // 在别的目录里 --session 会找不到这个会话而静默新建一个。
    const binary = distro ? WSL_OPENCODE : "opencode";
    // 发行版里是 Linux 路径，引号也按 POSIX 加。
    const directory = quoteShellArg(cwd, distro ? false : windows);
    return `${binary} --session ${id} ${directory}`;
  }
  // pi 在自己的 cwd 下按 id 找会话，cwd 由终端的工作目录承担。
  return `pi --session ${id}`;
}
