import type {
  WireIssueListPayload,
  WireIssueSummary,
  WirePullRequestInfo,
} from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";
import { relativeTime } from "@/modules/launcher";

/** An issue / PR as shown in the UI: the wire fields plus a display-ready time label. */
export type IssueRow = {
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  isDraft: boolean;
  merged: boolean;
  author: string;
  /** Relative time; null when the date cannot be parsed. */
  when: string | null;
  /** Comment count. */
  comments: number;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  /** Locked items cannot be commented on. */
  locked: boolean;
};

/** Kind filter. */
export type IssueKindFilter = "all" | "issue" | "pr";
/** State filter. */
export type IssueStateFilter = "open" | "closed" | "all";

export type IssueFilters = {
  kind: IssueKindFilter;
  state: IssueStateFilter;
  keyword: string;
};

export type IssueListKind = WireIssueListPayload["kind"];

/**
 * What to tell the user when the list is empty or unreadable; null when there is
 * content to render. The copy is an i18n key, and the tone picks the styling of
 * the notice block.
 */
export type IssueNotice = {
  tone: "empty" | "warn" | "error";
  titleKey: MessageKey;
  hintKey: MessageKey;
  /** gh's own words on failure; null when genuinely empty or empty after filtering. */
  detail: string | null;
};

/** Convert one wire entry into a UI row. */
export function toRow(issue: WireIssueSummary, nowMs: number): IssueRow {
  const ms = issue.createdAt ? Date.parse(issue.createdAt) : Number.NaN;
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    isPullRequest: issue.isPullRequest,
    isDraft: issue.isDraft,
    merged: issue.merged,
    author: issue.author,
    when: Number.isFinite(ms) ? relativeTime(nowMs, ms) : null,
    comments: issue.comments,
    labels: issue.labels,
    assignees: issue.assignees,
    htmlUrl: issue.htmlUrl,
    locked: issue.locked,
  };
}

/** Convert a whole wire page into UI rows. */
export function toRows(
  payload: WireIssueListPayload,
  nowMs: number,
): IssueRow[] {
  return payload.issues.map((issue) => toRow(issue, nowMs));
}

/**
 * Three-way filter: kind, state, keyword.
 *
 * With the "closed" state **merged PRs count too**: on GitHub a merge makes the
 * PR closed, so filtering them out would make the user think the PR vanished.
 */
export function filterRows(
  rows: IssueRow[],
  filters: IssueFilters,
): IssueRow[] {
  const keyword = filters.keyword.trim().toLowerCase();
  // `#20` and `20` are the same thing: a number search should not fail just
  // because of an extra hash.
  const number = keyword.replace(/^#/, "");
  return rows.filter((row) => {
    if (filters.kind === "issue" && row.isPullRequest) return false;
    if (filters.kind === "pr" && !row.isPullRequest) return false;
    if (filters.state === "open" && row.state !== "open") return false;
    if (filters.state === "closed" && row.state !== "closed") return false;
    if (!keyword) return true;
    return (
      row.title.toLowerCase().includes(keyword) ||
      String(row.number) === keyword ||
      String(row.number) === number ||
      row.author.toLowerCase().includes(keyword)
    );
  });
}

/**
 * What to say when the list is unreadable or empty; null when there is content to
 * render.
 *
 * "Nothing here" and "the query failed" must stay distinct: one means the repo
 * really has no issues, the other means we never got them.
 */
export function issueNotice(
  payload: WireIssueListPayload | null,
  reading: boolean,
): IssueNotice | null {
  if (!payload) {
    if (reading) return null;
    return {
      tone: "error",
      titleKey: "remotes.issues.error.title",
      hintKey: "remotes.issues.error.hint",
      detail: null,
    };
  }
  if (payload.kind === "notInstalled") {
    return {
      tone: "warn",
      titleKey: "remotes.issues.notInstalled.title",
      hintKey: "remotes.issues.notInstalled.hint",
      detail: payload.error,
    };
  }
  if (payload.kind === "notLoggedIn") {
    return {
      tone: "warn",
      titleKey: "remotes.issues.notLoggedIn.title",
      hintKey: "remotes.issues.notLoggedIn.hint",
      detail: payload.error,
    };
  }
  if (payload.kind === "error") {
    return {
      tone: "error",
      titleKey: "remotes.issues.error.title",
      hintKey: "remotes.issues.error.hint",
      detail: payload.error,
    };
  }
  if (payload.kind === "none" || payload.issues.length === 0) {
    return {
      tone: "empty",
      titleKey: "remotes.issues.empty.title",
      hintKey: "remotes.issues.empty.hint",
      detail: null,
    };
  }
  return null;
}

/**
 * Whether the merge button should be disabled right now, as a **reason code**
 * (merged / closed / draft / conflict / computing / unknown).
 *
 * The backend only supplies the code and the UI looks up the copy by code
 * (`remotes.issues.mergeBlocked.*`): "can it merge" is decided in exactly one
 * place, while the sentence shown to the user has to follow the UI language.
 */
export function mergeBlocked(pull: WirePullRequestInfo | null): string | null {
  return pull?.mergeBlocked ?? null;
}

/** Tone for a check status, consistent with the CI badge in the repo list. */
export function checkTone(
  state: "pass" | "fail" | "pending" | "partial" | "none",
): "ok" | "bad" | "busy" | "none" {
  switch (state) {
    case "pass":
      return "ok";
    case "fail":
      return "bad";
    case "pending":
      return "busy";
    default:
      return "none";
  }
}

/** Display label for a diff size: `+12 −3`. */
export function changeLabel(pull: WirePullRequestInfo | null): string | null {
  if (!pull) return null;
  return `+${pull.additions} −${pull.deletions}`;
}
