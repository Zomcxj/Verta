import type { WireRemoteReposPayload } from "@/lib/native";
import { relativeTime } from "@/modules/launcher";
import type { RemoteReposKind, RemotesNotice, RemoteRepoRow } from "./types";

/** `git clone` 用的地址：GitHub 页面地址加 `.git`，尾斜杠先抹掉。 */
export function cloneUrlOf(webUrl: string): string {
  const trimmed = webUrl.replace(/\/+$/, "");
  return trimmed ? `${trimmed}.git` : "";
}

/** 推送时间：GitHub 给 ISO8601，折成面板那套相对时间；解不出来就不装作有时间。 */
export function pushedLabel(
  pushedAt: string | null,
  nowMs: number,
): string | null {
  if (!pushedAt) return null;
  const ms = Date.parse(pushedAt);
  if (!Number.isFinite(ms)) return null;
  return relativeTime(nowMs, ms);
}

export function toRows(
  payload: WireRemoteReposPayload,
  nowMs: number,
): RemoteRepoRow[] {
  return payload.repos.map((repo) => ({
    fullName: repo.fullName,
    owner: repo.owner,
    name: repo.name,
    isPrivate: repo.isPrivate,
    isFork: repo.isFork,
    isArchived: repo.isArchived,
    language: repo.language,
    pushed: pushedLabel(repo.pushedAt, nowMs),
    description: repo.description,
    webUrl: repo.webUrl,
    cloneUrl: cloneUrlOf(repo.webUrl),
  }));
}

/** 关键字匹配仓库全名、说明与语言；空关键字原样返回。 */
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
 * 读不到时 gh 的原话该配哪套文案。返回 null 说明这次真的读到了（哪怕列表是空的）。
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
 * 界面上该说点什么。先看这次读没读到，再看读到的东西为什么是空的
 * （账号上真没有仓库，还是被筛选框筛掉了）。
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

/** 仓库名与克隆地址都要能复制，克隆地址在界面上不显示。 */
export function copyTextOf(row: RemoteRepoRow, what: "name" | "clone"): string {
  return what === "name" ? row.fullName : row.cloneUrl;
}