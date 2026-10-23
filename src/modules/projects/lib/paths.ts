/**
 * Comparing and normalizing project paths. On Windows the same directory can be spelled
 * several ways (case, forward vs back slashes, trailing slash), and both list
 * deduplication and "does this project already have a workspace" rely on the
 * comparisons here, so two identical-looking projects never appear.
 */

/** Strip trailing separators, but keep drive roots (`C:\`) and `/`. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  // Drop trailing separators, then any whitespace they were hiding (paste residue like
  // "F:\work\Verta \ ").
  const stripped = trimmed.replace(/[\\/]+$/, "").trimEnd();
  // `C:\` minus the slash is `C:`, and putting it back is what a drive root is.
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped || "/";
}

/** Whether two paths name the same directory (case-insensitive, separators unified). */
export function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return keyOf(a) === keyOf(b);
}

function keyOf(path: string): string {
  return normalizePath(path).replace(/\//g, "\\").toLowerCase();
}

/** Last segment of a path, used as a project's default display name. */
export function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

/**
 * Merge newly added paths into the existing list: entries already present (by
 * same-directory comparison) are skipped and new ones are appended, keeping the order
 * the user sees stable.
 */
export function mergeProjectPaths(
  existing: string[],
  added: string[],
): string[] {
  const out = [...existing];
  const seen = new Set(existing.map(keyOf));
  for (const raw of added) {
    const path = normalizePath(raw);
    if (!path) continue;
    const key = keyOf(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** Remove one path from the list; returns it unchanged when absent, which callers use
 * to tell whether anything changed. */
export function removeProjectPath(paths: string[], target: string): string[] {
  const key = keyOf(target);
  return paths.filter((path) => keyOf(path) !== key);
}