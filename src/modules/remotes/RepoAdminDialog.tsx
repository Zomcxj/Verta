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
import { Input } from "@/components/ui/input";
import { native, type WireRepoSettingsPayload } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  adminHintKey,
  canAdmin,
  deleteConfirmMatches,
  descriptionProblem,
  isPrivateVisibility,
} from "./lib/repoAdmin";

type Props = {
  /** 要管理的仓库全名；null 表示弹窗关着。 */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
  /** 描述 / 可见性改成功后回传，列表那一行跟着更新。 */
  onChanged?: (
    repo: string,
    patch: { description?: string | null; visibility?: string | null },
  ) => void;
  /** 仓库被删掉之后回传，列表里那一行要拿掉。 */
  onDeleted?: (repo: string) => void;
};

/** 一次要先确认才能发的改动。 */
type PendingChange = { what: "visibility"; isPrivate: boolean } | { what: "delete" };

/**
 * 仓库设置：改描述、切可见性、删仓库。
 *
 * 打开时查一次设置（描述、可见性、当前账号是不是管理员）。改描述与切可见性都是「点一下
 * 真写回 GitHub」，所以切换可见性会先把后果逐条说清楚；删除更狠一步，要求手输仓库全名。
 * 失败一律把 GitHub 的原话留在弹窗里，而不是只弹一句「失败了」。
 */
export function RepoAdminDialog({
  repo,
  onOpenChange,
  onChanged,
  onDeleted,
}: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireRepoSettingsPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文。 */
  const [fatal, setFatal] = useState<string | null>(null);
  /** 描述草稿：打开时填当前值，保存成功后跟着新值走。 */
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<null | "description" | "visibility" | "delete">(
    null,
  );
  const [pending, setPending] = useState<PendingChange | null>(null);
  /** 动作失败时 GitHub 的原话，留在确认框里。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 删仓库前手输的仓库全名。 */
  const [typed, setTyped] = useState("");

  const load = useCallback(async () => {
    if (!repo) return;
    setReading(true);
    setFatal(null);
    try {
      const result = await native.githubRepoSettings(repo);
      setPayload(result);
      setDraft(result.description ?? "");
    } catch (e) {
      setPayload(null);
      setFatal(String(e));
    } finally {
      setReading(false);
    }
  }, [repo]);

  useEffect(() => {
    if (!repo) {
      // 关掉时清干净，下次打开不会先闪一眼旧数据。
      setPayload(null);
      setFatal(null);
      setDraft("");
      setPending(null);
      setActionError(null);
      setTyped("");
      return;
    }
    void load();
  }, [repo, load]);

  const writable = canAdmin(payload);
  const readOnlyHint = adminHintKey(payload);
  const saved = payload?.description ?? "";
  const dirty = draft.trim() !== saved.trim();
  const draftProblem = descriptionProblem(draft);
  const currentPrivate = isPrivateVisibility(payload?.visibility ?? null);
  const canDelete = deleteConfirmMatches(typed, repo ?? "");

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
  };

  const saveDescription = async () => {
    if (!repo || busy || draftProblem) return;
    setBusy("description");
    try {
      const text = draft.trim();
      const result = await native.githubRepoSetDescription(repo, text);
      if (result.kind !== "ready") {
        toast.error(result.error ?? t("remotes.ci.error"));
        return;
      }
      const next = text ? text : null;
      setPayload((prev) => (prev ? { ...prev, description: next } : prev));
      setDraft(text);
      onChanged?.(repo, { description: next });
      toast.success(t("remotes.admin.saved"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!pending || !repo) return;
    setBusy(pending.what);
    setActionError(null);
    try {
      const result =
        pending.what === "visibility"
          ? await native.githubRepoSetVisibility(repo, pending.isPrivate)
          : await native.githubRepoDelete(repo);
      if (result.kind !== "ready") {
        // 失败不是「停在中间态」：原文留着，再试一次或收手由用户决定。
        setActionError(result.error ?? t("remotes.ci.error"));
        return;
      }
      setPending(null);
      if (pending.what === "visibility") {
        const visibility = pending.isPrivate ? "PRIVATE" : "PUBLIC";
        setPayload((prev) => (prev ? { ...prev, visibility } : prev));
        onChanged?.(repo, { visibility });
        toast.success(t("remotes.admin.visibility.done"));
        return;
      }
      toast.success(t("remotes.admin.delete.done", { repo }));
      onDeleted?.(repo);
      close(false);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const visibilityLabel = payload?.visibility
    ? t(
        `remotes.admin.visibility.${payload.visibility}` as
          | "remotes.admin.visibility.PUBLIC"
          | "remotes.admin.visibility.PRIVATE"
          | "remotes.admin.visibility.INTERNAL",
      )
    : t("remotes.admin.visibility.unknown");

  return (
    <>
      <Dialog open={repo !== null} onOpenChange={close}>
        <DialogContent
          className="sm:max-w-xl"
          // 确认框（AlertDialog）是另一个 Radix 层、被传送到 body 外面，点它会被当成
          // 「点到设置弹窗外面」而把设置弹窗一起关掉。确认框开着时先别关。
          onInteractOutside={(event) => {
            if (pending !== null) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("remotes.admin.title", { repo: repo ?? "" })}</DialogTitle>
            <DialogDescription>{t("remotes.admin.hint")}</DialogDescription>
            {readOnlyHint ? (
              <p className="text-xs text-muted-foreground">{t(readOnlyHint)}</p>
            ) : null}
          </DialogHeader>

          {fatal ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap text-xs text-destructive">{fatal}</p>
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                {t("remotes.admin.retry")}
              </Button>
            </div>
          ) : reading && !payload ? (
            <p className="text-xs text-muted-foreground">
              {t("remotes.admin.loading")}
            </p>
          ) : (
            <div className="space-y-4">
              <section className="space-y-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t("remotes.admin.description")}
                  </span>
                  {dirty ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t("remotes.admin.description.dirty")}
                    </span>
                  ) : null}
                </div>
                <Input
                  value={draft}
                  disabled={!writable || busy !== null}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveDescription();
                    }
                  }}
                />
                {draftProblem ? (
                  <p className="text-[11px] text-destructive">
                    {t("remotes.admin.description.tooLong")}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {t("remotes.admin.description.hint")}
                  </p>
                )}
                {writable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!dirty || Boolean(draftProblem) || busy !== null}
                    onClick={() => void saveDescription()}
                  >
                    {busy === "description"
                      ? t("remotes.admin.saving")
                      : t("remotes.admin.save")}
                  </Button>
                ) : null}
              </section>

              <section className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  {t("remotes.admin.visibility")}
                </span>
                <div className="flex items-center gap-2">
                  <span className="rounded border border-border/60 px-1.5 text-xs leading-5">
                    {visibilityLabel}
                  </span>
                  {writable ? (
                    <>
                      {currentPrivate === true || currentPrivate === null ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={busy !== null}
                          onClick={() => {
                            setActionError(null);
                            setPending({ what: "visibility", isPrivate: false });
                          }}
                        >
                          {t("remotes.admin.visibility.toPublic")}
                        </Button>
                      ) : null}
                      {currentPrivate === false || currentPrivate === null ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          disabled={busy !== null}
                          onClick={() => {
                            setActionError(null);
                            setPending({ what: "visibility", isPrivate: true });
                          }}
                        >
                          {t("remotes.admin.visibility.toPrivate")}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </section>

              {writable ? (
                <section className="space-y-1.5 rounded border border-destructive/40 p-2">
                  <span className="text-xs font-medium text-destructive">
                    {t("remotes.admin.danger")}
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    {t("remotes.admin.delete.hint")}
                  </p>
                  <Input
                    value={typed}
                    className="h-7 font-mono text-xs"
                    placeholder={t("remotes.admin.delete.typeHere", {
                      repo: repo ?? "",
                    })}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive"
                    disabled={!canDelete || busy !== null}
                    onClick={() => {
                      setActionError(null);
                      setPending({ what: "delete" });
                    }}
                  >
                    {t("remotes.admin.delete.button")}
                  </Button>
                </section>
              ) : null}
            </div>
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
              {pending?.what === "delete"
                ? t("remotes.admin.delete.title", { repo: repo ?? "" })
                : pending?.isPrivate
                  ? t("remotes.admin.visibility.toPrivate.title")
                  : t("remotes.admin.visibility.toPublic.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.what === "delete"
                ? t("remotes.admin.delete.confirmHint")
                : pending?.isPrivate
                  ? t("remotes.admin.visibility.toPrivate.hint")
                  : t("remotes.admin.visibility.toPublic.hint")}
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
              disabled={busy !== null}
              onClick={() => {
                setPending(null);
                setActionError(null);
              }}
            >
              {actionError ? t("remotes.runs.giveUp") : t("scm.common.cancel")}
            </Button>
            <Button disabled={busy !== null} onClick={() => void run()}>
              {busy === "delete"
                ? t("remotes.admin.delete.running")
                : busy === "visibility"
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
