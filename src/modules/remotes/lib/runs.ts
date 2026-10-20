import type { MessageKey } from "@/modules/i18n";
import { relativeTime } from "@/modules/launcher";
import type { WireRepoActionRun } from "@/lib/native";
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
  };
}

/** GitHub 给 ISO8601；解不出来就不装作有时间。 */
export function timeLabel(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? relativeTime(nowMs, ms) : null;
}