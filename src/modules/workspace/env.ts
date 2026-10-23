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
 * Which env this root path belongs to. A project in WSL uses WSL, one on a drive uses
 * local.
 *
 * When it cannot be told, **keep the previous env** and never guess: a wrong guess
 * sends the file tree, git, and LSP off to search another filesystem together. A bare
 * Linux absolute path (`/home/...`) carries no distro name, so we only switch when the
 * previous env is already WSL or preferences remember the last distro used.
 */
export function envForRoot(
  root: string | null | undefined,
  previous: WorkspaceEnv,
  lastDistro?: string | null,
): WorkspaceEnv {
  const path = (root ?? "").trim();
  if (!path) return previous;
  // \\wsl.localhost\<distro>\... or \\wsl$\<distro>\...
  const unc = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)/i.exec(path);
  if (unc) return { kind: "wsl", distro: unc[1] };
  // Drive paths and /mnt/<drive> both live on Windows storage, whichever side you
  // look from.
  if (/^[A-Za-z]:[\\/]/.test(path)) return LOCAL_WORKSPACE;
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(path)) return LOCAL_WORKSPACE;
  if (path.startsWith("/")) {
    if (previous.kind === "wsl") return previous;
    return lastDistro ? { kind: "wsl", distro: lastDistro } : previous;
  }
  return previous;
}

/**
 * Which env this call should use: **the path itself decides**.
 *
 * Env and path land in two steps (switching tabs or opening a terminal resolves the
 * home directory and authorizes before applying), so for an instant the two
 * disagree, and the file tree and editor read absolute paths. Taking the env from
 * the path keeps a Linux path from being looked up on the local filesystem (which
 * users see as a flash of "system cannot find the path specified").
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
