import type { MessageKey } from "@/modules/i18n";
import { relativeTime } from "@/modules/launcher";
import type {
  WireRepoActionRun,
  WireRepoActionRunsPayload,
  WireRepoCiPayload,
} from "@/lib/native";
import { runDetail, runState, type CiTone } from "./ci";

/**
 * 运行列表里一行该显示什么，以及这一行现在能不能重跑/取消。
 *
 * 纯函数：规则集中在这里，弹窗只负责画和发命令。
 */
export type RunRowView = {
  key: MessageKey;
  tone: CiTone;
  /** `CI · main · #10`。 */
  detail: string;
  /** 相对时间；GitHub 没给或解不出来时是 null。 */
  when: string | null;
  /** 只有跑完了才能重跑 —— 正在跑的那条 GitHub 会拒绝。 */
  canRerun: boolean;
  /** 只有还在排队或正在跑才谈得上取消。 */
  canCancel: boolean;
  /** 只有跑完了才能删记录：GitHub 不允许删正在跑的那条。 */
  canDelete: boolean;
};

/// GitHub 的 status 里，这些算「还没结束」。其余（completed）算结束。
const UNFINISHED: readonly string[] = [
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
];

export function runRowView(run: WireRepoActionRun, nowMs: number): RunRowView {
  const state = runState(run);
  return {
    key: state.key,
    tone: state.tone,
    detail: runDetail(run),
    when: timeLabel(run.updatedAt, nowMs),
    canRerun: run.status === "completed",
    canCancel: UNFINISHED.includes(run.status),
    canDelete: run.status === "completed",
  };
}

/** GitHub 给 ISO8601；解不出来就不装作有时间。 */
export function timeLabel(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? relativeTime(nowMs, ms) : null;
}

/**
 * 日志行按内容分个色调。
 *
 * GitHub 的日志里错误/警告是靠行内标记（`##[error]`）或前缀（`error:`）表达的，没有别的结构；
 * 认不出来就按普通行，绝不猜。
 */
export function logLineTone(text: string): "error" | "warn" | "group" | "plain" {
  const trimmed = text.trim();
  if (trimmed.includes("##[error]") || /^error\b/i.test(trimmed)) return "error";
  if (trimmed.includes("##[warning]") || /^warning\b/i.test(trimmed)) return "warn";
  if (trimmed.startsWith("##[group]")) return "group";
  return "plain";
}

/** 日志行的时间戳（`2026-10-20T14:24:56.87Z`）折成 `14:24:56`；认不出来返回空串。 */
export function logClock(time: string): string {
  const t = time.indexOf("T");
  if (t < 0) return "";
  const tail = time.slice(t + 1);
  const end = tail.search(/[.Zz]/);
  return (end < 0 ? tail : tail.slice(0, end)).trim();
}

/**
 * 把某次运行从列表里拿掉。
 *
 * 删除成功后界面要立刻跟浮层对上（不能浮层说删了、行还杵在那儿等重新拉取）；GitHub 那侧
 * 有时还会慢一拍，所以拿掉的 id 也记着，刷新回来的结果里再把它滤掉。
 */
export function withoutRun(
  runs: WireRepoActionRun[],
  id: number,
): WireRepoActionRun[] {
  return runs.filter((run) => run.id !== id);
}

/**
 * 从运行列表推出那一行的 CI 徽标该显示什么 —— 最新那条就是徽标。
 *
 * 徽标与运行面板说的是同一件事，就该只有一个来源：面板读完（含删除后的重新对账）拿这里的结果
 * 去更新徽标，免得出现「徽标说已取消、面板里最新那条是成功」这种自相矛盾。
 */
export function ciFromRuns(
  payload: WireRepoActionRunsPayload,
): WireRepoCiPayload {
  if (payload.kind !== "ready") {
    // none / notInstalled / notLoggedIn / error 原样透传，徽标与面板说同一句话。
    return {
      kind: payload.kind,
      repo: payload.repo,
      run: null,
      error: payload.error,
    };
  }
  const newest = payload.runs[0];
  if (!newest) {
    return { kind: "none", repo: payload.repo, run: null, error: null };
  }
  return {
    kind: "ready",
    repo: payload.repo,
    run: {
      name: newest.name,
      status: newest.status,
      conclusion: newest.conclusion,
      runNumber: newest.runNumber,
      headBranch: newest.headBranch,
      updatedAt: newest.updatedAt,
      url: newest.url,
    },
    error: null,
  };
}