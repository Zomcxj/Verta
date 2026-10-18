import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { setLastWslDistro } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";

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

/**
 * 这一次调用该用哪个环境：以**路径本身**为准。
 *
 * 环境与路径是分两步落地的（切标签、开终端都要先解析家目录、先授权），中间那一瞬间两边会对不上，
 * 而文件树、编辑器读的都是绝对路径：按路径取环境，就不会拿 Linux 路径去本机文件系统里找
 * （用户看到的就是一闪而过的「系统找不到指定路径」）。
 */
export function envForPath(
  path: string | null | undefined,
  previous: WorkspaceEnv = currentWorkspaceEnv(),
): WorkspaceEnv {
  return envForRoot(path, previous, usePreferencesStore.getState().lastWslDistro);
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
