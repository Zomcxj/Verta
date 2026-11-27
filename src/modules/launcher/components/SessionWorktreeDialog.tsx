import { AddWorktreeDialog } from "@/modules/source-control/BranchDialogs";
import type { WorkspaceEnv } from "@/modules/workspace";
import type { AgentSession } from "../lib/types";
import { defaultWorktreeBranch } from "../lib/worktreeForSession";

/**
 * Where a session's worktree goes, asked with the same dialog the branch dropdown uses.
 *
 * The creation itself is `AddWorktreeDialog` in the source-control module: one way to make a
 * worktree, two ways to reach it. What this adds is only the session's side of it - a branch
 * name taken from the session's title, and the created path handed back so the caller can open
 * the session there.
 *
 * The repository root is resolved by the caller, because that needs the session's folder
 * authorised first. Until it arrives this renders nothing, so a click that could not find a
 * repository shows its own sentence instead of an empty form.
 */
export function SessionWorktreeDialog({
  session,
  repoRoot,
  env,
  onOpenChange,
  onCreated,
}: {
  /** The session being placed; null when the dialog is closed. */
  session: AgentSession | null;
  /** The repository the session's folder belongs to, or null while it is being resolved. */
  repoRoot: string | null;
  env: WorkspaceEnv;
  onOpenChange: (open: boolean) => void;
  /** Put the session into the worktree that now exists at this path. */
  onCreated: (session: AgentSession, path: string) => Promise<string | null>;
}) {
  if (session === null || repoRoot === null) return null;
  return (
    <AddWorktreeDialog
      // Keyed per session and repository: the branch field is seeded from the title, and
      // keeping the previous session's value would name the new worktree after the old one.
      key={`${session.tool}:${session.id}:${repoRoot}`}
      repoRoot={repoRoot}
      initialBranch={defaultWorktreeBranch(session)}
      env={env}
      onClose={() => onOpenChange(false)}
      onChanged={() => {}}
      onCreated={(path) => onCreated(session, path)}
    />
  );
}
