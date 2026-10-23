import type { MessageKey } from "@/modules/i18n";
import type { WireRepoCiPayload, WireRepoCiRun } from "@/lib/native";

/**
 * What one CI row shows. The copy is an i18n key, the tone picks the color, and a
 * non-null `url` makes it clickable.
 *
 * Pure function: it derives "what to say, which color, where it goes" from gh's
 * result, and the component only renders it.
 */
export type CiView = {
  key: MessageKey;
  tone: CiTone;
  /** URL that opens this run; null when there is no run. */
  url: string | null;
  /** Tooltip text: workflow name, branch, whether it finished, and so on. */
  detail: string | null;
};

export type CiTone = "ok" | "fail" | "running" | "unknown";

/** Class names per status tone. The CI column badge and the runs list share one set
 * so the colors cannot drift apart. */
export const TONE_CLASS: Record<CiTone, string> = {
  ok: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  fail: "border-destructive/50 text-destructive",
  running: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  unknown: "border-border/60 text-muted-foreground",
};

/** The couple of run fields both the CI badge and each runs-list row need. */
type RunStateInput = Pick<WireRepoCiRun, "status" | "conclusion">;

/**
 * Fold status + conclusion into one message and one tone.
 *
 * While a run is unfinished `conclusion` is empty and `status` decides; only a
 * finished run looks at its conclusion. The CI badge and every runs-list row go
 * through here, so the two cannot fold their own versions and disagree.
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
      : // A timeout counts as a failure: if the tone is red, the copy has to say
        // "failed" too rather than red with "finished".
        run.conclusion === "failure" || run.conclusion === "timed_out"
        ? "remotes.ci.failure"
        : run.conclusion === "cancelled"
          ? "remotes.ci.cancelled"
          : run.conclusion === "skipped"
            ? "remotes.ci.skipped"
            : "remotes.ci.other";

  return { key, tone };
}

/** One-line run description: workflow name · branch · #number. Missing fields leave
 * no dangling separators. */
export function runDetail(
  run: Pick<WireRepoCiRun, "name" | "headBranch" | "runNumber">,
): string {
  return [run.name, run.headBranch, `#${run.runNumber}`]
    .filter((part) => part && String(part).trim().length > 0)
    .join(" · ");
}

/** Fold a CI query result into the row the UI needs. */
export function ciView(payload: WireRepoCiPayload | null): CiView {
  if (!payload) {
    return { key: "remotes.ci.idle", tone: "unknown", url: null, detail: null };
  }

  if (payload.kind === "none") {
    return { key: "remotes.ci.none", tone: "unknown", url: null, detail: null };
  }

  if (payload.kind !== "ready" || !payload.run) {
    // Keep failure distinct from "gh missing / not logged in": one row cannot be
    // checked, the other has no capability at all.
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
    // Append the conclusion when there is one, so hovering shows success vs failure
    // at a glance.
    detail: run.conclusion ? `${detail} · ${run.conclusion}` : detail,
  };
}