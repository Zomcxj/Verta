/**
 * Picking which repository the right-hand panel shows when a folder holds several.
 *
 * A session usually opens at a folder, and that folder is often not itself a checkout: a workspace
 * of projects, or a directory whose real work sits one level down. The panel then had nothing to
 * show, so the user had to go and pin a repository by hand every time - and the pin was per
 * workspace root, so the next session started it over.
 *
 * The rules, in the order they are applied:
 *  - the folder is a repository: show it. Nothing was ambiguous, so nothing is chosen;
 *  - one repository below it: show that one;
 *  - several: the one committed to most recently, which is the one whose work is most likely to be
 *    current;
 *  - and once the user has picked one themselves, that choice stands. Coming back to the folder, or
 *    switching tabs away and back, must not silently move the panel somewhere else - a panel that
 *    shows a different repository every time the session is re-entered is worse than one that shows
 *    the wrong one.
 */

/** What the scan found: each candidate and how recently it committed. */
export type DiscoveredRepo = {
  readonly path: string;
  /** Epoch ms of its last commit; `null` when it has none. */
  readonly committedAtMs: number | null;
};

/** Which repository a folder should show, before any choice by the user. */
export type RepoPick =
  | { readonly kind: "none" }
  | { readonly kind: "repository"; readonly path: string }
  | {
      readonly kind: "chosen";
      readonly path: string;
      /** Every candidate, newest first, for the panel's switcher. */
      readonly options: readonly DiscoveredRepo[];
    };

/** Newest commit first; a repository with no commits sorts last, then by path. */
export function orderByRecency(
  repos: readonly DiscoveredRepo[],
): DiscoveredRepo[] {
  return [...repos].sort((a, b) => {
    if (a.committedAtMs !== null && b.committedAtMs !== null) {
      if (b.committedAtMs !== a.committedAtMs) return b.committedAtMs - a.committedAtMs;
      return a.path.localeCompare(b.path);
    }
    if (a.committedAtMs !== null) return -1;
    if (b.committedAtMs !== null) return 1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * What to show for `folder`, given what the scan found.
 *
 * `folder` is compared with the candidates as the scan spelled them, so a candidate equal to the
 * folder means "this folder is a repository" and the answer is not a choice at all - there was
 * nothing to choose between.
 */
export function pickRepository(
  folder: string | null,
  repos: readonly DiscoveredRepo[],
): RepoPick {
  if (repos.length === 0) return { kind: "none" };
  const folderKey = normalizeKey(folder);
  const self = repos.find((repo) => normalizeKey(repo.path) === folderKey);
  if (self !== undefined) return { kind: "repository", path: self.path };
  if (repos.length === 1) return { kind: "repository", path: repos[0].path };
  const ordered = orderByRecency(repos);
  return { kind: "chosen", path: ordered[0].path, options: ordered };
}

/**
 * Whether a new scan should move the panel.
 *
 * Only while nothing has been picked for this folder. A pick is the user's answer to "which of
 * these", and it outlives every re-scan, every tab switch and every reopen of the session; it goes
 * away only when the folder itself changes.
 */
export function shouldAdoptPick(
  current: RepoPick,
  alreadyPicked: boolean,
): boolean {
  if (alreadyPicked) return false;
  return current.kind !== "none";
}

function normalizeKey(path: string | null): string {
  if (path === null) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
