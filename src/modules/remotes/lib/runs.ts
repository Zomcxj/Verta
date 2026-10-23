import type { MessageKey } from "@/modules/i18n";
import type { Language } from "@/modules/i18n/language";
import { relativeTime } from "@/modules/launcher";
import type {
  WireRepoActionRun,
  WireRepoActionRunsPayload,
  WireRepoCiPayload,
} from "@/lib/native";
import { runDetail, runState, type CiTone } from "./ci";

/**
 * What a run-list row shows, and whether it can be rerun/cancelled right now.
 *
 * Pure function: the rules live here and the dialog only renders and sends
 * commands.
 */
export type RunRowView = {
  key: MessageKey;
  tone: CiTone;
  /** `CI · main · #10`. */
  detail: string;
  /** Relative time; null when GitHub omits it or it cannot be parsed. */
  when: string | null;
  /** Only finished runs can be rerun: GitHub rejects it while one is in flight. */
  canRerun: boolean;
  /** Cancelling only applies while a run is queued or in progress. */
  canCancel: boolean;
  /** Only finished runs can be deleted; GitHub refuses to delete an active one. */
  canDelete: boolean;
};

// GitHub statuses meaning "not finished yet". Everything else (completed) counts as finished.
const UNFINISHED: readonly string[] = [
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
];

export function runRowView(
  run: WireRepoActionRun,
  nowMs: number,
  language: Language,
): RunRowView {
  const state = runState(run);
  return {
    key: state.key,
    tone: state.tone,
    detail: runDetail(run),
    when: timeLabel(run.updatedAt, nowMs, language),
    canRerun: run.status === "completed",
    canCancel: UNFINISHED.includes(run.status),
    canDelete: run.status === "completed",
  };
}

/** GitHub supplies ISO8601; when it cannot be parsed we do not pretend there is a time. */
export function timeLabel(
  iso: string | null,
  nowMs: number,
  language: Language,
): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? relativeTime(nowMs, ms, language) : null;
}

/**
 * Assign a tone to a log line by content.
 *
 * GitHub logs express errors and warnings through inline markers (`##[error]`)
 * or prefixes (`error:`), with no other structure; anything unrecognised stays a
 * plain line; never guess.
 */
export function logLineTone(text: string): "error" | "warn" | "group" | "plain" {
  const trimmed = text.trim();
  if (trimmed.includes("##[error]") || /^error\b/i.test(trimmed)) return "error";
  if (trimmed.includes("##[warning]") || /^warning\b/i.test(trimmed)) return "warn";
  if (trimmed.startsWith("##[group]")) return "group";
  return "plain";
}

/** Fold a log-line timestamp (`2026-10-20T14:24:56.87Z`) into `14:24:56`; empty string
 * when it cannot be parsed. */
export function logClock(time: string): string {
  const t = time.indexOf("T");
  if (t < 0) return "";
  const tail = time.slice(t + 1);
  const end = tail.search(/[.Zz]/);
  return (end < 0 ? tail : tail.slice(0, end)).trim();
}

/**
 * Drop a run from the list.
 *
 * After a delete the UI has to agree with the toast immediately; the row cannot
 * linger waiting for a refetch. GitHub sometimes lags, so the removed id is
 * remembered and filtered out of refresh results as well.
 */
export function withoutRun(
  runs: WireRepoActionRun[],
  id: number,
): WireRepoActionRun[] {
  return runs.filter((run) => run.id !== id);
}

/**
 * Derive the row's CI badge from the run list: the newest run is the badge.
 *
 * Badge and runs panel describe the same thing, so they should have one source:
 * once the panel has loaded (including the reconcile after a delete) it updates
 * the badge from this result, avoiding contradictions like a badge saying
 * "cancelled" while the newest run in the panel succeeded.
 */
export function ciFromRuns(
  payload: WireRepoActionRunsPayload,
): WireRepoCiPayload {
  if (payload.kind !== "ready") {
    // Pass none / notInstalled / notLoggedIn / error through unchanged so badge and
    // panel say the same thing.
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