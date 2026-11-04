import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Path of the directory the clone landed in (it may already be registered as
   * authorized by the backend). */
  onCloned: (path: string) => void;
  /**
   * Repo URL and destination prefilled on open.
   *
   * Used when coming from a remote-repos row: the URL is that row's clone URL and
   * the destination is "next to an existing project, plus the repo name". Omitted
   * from the Projects entry point, which leaves both fields empty.
   */
  defaultUrl?: string;
  defaultDest?: string;
};

/**
 * Clone a new repo.
 *
 * When the destination's parent directory does not exist the backend refuses
 * outright and names the missing level, which beats git's "could not create work
 * tree dir". A clone can take tens of seconds, so the busy state is shown honestly.
 */
export function CloneRepoDialog({
  open,
  onOpenChange,
  onCloned,
  defaultUrl,
  defaultDest,
}: Props) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Clone only the newest commit.
   *
   * For a repository kept to be read - a third-party library, a reference checkout - the history is
   * weight nobody asked for: it is most of what the clone downloads and most of what sits on disk,
   * and every pull afterwards keeps it that way. Asked here rather than in a setting because it is
   * a property of this clone, not of the user.
   */
  const [shallow, setShallow] = useState(false);

  // Prefill wins on every open (a different row means different values); without it
  // the fields are left alone, so a half-typed entry from the Projects page survives
  // closing and reopening.
  useEffect(() => {
    if (!open) return;
    if (defaultUrl) setUrl(defaultUrl);
    if (defaultDest) setDest(defaultDest);
  }, [open, defaultUrl, defaultDest]);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const trimmedUrl = url.trim();
    const trimmedDest = dest.trim();
    if (!trimmedUrl || !trimmedDest || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await native.gitCloneRepo(
        trimmedUrl,
        trimmedDest,
        shallow ? 1 : undefined,
      );
      // The cloned directory has to be openable right away: authorize it, then hand it
      // to the Projects page.
      await native.workspaceAuthorize(path).catch(() => null);
      setUrl("");
      setDest("");
      onOpenChange(false);
      onCloned(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("projects.clone.title")}</DialogTitle>
          <DialogDescription>{t("projects.clone.hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t("projects.clone.urlPlaceholder")}
          />
          <Input
            value={dest}
            onChange={(event) => setDest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t("projects.clone.destPlaceholder")}
          />
        </div>
        {/* The checkbox is a button, not an input, so the label points at it by id rather than
            wrapping it: a wrapping label is the association the lint rule cannot see through. */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Checkbox
            id="clone-shallow"
            checked={shallow}
            onCheckedChange={(next) => setShallow(next === true)}
            className="mt-0.5"
          />
          <label htmlFor="clone-shallow" className="cursor-pointer">
            <span className="text-foreground">{t("projects.clone.shallow")}</span>
            <span className="ml-1">{t("projects.clone.shallowHint")}</span>
          </label>
        </div>
        {error ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
            {t("scm.common.cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !url.trim() || !dest.trim()}
          >
            {busy ? t("projects.clone.running") : t("projects.clone.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}