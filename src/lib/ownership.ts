import type { MessageKey } from "@/modules/i18n";

/**
 * Whether a repository belongs to the signed-in account.
 *
 * Two different questions, one answer: a remote row knows its owner, while a project on
 * disk knows only its folder name. "unknown" is the honest answer while the account is
 * unknown (gh missing, signed out, or a failed read), because guessing "others" there
 * would be wrong about half the time.
 */
export type Ownership = "mine" | "others" | "unknown";

/**
 * The account as the remote list reads it. `mine` holds the names of the repositories the
 * account itself owns, which is what a local folder is matched against.
 */
export type Account = { login: string; mine: readonly string[] } | null;

/** A remote row: the owner is right there, so it is a straight comparison. */
export function ownershipOfRepo(owner: string, account: Account): Ownership {
  if (!account) return "unknown";
  return owner.trim().toLowerCase() === account.login.trim().toLowerCase()
    ? "mine"
    : "others";
}

/**
 * A local project: its folder name against the names the account owns.
 *
 * This is a heuristic, and the failure modes are worth naming: a clone of somebody else's
 * repository under the same name reads as "mine", and a folder renamed after cloning reads
 * as "others". The alternative is reading every project's `origin` before it can be shown.
 */
export function ownershipOfFolder(name: string, account: Account): Ownership {
  if (!account) return "unknown";
  const wanted = name.trim().toLowerCase();
  if (!wanted) return "unknown";
  return account.mine.some((mine) => mine.toLowerCase() === wanted)
    ? "mine"
    : "others";
}

export function ownershipLabelKey(ownership: Ownership): MessageKey {
  switch (ownership) {
    case "mine":
      return "owner.mine";
    case "others":
      return "owner.others";
    default:
      return "owner.unknown";
  }
}

/** Sort order: the account's own repositories first, then other people's, then unknown. */
export function ownershipRank(ownership: Ownership): number {
  switch (ownership) {
    case "mine":
      return 0;
    case "others":
      return 1;
    default:
      return 2;
  }
}

/** The account from a remote-list payload, or null while the login is unknown. */
export function accountFrom(
  login: string | null,
  repos: readonly { owner: string; name: string }[],
): Account {
  if (!login?.trim()) return null;
  const wanted = login.trim().toLowerCase();
  return {
    login,
    mine: repos
      .filter((repo) => repo.owner.trim().toLowerCase() === wanted)
      .map((repo) => repo.name),
  };
}
