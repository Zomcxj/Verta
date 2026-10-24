import { describe, expect, it } from "vitest";
import type { WireRemoteRepo, WireRemoteReposPayload } from "@/lib/native";
import {
  cloneUrlOf,
  copyTextOf,
  filterRows,
  noticeOf,
  pushedLabel,
  sortRows,
  toRows,
} from "./rows";

const NOW = Date.parse("2026-10-18T12:00:00Z");

const repo = (over: Partial<WireRemoteRepo> = {}): WireRemoteRepo => ({
  fullName: "Zomcxj/verta",
  owner: "Zomcxj",
  name: "verta",
  isPrivate: false,
  isFork: false,
  isArchived: false,
  language: "Rust",
  pushedAt: "2026-10-18T09:00:00Z",
  description: "desktop workbench",
  webUrl: "https://github.com/Zomcxj/verta",
  ...over,
});

const payload = (
  over: Partial<WireRemoteReposPayload> = {},
): WireRemoteReposPayload => ({
  kind: "ready",
  login: "Zomcxj",
  accountName: null,
  repos: [],
  truncated: false,
  error: null,
  ...over,
});

describe("cloneUrlOf", () => {
  it("tacks .git on, and tolerates a trailing slash", () => {
    expect(cloneUrlOf("https://github.com/a/b")).toBe(
      "https://github.com/a/b.git",
    );
    expect(cloneUrlOf("https://github.com/a/b/")).toBe(
      "https://github.com/a/b.git",
    );
  });

  it("stays empty when there is no address to work from", () => {
    expect(cloneUrlOf("")).toBe("");
  });
});

describe("pushedLabel", () => {
  it("folds GitHub's ISO timestamps into the panel's relative wording", () => {
    expect(pushedLabel("2026-10-18T09:00:00Z", NOW, "zh")).toBe("3 小时前");
    expect(pushedLabel("2026-08-01T00:00:00Z", NOW, "zh")).toBe("2026-08-01");
  });

  it("returns null when there is no usable timestamp", () => {
    expect(pushedLabel(null, NOW, "zh")).toBeNull();
    expect(pushedLabel("not a date", NOW, "zh")).toBeNull();
  });

  // The label follows the UI language: English must not fall back to Chinese.
  it("words the push time in English when asked for English", () => {
    expect(pushedLabel("2026-10-18T09:00:00Z", NOW, "en")).toBe("3 h ago");
  });
});

describe("toRows", () => {
  it("carries the wire fields over and derives the clone address", () => {
    const [row] = toRows(payload({ repos: [repo()] }), NOW, "zh");
    expect(row).toEqual({
      fullName: "Zomcxj/verta",
      owner: "Zomcxj",
      name: "verta",
      ownership: "mine",
      isPrivate: false,
      isFork: false,
      isArchived: false,
      language: "Rust",
      pushed: "3 小时前",
      pushedMs: Date.parse("2026-10-18T09:00:00Z"),
      description: "desktop workbench",
      webUrl: "https://github.com/Zomcxj/verta",
      cloneUrl: "https://github.com/Zomcxj/verta.git",
    });
  });

  it("keeps a missing language and description as null instead of inventing text", () => {
    const [row] = toRows(
      payload({ repos: [repo({ language: null, description: null })] }),
      NOW,
      "zh",
    );
    expect(row.language).toBeNull();
    expect(row.description).toBeNull();
  });

  it("has no push time to sort on when GitHub's timestamp cannot be parsed", () => {
    const [row] = toRows(
      payload({ repos: [repo({ pushedAt: "not a date" })] }),
      NOW,
      "zh",
    );
    expect(row.pushed).toBeNull();
    expect(row.pushedMs).toBeNull();
  });

  // The account is only known when gh answered with one: without it every row would be
  // labelled, and half of those labels would be wrong.
  it("leaves ownership unknown when the listing carries no login", () => {
    const [row] = toRows(payload({ login: null, repos: [repo()] }), NOW, "zh");
    expect(row.ownership).toBe("unknown");
  });

  it("tells repositories owned by other accounts apart from the account's own", () => {
    const rows = toRows(
      payload({
        repos: [
          repo({ owner: "Zomcxj", fullName: "Zomcxj/verta" }),
          repo({ owner: "V-lambow", fullName: "V-lambow/QTTD" }),
        ],
      }),
      NOW,
      "zh",
    );
    expect(rows.map((row) => row.ownership)).toEqual(["mine", "others"]);
  });
});

describe("sortRows", () => {
  const rows = toRows(
    payload({
      repos: [
        repo({ fullName: "Zomcxj/beta", language: "Rust" }),
        repo({
          fullName: "ai-fusion/alpha",
          owner: "ai-fusion",
          language: null,
          isPrivate: true,
          pushedAt: "2026-10-18T11:00:00Z",
          description: null,
        }),
        repo({
          fullName: "Zomcxj/gamma",
          isPrivate: false,
          pushedAt: null,
          description: "zebra",
        }),
      ],
    }),
    NOW,
    "zh",
  );
  const names = (sorted: typeof rows) => sorted.map((row) => row.fullName);

  it("keeps the read order when no column is sorted", () => {
    expect(names(sortRows(rows, null))).toEqual(names(rows));
  });

  it("sorts by repository name in both directions", () => {
    expect(names(sortRows(rows, { key: "repo", ascending: true }))).toEqual([
      "ai-fusion/alpha",
      "Zomcxj/beta",
      "Zomcxj/gamma",
    ]);
    expect(names(sortRows(rows, { key: "repo", ascending: false }))).toEqual([
      "Zomcxj/gamma",
      "Zomcxj/beta",
      "ai-fusion/alpha",
    ]);
  });

  // The column shows a relative label, so a sort on it has to use the raw timestamp:
  // "3 小时前" and "1 小时前" are strings that order the wrong way round.
  it("sorts push time by the timestamp rather than by the label it shows", () => {
    expect(names(sortRows(rows, { key: "pushed", ascending: false }))).toEqual([
      "ai-fusion/alpha",
      "Zomcxj/beta",
      "Zomcxj/gamma",
    ]);
    expect(names(sortRows(rows, { key: "pushed", ascending: true }))).toEqual([
      "Zomcxj/gamma",
      "Zomcxj/beta",
      "ai-fusion/alpha",
    ]);
  });

  // The column shows one of three labels; the account's own repositories come first, then
  // other people's, then the ones we could not tell (no account read).
  it("sorts ownership with the account's own repositories first", () => {
    expect(names(sortRows(rows, { key: "owner", ascending: true }))).toEqual([
      "Zomcxj/beta",
      "Zomcxj/gamma",
      "ai-fusion/alpha",
    ]);
    expect(names(sortRows(rows, { key: "owner", ascending: false }))).toEqual([
      "ai-fusion/alpha",
      "Zomcxj/beta",
      "Zomcxj/gamma",
    ]);
  });

  it("sorts visibility with public first, and missing text sorts as empty", () => {    expect(names(sortRows(rows, { key: "visibility", ascending: true }))).toEqual([
      "Zomcxj/beta",
      "Zomcxj/gamma",
      "ai-fusion/alpha",
    ]);
    expect(names(sortRows(rows, { key: "language", ascending: true }))).toEqual([
      "ai-fusion/alpha",
      "Zomcxj/beta",
      "Zomcxj/gamma",
    ]);
    expect(
      names(sortRows(rows, { key: "description", ascending: false })),
    ).toEqual(["Zomcxj/gamma", "Zomcxj/beta", "ai-fusion/alpha"]);
  });
});

describe("filterRows", () => {
  const rows = toRows(
    payload({
      repos: [
        repo(),
        repo({
          fullName: "ai-fusion/video",
          owner: "ai-fusion",
          name: "video",
          language: "Python",
          description: "视频流水线",
          isPrivate: true,
          webUrl: "https://github.com/ai-fusion/video",
        }),
      ],
    }),
    NOW,
    "zh",
  );

  it("matches the full name, the description and the language, case-insensitively", () => {
    expect(filterRows(rows, "VERTA").map((row) => row.fullName)).toEqual([
      "Zomcxj/verta",
    ]);
    expect(filterRows(rows, "python").map((row) => row.fullName)).toEqual([
      "ai-fusion/video",
    ]);
    expect(filterRows(rows, "视频").map((row) => row.fullName)).toEqual([
      "ai-fusion/video",
    ]);
  });

  it("returns the same list for a blank keyword", () => {
    expect(filterRows(rows, "   ")).toBe(rows);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterRows(rows, "no-such-repo")).toEqual([]);
  });
});

describe("copyTextOf", () => {
  it("copies the repository name or the clone address", () => {
    const [row] = toRows(payload({ repos: [repo()] }), NOW, "zh");
    expect(copyTextOf(row, "name")).toBe("Zomcxj/verta");
    expect(copyTextOf(row, "clone")).toBe("https://github.com/Zomcxj/verta.git");
  });
});

describe("noticeOf", () => {
  it("stays silent when there are rows to draw", () => {
    expect(noticeOf(payload({ repos: [repo()] }), 1, "")).toBeNull();
  });

  it("tells a genuinely empty account apart from a failed read", () => {
    const notice = noticeOf(payload(), 0, "");
    expect(notice?.tone).toBe("empty");
    expect(notice?.titleKey).toBe("remotes.empty.title");
    expect(notice?.detail).toBeNull();
  });

  it("names the keyword when the filter is what emptied the table", () => {
    const notice = noticeOf(payload({ repos: [repo()] }), 0, " nope ");
    expect(notice?.titleKey).toBe("remotes.filtered.title");
    expect(notice?.params).toEqual({ keyword: "nope" });
  });

  it("reports gh trouble with gh's own words, never as an empty account", () => {
    const notLoggedIn = noticeOf(
      payload({ kind: "notLoggedIn", error: "gh auth login" }),
      0,
      "",
    );
    expect(notLoggedIn?.tone).toBe("warn");
    expect(notLoggedIn?.titleKey).toBe("remotes.notLoggedIn.title");
    expect(notLoggedIn?.detail).toBe("gh auth login");

    const notInstalled = noticeOf(
      payload({ kind: "notInstalled", error: "gh not found" }),
      0,
      "",
    );
    expect(notInstalled?.titleKey).toBe("remotes.notInstalled.title");
    expect(notInstalled?.detail).toBe("gh not found");

    const failed = noticeOf(payload({ kind: "error", error: "HTTP 403" }), 0, "");
    expect(failed?.tone).toBe("error");
    expect(failed?.titleKey).toBe("remotes.error.title");
    expect(failed?.detail).toBe("HTTP 403");
  });
});