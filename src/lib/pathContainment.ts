/**
 * Two spellings of one folder.
 *
 * The same directory reaches this app in more than one shape: opencode writes
 * `F:/work/app`, pi writes `F:\work\app`, and a stored path may carry a trailing slash.
 * Splitting a session list by folder is only worth anything if those land in one group.
 */
export function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Whether `path` is `root` itself or something inside it, ignoring case.
 *
 * Case-insensitive on purpose: Windows hands out `C:\Users` and `c:\users` for the same
 * folder, and a comparison that says which one it is would be a trap rather than a help.
 * A `root` that normalizes to nothing matches nothing, so a stray empty entry in the
 * project list cannot swallow every session.
 */
export function folderAtOrUnder(path: string, root: string): boolean {
  const inside = normalizeFolderPath(path).toLowerCase();
  const container = normalizeFolderPath(root).toLowerCase();
  if (container === "") return false;
  return inside === container || inside.startsWith(`${container}/`);
}

/** The last segment of a path, whichever separator it uses. */
export function folderName(path: string): string {
  const parts = normalizeFolderPath(path).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
