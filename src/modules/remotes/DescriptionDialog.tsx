import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { descriptionProblem } from "./lib/repoAdmin";

type Props = {
  /** Full name of the repo whose description is being edited; null when closed. */
  repo: string | null;
  /** The description the list already read, used to seed the field on open. */
  current: string | null;
  onOpenChange: (open: boolean) => void;
  /** Reported after a successful save, so the list row updates. */
  onSaved: (repo: string, description: string | null) => void;
};

/**
 * Edit just the description, straight from the list.
 *
 * Deliberately not the repo settings dialog: this reads nothing on open (the list already
 * has the text) and writes one field, so a click on a description opens it filled in.
 * Whether the account may edit this repo is GitHub's call rather than a guess: a refusal
 * comes back as its own words, and the dialog keeps them in view so the text can be
 * changed and retried.
 */
export function DescriptionDialog({
  repo,
  current,
  onOpenChange,
  onSaved,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  /** GitHub's own message when the write failed. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Seed from the stored text, and clear on close so reopening does not flash the
    // previous repo's description.
    setDraft(repo === null ? "" : (current ?? ""));
    setError(null);
  }, [repo, current]);

  const problem = descriptionProblem(draft);
  const dirty = draft.trim() !== (current ?? "").trim();

  const save = async () => {
    if (!repo || saving || problem) return;
    setSaving(true);
    setError(null);
    try {
      const text = draft.trim();
      const result = await native.githubRepoSetDescription(repo, text);
      if (result.kind !== "ready") {
        setError(result.error ?? t("remotes.ci.error"));
        return;
      }
      // An empty field is a cleared description, not an empty string.
      onSaved(repo, text ? text : null);
      toast.success(t("remotes.admin.saved"));
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={repo !== null}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("remotes.description.title", { repo: repo ?? "" })}
          </DialogTitle>
          <DialogDescription>
            {t("remotes.admin.description.hint")}
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={draft}
          className="min-h-24 text-xs"
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
        />

        {problem ? (
          <p className="text-[11px] text-destructive">
            {t("remotes.admin.description.tooLong")}
          </p>
        ) : null}
        {error ? (
          <p className="whitespace-pre-wrap text-[11px] text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {t("scm.common.cancel")}
          </Button>
          <Button
            disabled={saving || !dirty || Boolean(problem)}
            onClick={() => void save()}
          >
            {saving ? t("remotes.admin.saving") : t("remotes.admin.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}