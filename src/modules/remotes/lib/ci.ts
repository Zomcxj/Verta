import type { MessageKey } from "@/modules/i18n";
import type { WireRepoCiPayload } from "@/lib/native";

/**
 * 一行 CI 该显示什么。文案是 i18n 键，色调决定颜色，`url` 有值就点得开。
 *
 * 纯函数：从 gh 的结果推出「说什么、什么颜色、点哪里」，组件只管画。
 */
export type CiView = {
  key: MessageKey;
  tone: "ok" | "fail" | "running" | "unknown";
  /** 点开去看这次运行的地址；没有运行时是 null。 */
  url: string | null;
  /** 鼠标停上去时的说明：workflow 名字、分支、耗没跑完等。 */
  detail: string | null;
};

/** 把 status + conclusion 折成一句话和一个色调。 */
export function ciView(payload: WireRepoCiPayload | null): CiView {
  if (!payload) {
    return { key: "remotes.ci.idle", tone: "unknown", url: null, detail: null };
  }

  if (payload.kind === "none") {
    return { key: "remotes.ci.none", tone: "unknown", url: null, detail: null };
  }

  if (payload.kind !== "ready" || !payload.run) {
    // 失败与「没装 gh / 没登录」分开说：一个是这条查不动，一个是整块能力都没有。
    return {
      key:
        payload.kind === "notInstalled"
          ? "remotes.ci.notInstalled"
          : payload.kind === "notLoggedIn"
            ? "remotes.ci.notLoggedIn"
            : "remotes.ci.error",
      tone: "unknown",
      url: null,
      detail: payload.error,
    };
  }

  const run = payload.run;
  const detail = [run.name, run.headBranch, `#${run.runNumber}`]
    .filter((part) => part && String(part).trim().length > 0)
    .join(" · ");

  // 还没跑完时 conclusion 是空的，这时候看 status。
  if (!run.conclusion) {
    const running = run.status === "in_progress";
    return {
      key: running ? "remotes.ci.running" : "remotes.ci.queued",
      tone: "running",
      url: run.url,
      detail,
    };
  }

  const tone: CiView["tone"] =
    run.conclusion === "success"
      ? "ok"
      : run.conclusion === "failure" || run.conclusion === "timed_out"
        ? "fail"
        : "unknown";

  return {
    key:
      run.conclusion === "success"
        ? "remotes.ci.success"
        : run.conclusion === "failure"
          ? "remotes.ci.failure"
          : run.conclusion === "cancelled"
            ? "remotes.ci.cancelled"
            : run.conclusion === "skipped"
              ? "remotes.ci.skipped"
              : "remotes.ci.other",
    tone,
    url: run.url,
    detail: `${detail} · ${run.conclusion}`,
  };
}