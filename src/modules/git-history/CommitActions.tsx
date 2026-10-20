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
  /** 改动历史之后的刷新（重读提交列表）。 */
  onChanged: () => void;
};

/**
 * 提交上的三个动作。都会动仓库状态，所以先弹确认，跑失败就把 git 的原话留在
 * 弹窗里；冲突时 git 会停在中间状态，那一步用「中止」退出。
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
      // 冲突、脏工作区这些都要原样看见，弹窗留着让用户决定下一步。
      setError(String(e));
      setBusy(false);
      return;
    }
    // git 成功了：先收弹窗，刷新只是善后，它出问题不该让弹窗装成失败的样子。
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
    // 中止是「从这一步退出来」：先把弹窗收掉，失败才用浮层提示。
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

  // 还原与拣选都会停在冲突中间态；软撤回不会，所以不给它中止按钮。
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
            {/* 失败不总是「中途停下」：脏工作区这种修好就能再来一次，所以确定留着。 */}
            <Button onClick={() => void run()} disabled={busy}>
              {error ? t("scm.commit.retry") : t("scm.common.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}