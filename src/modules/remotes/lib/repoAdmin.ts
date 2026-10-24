import type { WireRepoSettingsPayload } from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";

/** Max length of a repo description; matches `repo_admin::DESCRIPTION_MAX_CHARS`
 * on the Rust side. */
export const DESCRIPTION_MAX_CHARS = 350;

/**
 * Whether this repo's settings (description / visibility / delete) can be edited.
 *
 * Same trade-off as the permission gate: **unreadable and unfetched states (gh
 * missing / logged out / error) all return true**, so the buttons stay rendered,
 * and GitHub rejects the click and its message is passed through verbatim.
 */
export function canAdmin(payload: WireRepoSettingsPayload | null): boolean {
  return payload ? payload.canAdmin : true;
}

/** Key for the "you cannot edit this repo" sentence; null when there is nothing to say. */
export function adminHintKey(
  payload: WireRepoSettingsPayload | null,
): MessageKey | null {
  if (payload?.kind !== "ready") return null;
  return payload.canAdmin ? null : "remotes.admin.readOnly";
}

/**
 * Fold `PUBLIC` / `PRIVATE` into a private flag.
 *
 * Org-internal (`INTERNAL`) and unavailable values return null: the UI must not
 * claim "private" or "public" there, only show GitHub's own word.
 */
export function isPrivateVisibility(visibility: string | null): boolean | null {
  const value = visibility?.trim().toUpperCase();
  if (value === "PUBLIC") return false;
  if (value === "PRIVATE") return true;
  return null;
}

/**
 * Delete confirmation: the typed full name must match exactly (case-insensitive,
 * since GitHub repo names are case-insensitive anyway).
 *
 * This is the last gate before an irreversible action, so fuzzy matching is
 * deliberately avoided.
 */
export function deleteConfirmMatches(typed: string, fullName: string): boolean {
  const a = typed.trim();
  if (!a) return false;
  return a.toLowerCase() === fullName.trim().toLowerCase();
}

/** Local check for a description; returns the reason when it fails. */
export function descriptionProblem(description: string): "tooLong" | null {
  return description.trim().length > DESCRIPTION_MAX_CHARS ? "tooLong" : null;
}

/** Max length of a repo name; matches `repo_admin::repo_name_problem` on the Rust side. */
export const REPO_NAME_MAX_CHARS = 100;

/** Why a repo name would be refused, in the shape the UI needs to say it. */
export type RepoNameProblem =
  | { reason: "empty" }
  | { reason: "tooLong"; length: number }
  | { reason: "badChar"; char: string };

/**
 * Local check for a repo name; null when GitHub would accept it.
 *
 * Checked here because the round trip is slow and gh's own wording ("invalid name") does
 * not say which rule was broken. GitHub takes letters, digits, `.`, `_` and `-`, up to 100
 * characters; the field is a name, not a slug, so the owner is not part of it.
 */
export function repoNameProblem(name: string): RepoNameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return { reason: "empty" };
  const length = [...trimmed].length;
  if (length > REPO_NAME_MAX_CHARS) return { reason: "tooLong", length };
  const bad = [...trimmed].find((char) => !/[A-Za-z0-9._-]/.test(char));
  return bad ? { reason: "badChar", char: bad } : null;
}

/**
 * Default clone destination: **next to** an existing project, named after the
 * repo.
 *
 * With no existing project (or an empty path) it returns an empty string, leaving
 * the field to the user instead of guessing a directory that may not exist. The
 * separator follows the given path, so Windows gets backslashes.
 */
export function cloneDestBeside(
  existingProjectPath: string | null,
  name: string,
): string {
  const raw = existingProjectPath?.trim() ?? "";
  if (!raw || !name.trim()) return "";
  // Take the separator from the original path: the parent of `F:\Verta` is `F:`,
  // which alone does not tell which slash to use.
  const separator = raw.includes("\\") ? "\\" : "/";
  const parent = parentOf(raw);
  if (!parent) return "";
  return parent.endsWith(separator)
    ? `${parent}${name}`
    : `${parent}${separator}${name}`;
}

/**
 * Pick a reference entry from the project list and derive the clone destination.
 *
 * Some entries have no computable parent (a half-typed path, say), so try them
 * one by one and use the first that yields a result; if none does, return an
 * empty string and let the user fill it in.
 */
export function cloneDestFromProjects(paths: string[], name: string): string {
  for (const path of paths) {
    const dest = cloneDestBeside(path, name);
    if (dest) return dest;
  }
  return "";
}

/** Parent directory; drive roots and `/` come back unchanged (they have no parent). */
function parentOf(path: string | null): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const separator = trimmed.includes("\\") ? "\\" : "/";
  const withoutTrailing = trimmed.replace(/[\\/]+$/, "");
  // For `C:` the trailing slash removal leaves just the drive letter, and that
  // level is the root.
  if (/^[A-Za-z]:$/.test(withoutTrailing)) return `${withoutTrailing}\\`;
  const cut = withoutTrailing.lastIndexOf(separator);
  if (cut < 0) return null;
  if (cut === 0) return separator;
  return withoutTrailing.slice(0, cut);
}
