import { describe, expect, it } from "vitest";
import type { WireRepoActionRun } from "@/lib/native";
import { logClock, logLineTone, runRowView, timeLabel, withoutRun } from "./runs";

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
    const view = runRowView(run(), Date.now());
    expect(view.canRerun).toBe(true);
    expect(view.canCancel).toBe(false);
    // 删除同理：GitHub 不允许删正在跑的那条，所以跑完了才给。
    expect(view.canDelete).toBe(true);
  });

  it("正在跑或排队时只能取消，不该给重跑或删除", () => {
    for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
      const view = runRowView(run({ status, conclusion: null }), Date.now());
      expect(view.canCancel, status).toBe(true);
      expect(view.canRerun, status).toBe(false);
      expect(view.canDelete, status).toBe(false);
    }
  });

  it("状态词与说明跟 CI 列走同一套（不另折一套）", () => {
    const failed = runRowView(
      run({ conclusion: "failure", runNumber: 48, headBranch: "release/1.2" }),
      Date.now(),
    );
    expect(failed.key).toBe("remotes.ci.failure");
    expect(failed.tone).toBe("fail");
    expect(failed.detail).toBe("CI · release/1.2 · #48");

    const going = runRowView(run({ status: "in_progress", conclusion: null }), Date.now());
    expect(going.key).toBe("remotes.ci.running");
    expect(going.tone).toBe("running");
  });

  it("时间解不出来时不装作有时间", () => {
    expect(runRowView(run({ updatedAt: "不是时间" }), Date.now()).when).toBeNull();
    expect(runRowView(run({ updatedAt: null }), Date.now()).when).toBeNull();
    expect(runRowView(run(), Date.now()).when).not.toBeNull();
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
    // 没有这条时原样返回，不抛错。
    expect(withoutRun(runs, 99).map((r) => r.id)).toEqual([3, 2, 1]);
  });
});

describe("timeLabel", () => {
  it("只认能解析的 ISO8601", () => {
    expect(timeLabel(null, Date.now())).toBeNull();
    expect(timeLabel("", Date.now())).toBeNull();
    expect(timeLabel("2026-10-20T10:00:00Z", Date.parse("2026-10-20T10:05:00Z"))).toBeTruthy();
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
    // 「error」出现在句中不算错误行，否则几乎所有构建输出都会被涂红。
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