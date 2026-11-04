import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import { resumeCommand } from "./resumeCommand";
import type { AgentSession, AgentTool } from "./types";

/** What to do after clicking a session row: resume in which cwd and env, running which
 * command. */
export type SessionOpenPlan = {
  cwd: string;
  workspace: WorkspaceEnv;
  command: string;
};

/**
 * The tab already showing this session, if one is.
 *
 * Every agent here writes its session file itself, and two processes on one file take turns
 * overwriting each other - pi's session is a single transcript both of them append to. Opening a
 * row twice used to start a second agent on the same session. Clicking a row that is already open
 * means "go back to it", so the caller returns to that tab instead of starting another.
 */
export function openTabForSession<T extends { kind: string; sessionId?: string }>(
  tabs: readonly T[],
  sessionId: string,
): T | undefined {
  return tabs.find(
    (tab) => tab.kind === "terminal" && tab.sessionId === sessionId,
  );
}

/**
 * The same plan, built from what a restored tab carried on disk instead of from a
 * scanned session row: the tab's `agent` and `sessionId`, and the cwd / env its
 * active leaf was stored with. `null` when the pieces do not fit (no directory, or
 * an id the shell cannot take), which the caller treats as "come back as a plain
 * terminal".
 */
export function planSessionResume(
  tool: AgentTool,
  sessionId: string,
  cwd: string,
  workspace?: WorkspaceEnv,
): SessionOpenPlan | null {
  const env = workspace ?? LOCAL_WORKSPACE;
  try {
    return {
      cwd,
      workspace: env,
      command: resumeCommand(
        {
          tool,
          id: sessionId,
          cwd,
          distro: env.kind === "wsl" ? env.distro : null,
        },
        env.kind === "wsl" ? false : undefined,
      ),
    };
  } catch {
    return null;
  }
}

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