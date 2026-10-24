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
  repoNameProblem,
  type RepoNameProblem,
} from "./lib/repoAdmin";

type Props = {
  /** Full name of the repo being managed; null when the dialog is closed. */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
  /** Reported after a successful description / visibility change so the list row updates. */
  onChanged?: (
    repo: string,
    patch: { description?: string | null; visibility?: string | null },
  ) => void;
  /** Reported after the repo is deleted, so the list row can be removed. */
  onDeleted?: (repo: string) => void;
  /** Reported after a rename, with the new slug: GitHub keeps the old name redirecting,
   * but the row and this dialog have to follow the new one. */
  onRenamed?: (repo: string, newSlug: string) => void;
};

/** A change that needs confirmation before it is sent. */
type PendingChange = { what: "visibility"; isPrivate: boolean } | { what: "delete" };

/** The `name` half of an `owner/name` slug. */
function nameOf(slug: string): string {
  return slug.split("/").pop() ?? slug;
}

/**
 * Repo settings: rename, edit the description, change visibility, delete the repo.
 *
 * Settings (description, visibility, whether the account is an admin) are read
 * once on open. A rename, a description edit and a visibility switch all write
 * straight back to GitHub on a click, so visibility lists the consequences one
 * by one first; delete goes further and requires typing the full repo name.
 * Every failure keeps GitHub's own message in the dialog instead of a bare
 * "failed".
 */
export function RepoAdminDialog({
  repo,
  onOpenChange,
  onChanged,
  onDeleted,
  onRenamed,
}: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireRepoSettingsPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** Raw message when the command itself failed (no `kind` at all). */
  const [fatal, setFatal] = useState<string | null>(null);
  /** Description draft: filled with the current value on open, then tracks the saved value. */
  const [draft, setDraft] = useState("");
  /** Repo name draft, seeded from the current name on open. */
  const [nameDraft, setNameDraft] = useState("");
  /** GitHub's own words when the rename failed; kept next to the field to be fixed. */
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "description" | "visibility" | "rename" | "delete"
  >(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  /** GitHub's own words when an action failed; kept in the confirm dialog. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** Full repo name typed before deleting. */
  const [typed, setTyped] = useState("");

  const load = useCallback(async () => {
    if (!repo) return;
    setReading(true);
    setFatal(null);
    try {
      const result = await native.githubRepoSettings(repo);
      setPayload(result);
      setDraft(result.description ?? "");
      setNameDraft(nameOf(repo));
      setNameError(null);
    } catch (e) {
      setPayload(null);
      setFatal(String(e));
    } finally {
      setReading(false);
    }
  }, [repo]);

  useEffect(() => {
    if (!repo) {
      // Clear on close so reopening does not flash stale data.
      setPayload(null);
      setFatal(null);
      setDraft("");
      setNameDraft("");
      setNameError(null);
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
  const nameProblem = repoNameProblem(nameDraft);
  const nameDirty = Boolean(repo) && nameDraft.trim() !== nameOf(repo ?? "");

  const nameProblemText = (problem: RepoNameProblem): string => {
    switch (problem.reason) {
      case "empty":
        return t("remotes.rename.empty");
      case "tooLong":
        return t("remotes.rename.tooLong", { length: problem.length });
      case "badChar":
        return t("remotes.rename.badChars", { char: problem.char });
    }
  };

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

  /**
   * Rename the repo.
   *
   * Not confirmed first: GitHub redirects the old name, so nothing breaks and the change
   * is undone by renaming back. A refusal comes back in GitHub's own words and stays under
   * the field, so the name can be corrected and retried.
   */
  const saveName = async () => {
    if (!repo || busy || nameProblem) return;
    setBusy("rename");
    setNameError(null);
    try {
      const next = nameDraft.trim();
      const result = await native.githubRepoRename(repo, next);
      if (result.kind !== "ready") {
        setNameError(result.error ?? t("remotes.ci.error"));
        return;
      }
      // The slug GitHub reports is the truth: it is what the list and this dialog follow.
      const slug = result.repo || `${repo.split("/")[0]}/${next}`;
      setNameDraft(nameOf(slug));
      onRenamed?.(repo, slug);
      toast.success(t("remotes.rename.done", { repo: slug }));
    } catch (e) {
      setNameError(String(e));
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
        // A failure is not a "stuck midway" state: keep the raw message and let the
        // user retry or back out.
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
          // The confirm dialog (AlertDialog) is another Radix layer portalled
          // outside body, so clicking it counts as "outside the settings dialog" and
          // closes it too. Do not close while the confirm dialog is open.
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
                    {t("remotes.rename.label")}
                  </span>
                  {nameDirty ? (
                    <span className="text-[11px] text-muted-foreground">
                      {t("remotes.admin.description.dirty")}
                    </span>
                  ) : null}
                </div>
                <Input
                  value={nameDraft}
                  className="font-mono"
                  disabled={!writable || busy !== null}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveName();
                    }
                  }}
                />
                {nameProblem ? (
                  <p className="text-[11px] text-destructive">
                    {nameProblemText(nameProblem)}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {t("remotes.rename.hint")}
                  </p>
                )}
                {nameError ? (
                  <p className="whitespace-pre-wrap text-[11px] text-destructive">
                    {nameError}
                  </p>
                ) : null}
                {writable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={!nameDirty || Boolean(nameProblem) || busy !== null}
                    onClick={() => void saveName()}
                  >
                    {busy === "rename"
                      ? t("remotes.rename.running")
                      : t("remotes.rename.button")}
                  </Button>
                ) : null}
              </section>

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
