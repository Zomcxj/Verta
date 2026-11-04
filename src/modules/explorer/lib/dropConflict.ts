/**
 * The question asked when a drop would replace something.
 *
 * A file dragged in under a name the folder already holds used to be reported as a failure, with no
 * way to say what should happen: the copy refused, the toast said the destination existed, and the
 * only way forward was to delete the old file first. Dropping a folder of screenshots on a folder
 * that already had some of them meant doing that once per name.
 *
 * The question is asked once per drop and its answer applies to every name in it, because a drop is
 * one gesture - asking per file would make a twenty-file drop twenty dialogs, and the user's answer
 * would be the same twenty times.
 */

/** What to do with the names already in the destination. */
export type DropConflictChoice = "replace" | "skip";

export type DropConflictPrompt = {
  /** The names that are already there, for the dialog to show. */
  readonly names: readonly string[];
  /** Resolves with the user's answer, or `null` when the dialog was dismissed. */
  readonly ask: (prompt: {
    names: readonly string[];
  }) => Promise<DropConflictChoice | null>;
};

/** The last path segment, which is the name the destination would hold. */
export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** The names a drop would replace, in the order the sources were given, without repeats. */
export function conflictingNames(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const path of paths) {
    const name = baseName(path);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
