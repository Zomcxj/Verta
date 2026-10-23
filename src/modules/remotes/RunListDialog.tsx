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
  type WireRepoPermissionPayload,
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { useT, type MessageKey } from "@/modules/i18n";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { TONE_CLASS } from "./lib/ci";
import {
  LIST_SNAPSHOT_TTL_MS,
  PERMISSION_SNAPSHOT_TTL_MS,
  readListSnapshot,
  writeListSnapshot,
} from "./lib/listSnapshot";
import { canWrite, readOnlyHintKey } from "./lib/permission";
import { RunDetail } from "./RunDetail";
import { runRowView, withoutRun } from "./lib/runs";

type Props = {
  /** Full name of the repo whose runs are shown; null when the dialog is closed. */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after every successful read of the run list.
   *
   * This panel is the single source of truth for "what state is this repo in":
   * the row's CI badge updates from its newest run, so badge and panel never
   * disagree.
   */
  onLoaded?: (payload: WireRepoActionRunsPayload) => void;
};

type PendingAction = { run: WireRepoActionRun; what: "rerun" | "cancel" | "delete" };

// Copy keys per action: confirm-dialog title (with the run number), hint, success toast.
const ACTION_TEXT: Record<
  PendingAction["what"],
  { title: MessageKey; hint: MessageKey; done: MessageKey }
> = {
  rerun: {
    title: "remotes.runs.rerun.title",
    hint: "remotes.runs.rerun.hint",
    done: "remotes.runs.done.rerun",
  },
  cancel: {
    title: "remotes.runs.cancel.title",
    hint: "remotes.runs.cancel.hint",
    done: "remotes.runs.done.cancel",
  },
  delete: {
    title: "remotes.runs.delete.title",
    hint: "remotes.runs.delete.hint",
    done: "remotes.runs.done.delete",
  },
};

/**
 * Run history for one repo.
 *
 * The list is read on demand (once on open, latest 20). Rerun and cancel really
 * do something on your account, so both confirm first; on failure gh's own words
 * stay in the confirm dialog instead of a bare "failed": cancelling an
 * already-finished run, for instance, earns a specific message from GitHub, and
 * that is exactly what the user needs to see.
 */
export function RunListDialog({ repo, onOpenChange, onLoaded }: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireRepoActionRunsPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** Raw message when the command itself failed (no `kind` at all). */
  const [fatal, setFatal] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  /** gh's own words when an action failed; kept in the confirm dialog. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Run opened in detail view; null while still on the list. */
  const [detail, setDetail] = useState<WireRepoActionRun | null>(null);
  /** Ids of just-deleted runs: dropped from the list immediately and filtered out
   * of refreshes too (GitHub lags behind). */
  const [deletedIds, setDeletedIds] = useState<number[]>([]);
  /** Permission on this repo: only affects whether write buttons show; reads still work. */
  const [permission, setPermission] = useState<WireRepoPermissionPayload | null>(
    null,
  );
  const writable = canWrite(permission);
  const readOnlyHint = readOnlyHintKey(permission);

  /**
   * Check permission once on open.
   *
   * Kept separate from the run list: the list refreshes after every action, but
   * permission does not change because of a rerun, so there is no reason to ask
   * again. When the lookup fails it stays null, and `canWrite(null)` means "render
   * as if allowed" so GitHub gets to refuse.
   */
  useEffect(() => {
    if (!repo) {
      setPermission(null);
      return;
    }
    const key = `permission:${repo}`;
    const cached = readListSnapshot<WireRepoPermissionPayload>(
      key,
      PERMISSION_SNAPSHOT_TTL_MS,
    );
    if (cached) {
      setPermission(cached);
      return;
    }
    setPermission(null);
    let alive = true;
    native
      .githubRepoPermission(repo)
      .then((payload) => {
        writeListSnapshot(key, payload);
        if (alive) setPermission(payload);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo]);

  const load = useCallback(async () => {
    if (!repo) return;
    setReading(true);
    setFatal(null);
    try {
      const payload = await native.githubRepoRuns(repo);
      writeListSnapshot(`runs:${repo}`, payload);
      setPayload(payload);
      // The badge follows the panel: one fact, one source.
      onLoaded?.(payload);
    } catch (e) {
      setPayload(null);
      setFatal(String(e));
    } finally {
      setReading(false);
    }
  }, [repo, onLoaded]);

  useEffect(() => {
    if (!repo) {
      // Clear the previous state on close so reopening does not flash stale data.
      setPayload(null);
      setFatal(null);
      setPending(null);
      setActionError(null);
      setDetail(null);
      setDeletedIds([]);
      return;
    }
    // Reopening the same repo inside the snapshot window is served from the last
    // read: this panel is read-only, and every action below refreshes it.
    const cached = readListSnapshot<WireRepoActionRunsPayload>(
      `runs:${repo}`,
      LIST_SNAPSHOT_TTL_MS,
    );
    if (cached) {
      setPayload(cached);
      onLoaded?.(cached);
      return;
    }
    void load();
  }, [repo, load, onLoaded]);

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
          : what === "cancel"
            ? await native.githubRunCancel(repo, target.id)
            : await native.githubRunDelete(repo, target.id);
      if (result.kind !== "ready") {
        // A failure is not a "stuck midway" state: keep the raw message and let the
        // user retry or back out.
        setActionError(result.error ?? t("remotes.ci.error"));
        return;
      }
      setPending(null);
      if (what === "delete") {
        // Delete: the row and the toast must go together. The refresh only
        // reconciles, and even a late one must not bring the row back.
        setDeletedIds((prev) => [...prev, target.id]);
        setPayload((prev) =>
          prev ? { ...prev, runs: withoutRun(prev.runs, target.id) } : prev,
        );
      }
      toast.success(t(ACTION_TEXT[what].done));
      // Close the confirm dialog before refreshing: a refresh problem must not make
      // the action look like a failure.
      await load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const job = pending ? runRowView(pending.run, Date.now()) : null;
  // Hide just-deleted runs: GitHub may still list them in a refresh.
  const visibleRuns = (payload?.runs ?? []).filter(
    (item) => !deletedIds.includes(item.id),
  );

  return (
    <>
      <Dialog open={repo !== null} onOpenChange={close}>
        <DialogContent
          className={detail ? "sm:max-w-3xl" : "sm:max-w-2xl"}
          // The confirm dialog (AlertDialog) is another Radix layer portalled
          // outside body, so clicking it counts as "outside the panel" and closes the
          // panel too (leaving the user thinking they misclicked).
          onInteractOutside={(event) => {
            if (pending !== null) event.preventDefault();
          }}
        >
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
            {readOnlyHint ? (
              <p className="text-xs text-muted-foreground">{t(readOnlyHint)}</p>
            ) : null}
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
          ) : payload && visibleRuns.length === 0 ? (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {payload.kind === "ready" || payload.kind === "none"
                ? t("remotes.runs.empty")
                : (payload.error ?? t("remotes.ci.error"))}
            </p>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full table-fixed border-collapse text-xs">
                <tbody>
                  {visibleRuns.map((item) => {
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
                          {/* Show the raw conclusion: values the badge cannot map,
                              such as action_required, have to be visible, not just
                              hidden in a title attribute. */}
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
                          {view.canRerun && writable ? (
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
                          {view.canCancel && writable ? (
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
                          {view.canDelete && writable ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-[11px] text-destructive"
                              onClick={() => {
                                setActionError(null);
                                setPending({ run: item, what: "delete" });
                              }}
                            >
                              {t("remotes.runs.action.delete")}
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
              {t(ACTION_TEXT[pending?.what ?? "rerun"].title, {
                number: pending?.run.runNumber ?? 0,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {job?.detail ? `${job.detail} · ` : ""}
              {t(ACTION_TEXT[pending?.what ?? "rerun"].hint)}
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