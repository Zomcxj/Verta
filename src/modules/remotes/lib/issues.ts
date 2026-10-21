import type {
  WireIssueListPayload,
  WireIssueSummary,
  WirePullRequestInfo,
} from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";
import { relativeTime } from "@/modules/launcher";

/** 界面上一条 issue / PR：wire 字段之外，加上显示用的时间文案。 */
export type IssueRow = {
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  isDraft: boolean;
  merged: boolean;
  author: string;
  /** 相对时间；日期解不出来时是 null。 */
  when: string | null;
  /** 评论条数。 */
  comments: number;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  /** 锁了的不能评论。 */
  locked: boolean;
};

/** 类型筛选。 */
export type IssueKindFilter = "all" | "issue" | "pr";
/** 状态筛选。 */
export type IssueStateFilter = "open" | "closed" | "all";

export type IssueFilters = {
  kind: IssueKindFilter;
  state: IssueStateFilter;
  keyword: string;
};

export type IssueListKind = WireIssueListPayload["kind"];

/**
 * 列表为空或读不到时界面上该说什么，有内容要画列表时是 null。
 * 文案是 i18n 键，色调决定提示块的样子。
 */
export type IssueNotice = {
  tone: "empty" | "warn" | "error";
  titleKey: MessageKey;
  hintKey: MessageKey;
  /** 失败时 gh 的原话；真空态与筛空时是 null。 */
  detail: string | null;
};

/** wire 的一条转成界面的一行。 */
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

/** wire 的整页转成界面的一批行。 */
export function toRows(
  payload: WireIssueListPayload,
  nowMs: number,
): IssueRow[] {
  return payload.issues.map((issue) => toRow(issue, nowMs));
}

/**
 * 三维筛选：类型、状态、关键字。
 *
 * 状态筛「已关闭」时**已合并的 PR 也算数** —— GitHub 那边合完就是 closed，
 * 界面上要是把它滤掉，用户会觉得这个 PR 不见了。
 */
export function filterRows(
  rows: IssueRow[],
  filters: IssueFilters,
): IssueRow[] {
  const keyword = filters.keyword.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.kind === "issue" && row.isPullRequest) return false;
    if (filters.kind === "pr" && !row.isPullRequest) return false;
    if (filters.state === "open" && row.state !== "open") return false;
    if (filters.state === "closed" && row.state !== "closed") return false;
    if (!keyword) return true;
    return (
      row.title.toLowerCase().includes(keyword) ||
      String(row.number) === keyword ||
      row.author.toLowerCase().includes(keyword)
    );
  });
}

/**
 * 列表读不到 / 为空时该说点什么；有内容要画列表时是 null。
 *
 * 「一条都没有」和「查失败了」必须分开：前者是仓库真没开 issue，后者是没取到。
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
 * 合并按钮现在该不该禁着，以及禁的**原因码**（merged / closed / draft / conflict /
 * computing / unknown）。
 *
 * 后端只给码，界面按码取文案（`remotes.issues.mergeBlocked.*`）：「能不能合」只有一处
 * 说了算，而说给用户听的那句话得跟着界面语言走。
 */
export function mergeBlocked(pull: WirePullRequestInfo | null): string | null {
  return pull?.mergeBlocked ?? null;
}

/** 检查状态的色调：跟仓库列表的 CI 徽标一个口径。 */
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

/** 改动量的展示文案：`+12 −3`。 */
export function changeLabel(pull: WirePullRequestInfo | null): string | null {
  if (!pull) return null;
  return `+${pull.additions} −${pull.deletions}`;
}
