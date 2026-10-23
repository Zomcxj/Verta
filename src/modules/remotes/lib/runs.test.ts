import { describe, expect, it } from "vitest";
import type { WireRepoActionRun, WireRepoActionRunsPayload } from "@/lib/native";
import {
  ciFromRuns,
  logClock,
  logLineTone,
  runRowView,
  timeLabel,
  withoutRun,
} from "./runs";

function run(over: Partial<WireRepoActionRun> = {}): WireRepoActionRun {
  return {
    id: 1,
    name: "CI",
    status: "completed",
    conclusion: "success",
    runNumber: 10,
    headBranch: "main",
    event: "push",
    createdAt: "2026-10-20T10:00:00Z",
    updatedAt: "2026-10-20T10:05:00Z",
    url: "https://github.com/a/b/actions/runs/1",
    ...over,
  };
}

describe("runRowView", () => {
  it("跑完了才能重跑，这时候不该给取消", () => {
    const view = runRowView(run(), Date.now(), "zh");
    expect(view.canRerun).toBe(true);
    expect(view.canCancel).toBe(false);
    // Same reason as delete: GitHub refuses to remove a running one, so it only appears once finished.
    expect(view.canDelete).toBe(true);
  });

  it("正在跑或排队时只能取消，不该给重跑或删除", () => {
    for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
      const view = runRowView(run({ status, conclusion: null }), Date.now(), "zh");
      expect(view.canCancel, status).toBe(true);
      expect(view.canRerun, status).toBe(false);
      expect(view.canDelete, status).toBe(false);
    }
  });

  it("状态词与说明跟 CI 列走同一套（不另折一套）", () => {
    const failed = runRowView(
      run({ conclusion: "failure", runNumber: 48, headBranch: "release/1.2" }),
      Date.now(),
      "zh",
    );
    expect(failed.key).toBe("remotes.ci.failure");
    expect(failed.tone).toBe("fail");
    expect(failed.detail).toBe("CI · release/1.2 · #48");

    const going = runRowView(run({ status: "in_progress", conclusion: null }), Date.now(), "zh");
    expect(going.key).toBe("remotes.ci.running");
    expect(going.tone).toBe("running");
  });

  it("时间解不出来时不装作有时间", () => {
    expect(runRowView(run({ updatedAt: "不是时间" }), Date.now(), "zh").when).toBeNull();
    expect(runRowView(run({ updatedAt: null }), Date.now(), "zh").when).toBeNull();
    expect(runRowView(run(), Date.now(), "zh").when).not.toBeNull();
  });

  // The row time follows the UI language: an English UI must not get Chinese.
  it("words the run time in English when asked for English", () => {
    const now = Date.parse("2026-10-20T10:05:00Z");
    const view = runRowView(
      run({ updatedAt: "2026-10-20T10:00:00Z" }),
      now,
      "en",
    );
    expect(view.when).toBe("5 min ago");
  });
});

describe("withoutRun", () => {
  it("按 id 拿掉一条，其余顺序不变", () => {
    const runs = [
      run({ id: 3, runNumber: 3 }),
      run({ id: 2, runNumber: 2 }),
      run({ id: 1, runNumber: 1 }),
    ];
    expect(withoutRun(runs, 2).map((r) => r.id)).toEqual([3, 1]);
    // An id that is not there returns the list unchanged instead of throwing.
    expect(withoutRun(runs, 99).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("timeLabel", () => {
  it("只认能解析的 ISO8601", () => {
    expect(timeLabel(null, Date.now(), "zh")).toBeNull();
    expect(timeLabel("", Date.now(), "zh")).toBeNull();
    expect(timeLabel("2026-10-20T10:00:00Z", Date.parse("2026-10-20T10:05:00Z"), "zh")).toBeTruthy();
  });

  // The label follows the UI language: an English UI must not get Chinese.
  it("words the clock in English when asked for English", () => {
    expect(
      timeLabel("2026-10-20T10:00:00Z", Date.parse("2026-10-20T10:05:00Z"), "en"),
    ).toBe("5 min ago");
  });
});

describe("logLineTone", () => {
  it("认出 GitHub 的错误与警告标记", () => {
    expect(logLineTone("##[error]Process completed with exit code 1.")).toBe("error");
    expect(logLineTone("error: could not compile `verta`")).toBe("error");
    expect(logLineTone("##[warning]Node.js 16 actions are deprecated")).toBe("warn");
    expect(logLineTone("warning: unused import")).toBe("warn");
    expect(logLineTone("##[group]Run cargo test")).toBe("group");
  });

  it("认不出来就按普通行，不猜", () => {
    expect(logLineTone("   Compiling verta v0.0.1")).toBe("plain");
    expect(logLineTone("")).toBe("plain");
    // "error" mid-sentence is not an error line, or nearly every build log would come back red.
    expect(logLineTone("no error found in the log")).toBe("plain");
  });
});

describe("logClock", () => {
  it("从时间戳里取时分秒", () => {
    expect(logClock("2026-10-20T14:24:56.8724283Z")).toBe("14:24:56");
    expect(logClock("2026-10-20T14:24:56Z")).toBe("14:24:56");
  });

  it("认不出来就留空，不编时间", () => {
    expect(logClock("")).toBe("");
    expect(logClock("no timestamp here")).toBe("");
  });
});

describe("ciFromRuns", () => {
  const payload = (over: Partial<WireRepoActionRunsPayload> = {}) => ({
    kind: "ready" as const,
    repo: "a/b",
    runs: [] as WireRepoActionRun[],
    error: null,
    ...over,
  });

  it("最新那条就是徽标，别的字段不带过去", () => {
    const out = ciFromRuns(
      payload({
        runs: [run({ id: 9, runNumber: 9, status: "in_progress", conclusion: null })],
      }),
    );
    expect(out.kind).toBe("ready");
    expect(out.run).toEqual({
      name: "CI",
      status: "in_progress",
      conclusion: null,
      runNumber: 9,
      headBranch: "main",
      updatedAt: "2026-10-20T10:05:00Z",
      url: "https://github.com/a/b/actions/runs/1",
    });
  });

  it("列表空了就是「没有运行记录」，不是失败", () => {
    // Deleting the last run lands here: the badge should say there is no run, not keep showing the removed one.
    const out = ciFromRuns(payload({ runs: [] }));
    expect(out.kind).toBe("none");
    expect(out.run).toBeNull();
    expect(out.error).toBeNull();
  });

  it("查不动原样透传，两种说法不打架", () => {
    for (const kind of ["none", "notInstalled", "notLoggedIn", "error"] as const) {
      const out = ciFromRuns(payload({ kind, runs: [run()], error: "gh 原话" }));
      expect(out.kind).toBe(kind);
      expect(out.run).toBeNull();
      expect(out.error).toBe("gh 原话");
    }
  });
});