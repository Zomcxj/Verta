/**
 * Whether a change the watcher reported belongs to a repository rooted at `repoRoot`.
 *
 * `fs:changed` names **directories**, and a watcher covers whatever the surfaces asked for: the
 * explorer's tree, the home directory, a project row, the repository a panel is showing. A surface
 * that displays one repository has to know which of those names are its own, and the root itself
 * counts as one - a commit rewrites `.git` and a checkout rewrites the root, both reported at the
 * root.
 *
 * Both sides are compared in the spelling the watcher uses: forward slashes, no trailing separator.
 * A backslash path on Windows is normalised rather than rejected, because the same value arrives
 * from more than one layer.
 */
export function changeTouchesRepo(
  changed: readonly string[],
  repoRoot: string | null,
): boolean {
  if (!repoRoot) return false;
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return false;
  return changed.some((path) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === root) return true;
    return normalized.startsWith(`${root}/`);
  });
}
