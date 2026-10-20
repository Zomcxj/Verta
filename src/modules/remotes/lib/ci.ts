import type { MessageKey } from "@/modules/i18n";
import type { WireRepoCiPayload, WireRepoCiRun } from "@/lib/native";

/**
 * 一行 CI 该显示什么。文案是 i18n 键，色调决定颜色，`url` 有值就点得开。
 *
 * 纯函数：从 gh 的结果推出「说什么、什么颜色、点哪里」，组件只管画。
 */
export type CiView = {
  key: MessageKey;
  tone: CiTone;
  /** 点开去看这次运行的地址；没有运行时是 null。 */
  url: string | null;
  /** 鼠标停上去时的说明：workflow 名字、分支、跑没跑完等。 */
  detail: string | null;
};

export type CiTone = "ok" | "fail" | "running" | "unknown";

/** 状态色调对应的类名。CI 列的徽标与运行列表共用一套，免得两处颜色走偏。 */
export const TONE_CLASS: Record<CiTone, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  fail: "border-destructive/50 text-destructive",
  running: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  unknown: "border-border/60 text-muted-foreground",
};

/** 运行状态的两三个字段 —— CI 那条与运行列表的每一行都只需要这些。 */
type RunStateInput = Pick<WireRepoCiRun, "status" | "conclusion">;

/**
 * status + conclusion 折成一句话和一个色调。
 *
 * 没跑完时 `conclusion` 是空的，这时候看 `status`；跑完了才看结论。CI 列的徽标与运行
 * 列表的每一行都走这里，两处不会各折一套、各说各话。
 */
export function runState(run: RunStateInput): { key: MessageKey; tone: CiTone } {
  if (!run.conclusion) {
    return {
      key: run.status === "in_progress" ? "remotes.ci.running" : "remotes.ci.queued",
      tone: "running",
    };
  }

  const tone: CiTone =
    run.conclusion === "success"
      ? "ok"
      : run.conclusion === "failure" || run.conclusion === "timed_out"
        ? "fail"
        : "unknown";

  const key: MessageKey =
    run.conclusion === "success"
      ? "remotes.ci.success"
      : // 超时算失败那一档：色调是红的，话就得跟着说「失败」，别红底配一句「已结束」。
        run.conclusion === "failure" || run.conclusion === "timed_out"
        ? "remotes.ci.failure"
        : run.conclusion === "cancelled"
          ? "remotes.ci.cancelled"
          : run.conclusion === "skipped"
            ? "remotes.ci.skipped"
            : "remotes.ci.other";

  return { key, tone };
}

/** 运行的一行说明：workflow 名 · 分支 · #号。缺的字段不留下多余分隔符。 */
export function runDetail(
  run: Pick<WireRepoCiRun, "name" | "headBranch" | "runNumber">,
): string {
  return [run.name, run.headBranch, `#${run.runNumber}`]
    .filter((part) => part && String(part).trim().length > 0)
    .join(" · ");
}

/** 把一次 CI 查询的结果折成界面要的那一行。 */
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
  const state = runState(run);
  const detail = runDetail(run);

  return {
    key: state.key,
    tone: state.tone,
    url: run.url,
    // 有结论时把它缀在最后，鼠标停上去能一眼看出是 success 还是 failure。
    detail: run.conclusion ? `${detail} · ${run.conclusion}` : detail,
  };
}