import type { MessageKey } from "@/modules/i18n";
import type { ProjectStatus } from "./types";

/**
 * Pulling a project from the list: only a branch whose upstream carries the same name can
 * be pulled.
 *
 * `git pull` merges the upstream into the current branch. For `main` tracking
 * `origin/main` that is what the click means; for `work` tracking `origin/main` the same
 * command would merge another branch into this one. The backend refuses that case too
 * (`projects::pull::pull_blocker`); this side decides what the button looks like so the
 * refusal is not the first the user hears of it.
 */

/** Branch name carried by an upstream ref: `origin/feature/login` -> `feature/login`.
 *
 * The first segment is the remote's name and the rest is the branch, so a branch whose own
 * name contains a slash comes back whole. A local branch tracking another local branch has
 * no remote segment and is returned unchanged. Null for an empty value.
 */
export function upstreamBranchName(upstream: string): string | null {
  const trimmed = upstream.trim();
  if (!trimmed) return null;
  const cut = trimmed.indexOf("/");
  if (cut < 0) return trimmed;
  const branch = trimmed.slice(cut + 1).trim();
  return branch ? branch : null;
}

/** What the pull button should do with this row; null means the pull can go ahead. */
export type PullBlocker = {
  /** i18n key for the reason; `params` are interpolated when present. */
  key: MessageKey;
  params?: Record<string, string | number>;
};

/**
 * Whether this row can be pulled right now, and what to say when it cannot.
 *
 * Not checked yet, not a repository, a detached HEAD, no upstream and a differently named
 * upstream all land on their own sentence. A row with nothing behind is `scm.pullUpToDate`:
 * the button stays where it is (the column does not jump around) but does nothing.
 */
export function pullBlocker(status: ProjectStatus | null): PullBlocker | null {
  if (!status) return { key: "projects.pull.unchecked" };
  switch (status.kind) {
    case "missing":
      return { key: "projects.state.missing" };
    case "notRepo":
      return { key: "projects.state.notRepo" };
    case "error":
      return { key: "projects.state.failed" };
    default:
      break;
  }
  if (status.detached) return { key: "projects.pull.detached" };
  const branch = status.branch?.trim();
  if (!branch) return { key: "projects.pull.noBranch" };
  const upstream = status.upstream?.trim();
  if (!upstream) return { key: "scm.pullNoUpstream" };
  const upstreamBranch = upstreamBranchName(upstream);
  if (!upstreamBranch) {
    return { key: "projects.pull.branchUnreadable", params: { upstream } };
  }
  if (upstreamBranch !== branch) {
    return {
      key: "projects.pull.branchDiffers",
      params: { branch, upstream, upstreamBranch },
    };
  }
  if (status.ahead > 0 && status.behind > 0) {
    return { key: "scm.pullDiverged" };
  }
  if (status.behind === 0) return { key: "scm.pullUpToDate" };
  return null;
}