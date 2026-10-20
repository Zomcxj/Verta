import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  native,
  type WireRepoActionRun,
  type WireRepoActionRunsPayload,
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { TONE_CLASS } from "./lib/ci";
import { RunDetail } from "./RunDetail";
import { runRowView } from "./lib/runs";

type Props = {
  /** 要看运行记录的仓库全名；null 表示弹窗关着。 */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
};

type PendingAction = { run: WireRepoActionRun; what: "rerun" | "cancel" };

/**
 * 某个仓库的运行记录。
 *
 * 列表按需读（打开弹窗时读一次，最近 20 条）。重跑与取消都会在你账号上真发生点什么，
 * 所以都先确认；失败时把 gh 的原话留在确认框里，而不是只弹一句「失败了」——比如对一次
 * 已经跑完的运行点取消，GitHub 会给一句明确的话，那正是用户要看的。
 */
export function RunListDialog({ repo, onOpenChange }: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireRepoActionRunsPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文。 */
  const [fatal, setFatal] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  /** 动作失败时 gh 的原话，留在确认框里。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 展开看详情的某次运行；null 表示还停在列表上。 */
  const [detail, setDetail] = useState<WireRepoActionRun | null>(null);

  const load = useCallback(async () => {
    if (!repo) return;
    setReading(true);
    setFatal(null);
    try {
      setPayload(await native.githubRepoRuns(repo));
    } catch (e) {
      setPayload(null);
      setFatal(String(e));
    } finally {
      setReading(false);
    }
  }, [repo]);

  useEffect(() => {
    if (!repo) {
      // 关掉时把上一次的状态清干净，下次打开不会先闪一眼旧数据。
      setPayload(null);
      setFatal(null);
      setPending(null);
      setActionError(null);
      setDetail(null);
      return;
    }
    void load();
  }, [repo, load]);

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
  };

  const run = async () => {
    if (!pending || !repo) return;
    const { run: target, what } = pending;
    setBusy(true);
    setActionError(null);
    try {
      const result =
        what === "rerun"
          ? await native.githubRunRerun(repo, target.id)
          : await native.githubRunCancel(repo, target.id);
      if (result.kind !== "ready") {
        // 失败不是「停在中间态」，原文留着，再试一次或收手由用户决定。
        setActionError(result.error ?? t("remotes.ci.error"));
        return;
      }
      setPending(null);
      toast.success(
        what === "rerun"
          ? t("remotes.runs.done.rerun")
          : t("remotes.runs.done.cancel"),
      );
      // 成功之后先收确认框再刷新：刷新出了问题不该让确认框看起来像失败。
      await load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const job = pending ? runRowView(pending.run, Date.now()) : null;

  return (
    <>
      <Dialog open={repo !== null} onOpenChange={close}>
        <DialogContent className={detail ? "sm:max-w-3xl" : "sm:max-w-2xl"}>
          {detail ? (
            <RunDetail
              repo={repo ?? ""}
              run={detail}
              onBack={() => setDetail(null)}
            />
          ) : (
            <>
              <DialogHeader>
            <DialogTitle>
              {t("remotes.runs.title", { repo: repo ?? "" })}
            </DialogTitle>
            <DialogDescription>{t("remotes.runs.hint")}</DialogDescription>
          </DialogHeader>

          {fatal ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap text-xs text-destructive">
                {fatal}
              </p>
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                {t("remotes.runs.retry")}
              </Button>
            </div>
          ) : reading && !payload ? (
            <p className="text-xs text-muted-foreground">
              {t("remotes.runs.loading")}
            </p>
          ) : payload && payload.runs.length === 0 ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {payload.kind === "ready" || payload.kind === "none"
                ? t("remotes.runs.empty")
                : (payload.error ?? t("remotes.ci.error"))}
            </p>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full table-fixed border-collapse text-xs">
                <tbody>
                  {(payload?.runs ?? []).map((item) => {
                    const view = runRowView(item, Date.now());
                    return (
                      <tr
                        key={item.id}
                        className="border-t border-border/40 align-middle"
                      >
                        <td className="w-[16%] py-1.5 pr-2">
                          <span
                            title={view.detail}
                            className={cn(
                              "rounded border px-1 text-[10px] leading-4 whitespace-nowrap",
                              TONE_CLASS[view.tone],
                            )}
                          >
                            {t(view.key)}
                          </span>
                        </td>
                        <td className="truncate py-1.5 pr-2">
                          <span className="text-foreground">{view.detail}</span>
                        </td>
                        <td className="w-[24%] truncate py-1.5 pr-2 text-muted-foreground">
                          {/* 原始 conclusion 照原样显示：像 action_required 这种
                              徽标翻不出来的值，用户得自己看得到，别只留在 title 里。 */}
                          {[item.event, item.conclusion, view.when]
                            .filter(Boolean)
                            .join(" · ")}
                        </td>
                        <td className="w-[22%] py-1.5 text-right whitespace-nowrap">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[11px]"
                            onClick={() => setDetail(item)}
                          >
                            {t("remotes.runs.action.detail")}
                          </Button>
                          {view.canRerun ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-[11px]"
                              onClick={() => {
                                setActionError(null);
                                setPending({ run: item, what: "rerun" });
                              }}
                            >
                              {t("remotes.runs.action.rerun")}
                            </Button>
                          ) : null}
                          {view.canCancel ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-[11px] text-destructive"
                              onClick={() => {
                                setActionError(null);
                                setPending({ run: item, what: "cancel" });
                              }}
                            >
                              {t("remotes.runs.action.cancel")}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (busy) return;
          if (!next) {
            setPending(null);
            setActionError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.what === "cancel"
                ? t("remotes.runs.cancel.title", {
                    number: pending.run.runNumber,
                  })
                : t("remotes.runs.rerun.title", {
                    number: pending?.run.runNumber ?? 0,
                  })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {job?.detail ? `${job.detail} · ` : ""}
              {pending?.what === "cancel"
                ? t("remotes.runs.cancel.hint")
                : t("remotes.runs.rerun.hint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError ? (
            <p className="whitespace-pre-wrap text-xs text-destructive">
              {actionError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setActionError(null);
              }}
            >
              {actionError ? t("remotes.runs.giveUp") : t("scm.common.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void run()}>
              {busy
                ? t("remotes.runs.working")
                : actionError
                  ? t("remotes.runs.retryAction")
                  : t("remotes.runs.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}