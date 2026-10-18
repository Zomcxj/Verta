import type { WorkspaceEnv } from "@/modules/workspace";

/** 清单里的一个项目。 */
export type ProjectEntry = {
  path: string;
  /** 项目在哪个环境：决定状态去哪一侧查，也决定点进去之后空间的环境。 */
  workspace: WorkspaceEnv;
  /**
   * 是不是用户清单里的项目。false 表示它是从发行版会话里发现的（WSL 打开时才出现），
   * 界面不给「移除」，免得用户以为删了会连带删掉什么。
   */
  managed: boolean;
};

/** 后端查出来的 `kind`，含义见 Rust 侧同名类型。 */
export type ProjectStatusKind = "repo" | "notRepo" | "missing" | "error";

export type ProjectStatus = {
  path: string;
  name: string;
  workspace: WorkspaceEnv;
  kind: ProjectStatusKind;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  dirty: number;
  stashed: number;
  error: string | null;
};

/** 一行在界面上的样子：清单项 + 这次查到的状态（可能还没查、可能正在查）。 */
export type ProjectRow = ProjectEntry & {
  status: ProjectStatus | null;
  checking: boolean;
};