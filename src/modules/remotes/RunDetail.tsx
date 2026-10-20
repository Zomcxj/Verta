import { Button } from "@/components/ui/button";
import {
  native,
  type WireRepoActionRun,
  type WireRepoRunJobsPayload,
  type WireRepoRunLogPayload,
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { TONE_CLASS, runState } from "./lib/ci";
import { logClock, logLineTone, timeLabel } from "./lib/runs";

type Props = {
  repo: string;
  run: WireRepoActionRun;
  onBack: () => void;
};

const LOG_TONE_CLASS: Record<ReturnType<typeof logLineTone>, string> = {
  error: "text-destructive",
  warn: "text-amber-600 dark:text-amber-500",
  group: "text-sky-600 dark:text-sky-400",
  plain: "",
};

/**
 * 一次运行的详情：job / step 树 + 日志。
 *
 * 都在软件内看，不在浏览器里看 —— 只有「完整日志」这种情况例外（一次能取的量有上限，
 * 截断时会把「在 GitHub 打开」放在显眼处，让人知道还有更多）。
 */
export function RunDetail({ repo, run, onBack }: Props) {
  const t = useT();
  const [jobs, setJobs] = useState<WireRepoRunJobsPayload | null>(null);
  const [log, setLog] = useState<WireRepoRunLogPayload | null>(null);
  const [reading, setReading] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文。 */
  const [fatal, setFatal] = useState<string | null>(null);

  const loadLog = useCallback(
    async (onlyFailed: boolean) => {
      setReading(true);
      setFatal(null);
      try {
        setLog(await native.githubRunLog(repo, run.id, onlyFailed));
      } catch (e) {
        setLog(null);
        setFatal(String(e));
      } finally {
        setReading(false);
      }
    },
    [repo, run.id],
  );

  useEffect(() => {
    let cancelled = false;
    setJobs(null);
    setLog(null);
    setFatal(null);
    setFailedOnly(false);
    void native
      .githubRunJobs(repo, run.id)
      .then((payload) => {
        if (!cancelled) setJobs(payload);
      })
      .catch((e) => {
        if (!cancelled) setFatal(String(e));
      });
    void loadLog(false);
    return () => {
      cancelled = true;
    };
  }, [repo, run.id, loadLog]);

  const state = runState(run);
  const now = Date.now();
  // 日志行没有 id，序号就是它的标识；顺手把「上一行的步骤」算好，用来只在步骤变化时显示。
  const numberedLines = (log?.lines ?? []).map((line, i) => ({
    line,
    id: i,
    previous: i > 0 ? log?.lines[i - 1]?.step : undefined,
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={onBack}
        >
          ← {t("remotes.runs.detail.back")}
        </Button>
        <span
          className={cn(
            "rounded border px-1 text-[10px] leading-4 whitespace-nowrap",
            TONE_CLASS[state.tone],
          )}
        >
          {t(state.key)}
        </span>
        <span className="truncate text-sm">
          {run.name} · #{run.runNumber}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {[run.headBranch, run.event, timeLabel(run.updatedAt, now)]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="grow" />
        {/* 日志被截断时这条路是必须的；平时也只是个次要出口。 */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => void openUrl(run.url).catch(console.error)}
        >
          {t("remotes.runs.detail.inGithub")}
        </Button>
      </div>

      {fatal ? (
        <p className="font-mono text-xs whitespace-pre-wrap text-destructive">
          {fatal}
        </p>
      ) : null}

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          {t("remotes.runs.detail.jobs")}
        </p>
        {jobs && jobs.jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {jobs.kind === "ready" || jobs.kind === "none"
              ? t("remotes.runs.detail.noJobs")
              : (jobs.error ?? t("remotes.ci.error"))}
          </p>
        ) : (
          (jobs?.jobs ?? []).map((job) => {
            const jobState = runState(job);
            return (
              <div
                key={job.id}
                className="rounded border border-border/40 px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded border px-1 text-[10px] leading-4 whitespace-nowrap",
                      TONE_CLASS[jobState.tone],
                    )}
                  >
                    {t(jobState.key)}
                  </span>
                  <span className="truncate text-xs text-foreground">
                    {job.name}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {[job.runner, timeLabel(job.startedAt, now)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="grow" />
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t("remotes.runs.detail.steps", { count: job.steps.length })}
                  </span>
                </div>
                {job.steps.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {job.steps.map((step) => {
                      const stepState = runState(step);
                      return (
                        <li
                          key={`${job.id}-${step.number}-${step.name}`}
                          className="flex items-center gap-2 pl-2"
                        >
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              stepState.tone === "ok"
                                ? "bg-emerald-500"
                                : stepState.tone === "fail"
                                  ? "bg-destructive"
                                  : "bg-muted-foreground/50",
                            )}
                          />
                          <span className="truncate text-[11px]">{step.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t(stepState.key)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("remotes.runs.detail.log")}
          </p>
          <Button
            variant={failedOnly ? "secondary" : "ghost"}
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            onClick={() => {
              const next = !failedOnly;
              setFailedOnly(next);
              void loadLog(next);
            }}
          >
            {t("remotes.runs.detail.failedOnly")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px]"
            disabled={reading}
            onClick={() => void loadLog(failedOnly)}
          >
            {t("remotes.runs.detail.reload")}
          </Button>
          <span className="grow" />
          {reading ? (
            <span className="text-[11px] text-muted-foreground">
              {t("remotes.runs.detail.loading")}
            </span>
          ) : null}
        </div>

        {log?.clipped ? (
          <p className="text-[11px] text-muted-foreground">
            {t("remotes.runs.detail.clipped", {
              total: log.totalLines,
              shown: log.lines.length,
            })}
          </p>
        ) : null}
        {log?.capped ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-500">
            {t("remotes.runs.detail.capped")}
          </p>
        ) : null}

        {log && log.lines.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {log.kind === "ready"
              ? failedOnly
                ? t("remotes.runs.detail.emptyFailed")
                : t("remotes.runs.detail.emptyLog")
              : (log.error ?? t("remotes.ci.error"))}
          </p>
        ) : (
          <div className="max-h-[42vh] overflow-auto rounded border border-border/40 bg-muted/30 p-2 font-mono text-[11px] leading-4">
            {(numberedLines).map(({ line, id, previous }) => {
              const tone = logLineTone(line.text);
              return (
                <div key={id} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground/70">
                    {logClock(line.time)}
                  </span>
                  <span className="w-40 shrink-0 truncate text-muted-foreground/70">
                    {line.step !== previous ? line.step : ""}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 whitespace-pre-wrap break-all",
                      LOG_TONE_CLASS[tone],
                    )}
                  >
                    {line.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}