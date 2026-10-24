import type { SortState } from "@/components/ui/sort-header";
import { accountFrom, ownershipOfRepo, ownershipRank } from "@/lib/ownership";
import type { WireRemoteReposPayload } from "@/lib/native";
import type { Language } from "@/modules/i18n/language";
import { relativeTime } from "@/modules/launcher";
import type { RemoteReposKind, RemotesNotice, RemoteRepoRow } from "./types";

/** URL for `git clone`: the GitHub page URL plus `.git`, trailing slashes removed
 * first. */
export function cloneUrlOf(webUrl: string): string {
  const trimmed = webUrl.replace(/\/+$/, "");
  return trimmed ? `${trimmed}.git` : "";
}

/** The raw push time, or null when GitHub gives nothing parseable. */
function pushedMsOf(pushedAt: string | null): number | null {
  if (!pushedAt) return null;
  const ms = Date.parse(pushedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Push time: GitHub gives ISO8601, folded into the panel's relative time; when it
 * cannot be parsed we do not pretend there is a time. */
export function pushedLabel(
  pushedAt: string | null,
  nowMs: number,
  language: Language,
): string | null {
  const ms = pushedMsOf(pushedAt);
  return ms === null ? null : relativeTime(nowMs, ms, language);
}

export function toRows(
  payload: WireRemoteReposPayload,
  nowMs: number,
  language: Language,
): RemoteRepoRow[] {
  const account = accountFrom(payload.login, payload.repos);
  return payload.repos.map((repo) => ({
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    ownership: ownershipOfRepo(repo.owner, account),
    isPrivate: repo.isPrivate,
    isFork: repo.isFork,
    isArchived: repo.isArchived,
    language: repo.language,
    pushed: pushedLabel(repo.pushedAt, nowMs, language),
    pushedMs: pushedMsOf(repo.pushedAt),
    description: repo.description,
    webUrl: repo.webUrl,
    cloneUrl: cloneUrlOf(repo.webUrl),
  }));
}

/** Columns of the remote list that can be sorted on. */
export type RemoteSortKey =
  | "repo"
  | "owner"
  | "visibility"
  | "language"
  | "pushed"
  | "description";

export type RemoteSortState = SortState<RemoteSortKey>;

/** What one row contributes to a sorted column. Missing values sort as empty. */
function sortValue(row: RemoteRepoRow, key: RemoteSortKey): string | number {
  switch (key) {
    case "repo":
      return row.fullName.toLowerCase();
    case "owner":
      return ownershipRank(row.ownership);
    case "visibility":
      // Public then private: the displayed label is translated, so it cannot be the key.
      return row.isPrivate ? 1 : 0;
    case "language":
      return row.language?.toLowerCase() ?? "";
    case "pushed":
      // The column shows a relative label, so the raw timestamp is what sorts.
      return row.pushedMs ?? -1;
    case "description":
      return (row.description ?? "").toLowerCase();
    default:
      return 0;
  }
}

/** Stable ordering for the list; a null sort keeps whatever order the read returned. */
export function sortRows(
  rows: RemoteRepoRow[],
  sort: RemoteSortState,
): RemoteRepoRow[] {
  if (!sort) return rows;
  const direction = sort.ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, sort.key);
    const right = sortValue(b, sort.key);
    if (left === right) return 0;
    return (left < right ? -1 : 1) * direction;
  });
}

/** Keyword matches the full name, description, and language; an empty keyword returns
 * the rows unchanged. */
export function filterRows(
  rows: RemoteRepoRow[],
  keyword: string,
): RemoteRepoRow[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) =>
    [row.fullName, row.description ?? "", row.language ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/**
 * Which copy to pair with gh's message on a failed read. Null means the read really
 * succeeded (even if the list is empty).
 */
function failureOf(kind: RemoteReposKind): RemotesNotice | null {
  switch (kind) {
    case "notInstalled":
      return {
        tone: "warn",
        titleKey: "remotes.notInstalled.title",
        hintKey: "remotes.notInstalled.hint",
        detail: null,
      };
    case "notLoggedIn":
      return {
        tone: "warn",
        titleKey: "remotes.notLoggedIn.title",
        hintKey: "remotes.notLoggedIn.hint",
        detail: null,
      };
    case "error":
      return {
        tone: "error",
        titleKey: "remotes.error.title",
        hintKey: "remotes.error.hint",
        detail: null,
      };
    default:
      return null;
  }
}

/**
 * What to tell the user. First whether the read succeeded, then why the result is
 * empty (the account genuinely has no repos, or the filter removed them all).
 */
export function noticeOf(
  payload: WireRemoteReposPayload,
  shown: number,
  keyword: string,
): RemotesNotice | null {
  const failure = failureOf(payload.kind);
  if (failure) return { ...failure, detail: payload.error };
  if (payload.repos.length === 0) {
    return {
      tone: "empty",
      titleKey: "remotes.empty.title",
      hintKey: "remotes.empty.hint",
      detail: null,
    };
  }
  if (shown === 0) {
    return {
      tone: "empty",
      titleKey: "remotes.filtered.title",
      hintKey: "remotes.filtered.hint",
      params: { keyword: keyword.trim() },
      detail: null,
    };
  }
  return null;
}

/** Both the repo name and the clone URL must be copyable; the clone URL is never shown. */
export function copyTextOf(row: RemoteRepoRow, what: "name" | "clone"): string {
  return what === "name" ? row.fullName : row.cloneUrl;
}