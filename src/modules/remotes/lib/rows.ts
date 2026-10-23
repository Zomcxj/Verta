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

/** Push time: GitHub gives ISO8601, folded into the panel's relative time; when it
 * cannot be parsed we do not pretend there is a time. */
export function pushedLabel(
  pushedAt: string | null,
  nowMs: number,
  language: Language,
): string | null {
  if (!pushedAt) return null;
  const ms = Date.parse(pushedAt);
  if (!Number.isFinite(ms)) return null;
  return relativeTime(nowMs, ms, language);
}

export function toRows(
  payload: WireRemoteReposPayload,
  nowMs: number,
  language: Language,
): RemoteRepoRow[] {
  return payload.repos.map((repo) => ({
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    isPrivate: repo.isPrivate,
    isFork: repo.isFork,
    isArchived: repo.isArchived,
    language: repo.language,
    pushed: pushedLabel(repo.pushedAt, nowMs, language),
    description: repo.description,
    webUrl: repo.webUrl,
    cloneUrl: cloneUrlOf(repo.webUrl),
  }));
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