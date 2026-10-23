import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import { resumeCommand } from "./resumeCommand";
import type { AgentSession } from "./types";

/** What to do after clicking a session row: resume in which cwd and env, running which
 * command. */
export type SessionOpenPlan = {
  cwd: string;
  workspace: WorkspaceEnv;
  command: string;
};

/**
 * The command is written for whichever env the session resumes in. The `distro` in
 * the session record is authoritative (`null` means local), and **it must not be left
 * empty for the terminal to guess the current env**: clicking a local session while
 * parked in a WSL terminal yields a local-style command in a distro shell, and
 * `chdir F:/...` on the Linux side is a guaranteed ENOENT (we have hit this). Env and
 * command spelling have to come from the same source, so both are computed here and
 * callers never get the chance to pass just one.
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
    // The session id has illegal characters: refuse to build a command, and the caller
    // treats it as "do not open".
    return null;
  }
}