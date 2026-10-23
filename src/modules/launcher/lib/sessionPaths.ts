/**
 * Relative paths: fold a session's cwd into a form relative to the current workspace
 * root, for the context menu.
 *
 * String handling only: the session cwd and the workspace root come from the same
 * machine (compared only when `distro` matches), and the filesystem is never touched —
 * even if the directory has been deleted, the copied relative path is still the one
 * the user wants.
 */

/**
 * Unify separators and strip trailing `/`.
 *
 * No regex for the backslash: those `\\` are too easy to lose in editing and
 * escaping, so it is built from a char code.
 */
const BACKSLASH = String.fromCharCode(92);

function normalize(path: string): string {
  let unified = "";
  for (const ch of path) unified += ch === BACKSLASH ? "/" : ch;
  while (unified.endsWith("/")) unified = unified.slice(0, -1);
  return unified;
}

/**
 * Path of `cwd` relative to `root`; `null` when `cwd` is not under `root` (or `root` is
 * empty).
 *
 * The same path returns `"."`, meaning the root directory itself.
 */
export function relativeToRoot(
  root: string | null | undefined,
  cwd: string | null | undefined,
): string | null {
  if (!root || cwd === null || cwd === undefined) return null;
  const base = normalize(root);
  const target = normalize(cwd);
  if (!base || !target) return null;
  if (target === base) return ".";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (!target.startsWith(prefix)) return null;
  return target.slice(prefix.length);
}
