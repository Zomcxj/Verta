import { describe, expect, it } from "vitest";
import type { WireRepoActionRun } from "@/lib/native";
import { runRowView, timeLabel } from "./runs";

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
  });

  it("正在跑或排队时只能取消，不该给重跑", () => {
    for (const status of ["in_progress", "queued", "waiting", "requested", "pending"]) {
      const view = runRowView(run({ status, conclusion: null }), Date.now());
      expect(view.canCancel, status).toBe(true);
      expect(view.canRerun, status).toBe(false);
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

describe("timeLabel", () => {
  it("只认能解析的 ISO8601", () => {
    expect(timeLabel(null, Date.now())).toBeNull();
    expect(timeLabel("", Date.now())).toBeNull();
    expect(timeLabel("2026-10-20T10:00:00Z", Date.parse("2026-10-20T10:05:00Z"))).toBeTruthy();
  });
});