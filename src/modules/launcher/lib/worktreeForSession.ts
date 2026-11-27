import { native } from "@/lib/native";
import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import type { AgentSession } from "./types";

/**
 * A branch name git will take, derived from the session title.
 *
 * The title is human text; a branch is a ref. Lowercase, anything that is not a letter
 * or digit becomes one `-`, runs collapse, and the whole thing is capped so a long title
 * does not make a path too deep. An empty result falls back to the id: a title of only
 * punctuation is not a name.
 */
export function defaultWorktreeBranch(session: AgentSession): string {
  const slug = session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug
    ? `agent/${slug}`
    : `agent/${session.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session"}`;
}

/**
 * The env the session runs in. The distro is authoritative, the same rule
 * `planSessionOpen` follows: a local session must not be opened in a WSL shell.
 */
export function workspaceForSession(session: AgentSession): WorkspaceEnv {
  return session.distro
    ? { kind: "wsl", distro: session.distro }
    : LOCAL_WORKSPACE;
}

/**
 * The repository a session's folder belongs to, or a sentence saying why there is none.
 *
 * The worktree dialog works on a repository, while a session remembers the folder it ran
 * in - which may be below the root, or a folder that is not a repository at all. The
 * session's own folder is authorised first because the list is read from the agents'
 * own files rather than the workspace registry, so a project that was never opened here
 * is still listed and would otherwise fail with "outside the authorized workspace".
 */
export async function resolveWorktreeRepo(
  session: AgentSession,
): Promise<{ repoRoot: string } | { error: string }> {
  const workspace = workspaceForSession(session);
  try {
    await native.workspaceAuthorize(session.cwd, workspace);
    const repo = await native.gitResolveRepo(session.cwd, workspace);
    if (repo === null) return { error: "no-repository" };
    return { repoRoot: repo.repoRoot };
  } catch (error) {
    return { error: String(error) };
  }
}
