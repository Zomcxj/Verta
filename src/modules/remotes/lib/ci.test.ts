import { describe, expect, it } from "vitest";
import type { WireRepoCiPayload, WireRepoCiRun } from "@/lib/native";
import { ciView, runDetail, runState } from "./ci";

function run(over: Partial<WireRepoCiRun> = {}): WireRepoCiRun {
  return {
    name: "CI",
    status: "completed",
    conclusion: "success",
    runNumber: 7,
    headBranch: "main",
    updatedAt: "2026-10-20T12:00:00Z",
    url: "https://github.com/a/b/actions/runs/1",
    ...over,
  };
}

function payload(over: Partial<WireRepoCiPayload> = {}): WireRepoCiPayload {
  return { kind: "ready", repo: "a/b", run: run(), error: null, ...over };
}

describe("ciView", () => {
  it("says nothing yet before a result arrives", () => {
    const view = ciView(null);
    expect(view.key).toBe("remotes.ci.idle");
    expect(view.url).toBeNull();
  });

  it("treats a clear empty answer as no CI, not as an error", () => {
    const view = ciView(payload({ kind: "none", run: null }));
    expect(view.key).toBe("remotes.ci.none");
    expect(view.tone).toBe("unknown");
  });

  it("maps success and failure to their own tone", () => {
    expect(ciView(payload()).tone).toBe("ok");
    expect(ciView(payload()).key).toBe("remotes.ci.success");
    const failed = ciView(payload({ run: run({ conclusion: "failure" }) }));
    expect(failed.tone).toBe("fail");
    expect(failed.key).toBe("remotes.ci.failure");
    // A timeout belongs in the failure bucket, not in "other".
    expect(ciView(payload({ run: run({ conclusion: "timed_out" }) })).tone).toBe(
      "fail",
    );
  });

  it("keeps a run that has not finished in the running bucket", () => {
    const progressing = ciView(
      payload({ run: run({ status: "in_progress", conclusion: null }) }),
    );
    expect(progressing.tone).toBe("running");
    expect(progressing.key).toBe("remotes.ci.running");
    expect(progressing.url).not.toBeNull();

    const waiting = ciView(
      payload({ run: run({ status: "queued", conclusion: null }) }),
    );
    expect(waiting.tone).toBe("running");
    expect(waiting.key).toBe("remotes.ci.queued");
  });

  it("still links to a run whose conclusion it does not know", () => {
    const odd = ciView(payload({ run: run({ conclusion: "neutral" }) }));
    expect(odd.key).toBe("remotes.ci.other");
    expect(odd.url).toBe("https://github.com/a/b/actions/runs/1");
  });

  it("separates a missing gh from a broken query", () => {
    expect(ciView(payload({ kind: "notInstalled", run: null })).key).toBe(
      "remotes.ci.notInstalled",
    );
    expect(ciView(payload({ kind: "notLoggedIn", run: null })).key).toBe(
      "remotes.ci.notLoggedIn",
    );
    const broken = ciView(
      payload({ kind: "error", run: null, error: "rate limited" }),
    );
    expect(broken.key).toBe("remotes.ci.error");
    // The failure's own wording is kept rather than a generic "something broke".
    expect(broken.detail).toBe("rate limited");
  });

  it("builds a detail line from name, branch and run number", () => {
    const view = ciView(payload());
    expect(view.detail).toBe("CI · main · #7 · success");
    // Missing fields leave no stray separator behind.
    const sparse = ciView(
      payload({ run: run({ name: "build", headBranch: null, runNumber: 0 }) }),
    );
    expect(sparse.detail).toBe("build · #0 · success");
  });
});

describe("runState", () => {
  it("把没跑完的状态都归到 running 那一档", () => {
    for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
      const state = runState({ status, conclusion: null });
      expect(state.tone, status).toBe("running");
    }
    expect(runState({ status: "in_progress", conclusion: null }).key).toBe(
      "remotes.ci.running",
    );
    expect(runState({ status: "queued", conclusion: null }).key).toBe(
      "remotes.ci.queued",
    );
  });

  it("跑完了就按 conclusion 说，认不出来的结论照实归「已结束」", () => {
    const cases: [string, string, string][] = [
      ["success", "remotes.ci.success", "ok"],
      ["failure", "remotes.ci.failure", "fail"],
      ["timed_out", "remotes.ci.failure", "fail"],
      ["cancelled", "remotes.ci.cancelled", "unknown"],
      ["skipped", "remotes.ci.skipped", "unknown"],
      ["neutral", "remotes.ci.other", "unknown"],
    ];
    for (const [conclusion, key, tone] of cases) {
      const state = runState({ status: "completed", conclusion });
      expect(state.key, conclusion).toBe(key);
      expect(state.tone, conclusion).toBe(tone);
    }
  });
});

describe("runDetail", () => {
  it("缺的字段不留下多余分隔符", () => {
    expect(runDetail({ name: "CI", headBranch: "main", runNumber: 7 })).toBe(
      "CI · main · #7",
    );
    expect(runDetail({ name: "CI", headBranch: null, runNumber: 7 })).toBe(
      "CI · #7",
    );
  });
});