import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { setLastWslDistro } from "@/modules/settings/store";

export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };

/**
 * 这个根路径属于哪个环境。项目落在 WSL 里就用 WSL，落在盘上就用本机。
 *
 * 判断不出来时**保持原来的环境**，绝不猜：猜错会让文件树、git、LSP 一起走去翻另一个文件系统。
 * 裸的 Linux 绝对路径（`/home/...`）没有携带发行版名，所以只在原环境已经是 WSL、
 * 或偏好里有上次用过的发行版时才切过去。
 */
export function envForRoot(
  root: string | null | undefined,
  previous: WorkspaceEnv,
  lastDistro?: string | null,
): WorkspaceEnv {
  const path = (root ?? "").trim();
  if (!path) return previous;
  // \\wsl.localhost\<distro>\... 或 \\wsl$\<distro>\...
  const unc = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)/i.exec(path);
  if (unc) return { kind: "wsl", distro: unc[1] };
  // 盘符路径与 /mnt/<盘> 都是 Windows 存储，无论从哪一侧看。
  if (/^[A-Za-z]:[\\/]/.test(path)) return LOCAL_WORKSPACE;
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(path)) return LOCAL_WORKSPACE;
  if (path.startsWith("/")) {
    if (previous.kind === "wsl") return previous;
    return lastDistro ? { kind: "wsl", distro: lastDistro } : previous;
  }
  return previous;
}

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => {
    set({ env });
    if (env.kind === "wsl") void setLastWslDistro(env.distro);
  },
  refreshDistros: async () => {
    set({ loading: true, error: null });
    try {
      const distros = await invoke<WslDistro[]>("wsl_list_distros");
      set({ distros, loading: false });
      return distros;
    } catch (e) {
      set({ distros: [], loading: false, error: String(e) });
      return [];
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  return env.kind === "wsl" ? `wsl:${env.distro}` : "local";
}

export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  return key.startsWith("wsl:")
    ? { kind: "wsl", distro: key.slice("wsl:".length) }
    : LOCAL_WORKSPACE;
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}
