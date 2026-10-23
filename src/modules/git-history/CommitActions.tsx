import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useState } from "react";
import { toast } from "sonner";

type ActionKind = "cherry-pick" | "revert" | "reset-soft";

type Props = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  /** Refresh after history changes (re-reads the commit list). */
  onChanged: () => void;
};

/**
 * Three actions on a commit. All of them change repo state, so each confirms first and
 * a failure keeps git's own words in the dialog; a conflict leaves git paused
 * mid-operation, which is exited with "abort".
 */
export function CommitActions({ repoRoot, sha, shortSha, onChanged }: Props) {
  const t = useT();
  const [kind, setKind] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (next: ActionKind) => {
    setKind(next);
    setError(null);
  };
  const close = () => {
    if (busy) return;
    setKind(null);
    setError(null);
  };

  const run = async () => {
    if (!kind || busy) return;
    const action = kind;
    setBusy(true);
    setError(null);
    try {
      if (action === "cherry-pick") {
        await native.gitCherryPick(repoRoot, sha);
      } else if (action === "revert") {
        await native.gitRevertCommit(repoRoot, sha);
      } else {
        await native.gitResetSoft(repoRoot, sha);
      }
    } catch (e) {
      // Conflicts and a dirty worktree have to be visible as-is; the dialog stays open
      // so the user decides the next step.
      setError(String(e));
      setBusy(false);
      return;
    }
    // git succeeded: close the dialog first. The refresh is only cleanup, and a problem
    // there must not make the dialog look like a failure.
    setKind(null);
    setBusy(false);
    toast.message(
      action === "cherry-pick"
        ? t("scm.commit.cherryPicked")
        : action === "revert"
          ? t("scm.commit.reverted")
          : t("scm.commit.resetSoftDone"),
    );
    try {
      onChanged();
    } catch (e) {
      toast.error(String(e));
    }
  };

  const abort = async () => {
    if (!kind || busy) return;
    const action = kind;
    // Abort means "back out of this step": close the dialog first and only report a
    // failure via a toast.
    setBusy(true);
    setKind(null);
    setError(null);
    try {
      await native.gitAbortOperation(
        repoRoot,
        action === "revert" ? "revert" : "cherry-pick",
      );
      toast.message(t("scm.commit.aborted"));
      onChanged();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    kind === "cherry-pick"
      ? t("scm.commit.confirmCherryPickTitle", { shortSha })
      : kind === "revert"
        ? t("scm.commit.confirmRevertTitle", { shortSha })
        : t("scm.commit.confirmResetSoftTitle", { shortSha });

  const body =
    kind === "cherry-pick"
      ? t("scm.commit.confirmCherryPickBody")
      : kind === "revert"
        ? t("scm.commit.confirmRevertBody")
        : t("scm.commit.confirmResetSoftBody");

  // Revert and cherry-pick can stop mid-conflict; a soft reset cannot, so it gets no
  // abort button.
  const canAbort = kind === "cherry-pick" || kind === "revert";

  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className="h-6 cursor-pointer px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => open("cherry-pick")}
      >
        {t("scm.commit.cherryPick")}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="h-6 cursor-pointer px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => open("revert")}
      >
        {t("scm.commit.revert")}
      </Button>
      <Button
        size="xs"
        variant="ghost"
        className="h-6 cursor-pointer px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => open("reset-soft")}
      >
        {t("scm.commit.resetSoft")}
      </Button>

      <AlertDialog open={kind !== null} onOpenChange={(next) => !next && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{body}</AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <div className="space-y-1">
              <p className="whitespace-pre-wrap text-xs text-destructive">
                {error}
              </p>
              {canAbort ? (
                <p className="text-xs text-muted-foreground">
                  {t("scm.commit.conflictHint")}
                </p>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {t("scm.common.cancel")}
            </Button>
            {error && canAbort ? (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void abort()}
              >
                {kind === "revert"
                  ? t("scm.commit.abortRevert")
                  : t("scm.commit.abortCherryPick")}
              </Button>
            ) : null}
            {/* A failure is not always "paused midway": a dirty worktree only needs
                fixing before another try, so keep the confirm button. */}
            <Button onClick={() => void run()} disabled={busy}>
              {error ? t("scm.commit.retry") : t("scm.common.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}