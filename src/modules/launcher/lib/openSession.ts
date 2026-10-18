import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import { resumeCommand } from "./resumeCommand";
import type { AgentSession } from "./types";

/** 点一个会话行之后要照着做的事：在哪恢复、开在哪个环境、跑哪条命令。 */
export type SessionOpenPlan = {
  cwd: string;
  workspace: WorkspaceEnv;
  command: string;
};

/**
 * 会话在哪个环境里恢复，命令就按哪个环境写。会话记录里的 `distro` 是权威的
 * （`null` 即本机），**不能留空让终端去猜当前环境**：用户停在一个 WSL 终端上时点
 * 本机会话，命令是本机形式、shell 却是发行版的，`chdir F:/...` 在 Linux 侧必然
 * ENOENT（实测踩过这个坑）。环境与命令的写法必须同源，所以两件事一起算，
 * 不给调用方留下「只传一个」的机会。
 */
export function planSessionOpen(session: AgentSession): SessionOpenPlan | null {
  const workspace: WorkspaceEnv = session.distro
    ? { kind: "wsl", distro: session.distro }
    : LOCAL_WORKSPACE;
  try {
    return {
      cwd: session.cwd,
      workspace,
      command: resumeCommand(
        session,
        workspace.kind === "wsl" ? false : undefined,
      ),
    };
  } catch {
    // 会话 id 含非法字符：拒绝构造命令，调用方按「不打开」处理。
    return null;
  }
}