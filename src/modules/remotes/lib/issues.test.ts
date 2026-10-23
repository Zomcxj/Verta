import { describe, expect, it } from "vitest";
import type {
  WireIssueListPayload,
  WireIssueSummary,
  WirePullRequestInfo,
} from "@/lib/native";
import {
  changeLabel,
  checkTone,
  filterRows,
  issueNotice,
  mergeBlocked,
  toRow,
  toRows,
} from "./issues";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function issue(overrides: Partial<WireIssueSummary> = {}): WireIssueSummary {
  return {
    number: 1,
    title: "登录页在弱网下白屏",
    body: "复现步骤：开飞行模式再打开登录页",
    state: "open",
    isPullRequest: false,
    isDraft: false,
    merged: false,
    author: "Zomcxj",
    createdAt: "2026-10-20T12:00:00Z",
    updatedAt: null,
    comments: 2,
    labels: ["bug"],
    assignees: ["ann"],
    htmlUrl: "https://github.com/me/app/issues/1",
    locked: false,
    ...overrides,
  };
}

function payload(
  overrides: Partial<WireIssueListPayload> = {},
): WireIssueListPayload {
  return {
    kind: "ready",
    repo: "me/app",
    issues: [issue()],
    truncated: false,
    error: null,
    ...overrides,
  };
}

function pull(
  overrides: Partial<WirePullRequestInfo> = {},
): WirePullRequestInfo {
  return {
    head: "feature/x",
    headSha: "abc",
    base: "main",
    draft: false,
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    mergeBlocked: null,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    commits: 1,
    state: "open",
    author: "Zomcxj",
    createdAt: "2026-10-20T12:00:00Z",
    updatedAt: null,
    labels: [],
    assignees: [],
    htmlUrl: "https://github.com/me/app/pull/4",
    locked: false,
    ...overrides,
  };
}

describe("issue rows", () => {
  it("keeps the wire fields and renders the time", () => {
    const row = toRow(issue(), NOW);
    expect(row.number).toBe(1);
    expect(row.title).toBe("登录页在弱网下白屏");
    expect(row.comments).toBe(2);
    expect(row.labels).toEqual(["bug"]);
    expect(row.when).toBe("1 天前");
  });

  it("has no time when the date cannot be read", () => {
    const row = toRow(issue({ createdAt: null }), NOW);
    expect(row.when).toBeNull();
  });

  it("maps a whole page", () => {
    const rows = toRows(payload(), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(1);
  });
});

describe("filters", () => {
  const rows = toRows(
    payload({
      issues: [
        issue({ number: 1, title: "白屏" }),
        issue({
          number: 2,
          title: "加个登录按钮",
          isPullRequest: true,
          state: "open",
        }),
        issue({ number: 3, title: "修好了", state: "closed" }),
        issue({
          number: 4,
          title: "合并后的 PR",
          isPullRequest: true,
          state: "closed",
          merged: true,
        }),
      ],
    }),
    NOW,
  );

  it("keeps both kinds when no kind filter is on", () => {
    const out = filterRows(rows, { kind: "all", state: "all", keyword: "" });
    expect(out).toHaveLength(4);
  });

  it("filters to issues only", () => {
    const out = filterRows(rows, { kind: "issue", state: "all", keyword: "" });
    expect(out.map((row) => row.number)).toEqual([1, 3]);
  });

  it("filters to pull requests only", () => {
    const out = filterRows(rows, { kind: "pr", state: "all", keyword: "" });
    expect(out.map((row) => row.number)).toEqual([2, 4]);
  });

  it("filters by state", () => {
    const open = filterRows(rows, { kind: "all", state: "open", keyword: "" });
    expect(open.map((row) => row.number)).toEqual([1, 2]);
    const closed = filterRows(rows, {
      kind: "all",
      state: "closed",
      keyword: "",
    });
    expect(closed.map((row) => row.number)).toEqual([3, 4]);
  });

  it("searches the title, the number and the author", () => {
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: "白屏" }).map(
        (row) => row.number,
      ),
    ).toEqual([1]);
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: "2" }).map(
        (row) => row.number,
      ),
    ).toEqual([2]);
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: "zomcxj" }).map(
        (row) => row.number,
      ),
    ).toHaveLength(4);
  });

  it("searches the number with or without a leading #", () => {
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: "#2" }).map(
        (row) => row.number,
      ),
    ).toEqual([2]);
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: " #2 " }).map(
        (row) => row.number,
      ),
    ).toEqual([2]);
  });

  it("returns nothing when the keyword matches nothing", () => {
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: "没有这个" }),
    ).toHaveLength(0);
  });

  it("ignores a blank keyword", () => {
    expect(
      filterRows(rows, { kind: "all", state: "all", keyword: "   " }),
    ).toHaveLength(4);
  });
});

describe("notices", () => {
  it("says nothing while the first read is running", () => {
    expect(issueNotice(null, true)).toBeNull();
  });

  it("tells a failure apart from an empty repository", () => {
    const failed = issueNotice(
      payload({ kind: "error", issues: [], error: "boom" }),
      false,
    );
    expect(failed?.tone).toBe("error");
    expect(failed?.detail).toBe("boom");

    const empty = issueNotice(payload({ kind: "none", issues: [] }), false);
    expect(empty?.tone).toBe("empty");
    expect(empty?.detail).toBeNull();
  });

  it("warns when gh is missing or the account is not logged in", () => {
    const missing = issueNotice(
      payload({ kind: "notInstalled", issues: [], error: "没装 gh" }),
      false,
    );
    expect(missing?.tone).toBe("warn");
    const notLoggedIn = issueNotice(
      payload({ kind: "notLoggedIn", issues: [], error: "没登录" }),
      false,
    );
    expect(notLoggedIn?.tone).toBe("warn");
  });

  it("says nothing when there is a list to draw", () => {
    expect(issueNotice(payload(), false)).toBeNull();
  });
});

describe("merge gate", () => {
  it("is open when the backend says it can be merged", () => {
    expect(mergeBlocked(pull())).toBeNull();
  });

  it("passes the reason code through when it cannot", () => {
    // The backend sends only a code and the UI looks the sentence up, otherwise Chinese would appear in the English UI.
    expect(mergeBlocked(pull({ mergeBlocked: "conflict" }))).toBe("conflict");
  });

  it("has no reason when there is no pull request at all", () => {
    expect(mergeBlocked(null)).toBeNull();
  });
});

describe("small helpers", () => {
  it("maps the check state to a tone", () => {
    expect(checkTone("pass")).toBe("ok");
    // A partial view must not earn the "pass" green: the checks not seen may well be red.
    expect(checkTone("partial")).toBe("none");
    expect(checkTone("fail")).toBe("bad");
    expect(checkTone("pending")).toBe("busy");
    expect(checkTone("none")).toBe("none");
  });

  it("shows the change size", () => {
    expect(changeLabel(pull())).toBe("+12 −3");
    expect(changeLabel(null)).toBeNull();
  });
});
