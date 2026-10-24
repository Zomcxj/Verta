import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { descriptionProblem } from "./lib/repoAdmin";

/**
 * The `.gitignore` templates worth offering here: the file is just a starting point, and
 * a long list would be a worse fit than typing the right one later. gh knows these names.
 */
const GITIGNORE_TEMPLATES = [
  "Rust",
  "Node",
  "Python",
  "Go",
  "Java",
  "C++",
  "VisualStudio",
];

/** The licenses most projects here want; gh takes these SPDX ids. */
const LICENSE_TEMPLATES = [
  { value: "mit", label: "MIT" },
  { value: "apache-2.0", label: "Apache-2.0" },
  { value: "gpl-3.0", label: "GPL-3.0" },
  { value: "bsd-3-clause", label: "BSD-3-Clause" },
  { value: "mpl-2.0", label: "MPL-2.0" },
];

/** The empty option of a template picker; a fixed string so "none" is not a template. */
const NONE = "\u0000none";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reported with the slug GitHub created, so the list can read itself back. */
  onCreated: (slug: string) => void;
};

/**
 * Create a repository on the account: the fields GitHub needs, and nothing else.
 *
 * The name is checked locally only for what GitHub certainly refuses (empty, bad
 * characters, over-long), because a round trip to be told "invalid name" is worse than
 * saying what is wrong here. Templates are optional and mean "no such file", which is a
 * different thing from an empty file.
 */
export function NewRepoDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState("");
  const [gitignore, setGitignore] = useState(NONE);
  const [license, setLicense] = useState(NONE);
  const [creating, setCreating] = useState(false);
  /** GitHub's own words when the create failed. */
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    // Clear on close so reopening starts from a clean form rather than the last attempt.
    setName("");
    setIsPrivate(true);
    setDescription("");
    setGitignore(NONE);
    setLicense(NONE);
    setError(null);
  }, [open]);

  const trimmedName = name.trim();
  const descriptionTooLong = descriptionProblem(description) !== null;
  const canCreate = Boolean(trimmedName) && !descriptionTooLong && !creating;

  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const result = await native.githubRepoCreate({
        name: trimmedName,
        private: isPrivate,
        description: description.trim(),
        gitignore: gitignore === NONE ? undefined : gitignore,
        license: license === NONE ? undefined : license,
      });
      if (result.kind !== "ready") {
        // Kept in the dialog: the fields are still there to fix and retry.
        setError(result.error ?? t("remotes.ci.error"));
        return;
      }
      onCreated(result.repo);
      toast.success(t("remotes.create.done", { repo: result.repo }));
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!creating) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("remotes.create.title")}</DialogTitle>
          <DialogDescription>{t("remotes.create.hint")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="new-repo-name" className="text-xs">
              {t("remotes.create.name")}
            </Label>
            <Input
              id="new-repo-name"
              value={name}
              placeholder={t("remotes.create.namePlaceholder")}
              className="h-7 text-xs"
              disabled={creating}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void create();
                }
              }}
            />
          </div>

          <div className="space-y-1">
            <span className="text-xs">{t("remotes.create.visibility")}</span>
            <RadioGroup
              value={isPrivate ? "private" : "public"}
              className="gap-1"
              onValueChange={(next) => setIsPrivate(next === "private")}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="private" id="new-repo-private" />
                <Label htmlFor="new-repo-private" className="text-xs">
                  {t("remotes.create.private")}
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="public" id="new-repo-public" />
                <Label htmlFor="new-repo-public" className="text-xs">
                  {t("remotes.create.public")}
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="space-y-1">
            <Label htmlFor="new-repo-description" className="text-xs">
              {t("remotes.create.description")}
            </Label>
            <Textarea
              id="new-repo-description"
              value={description}
              className="min-h-16 text-xs"
              disabled={creating}
              onChange={(event) => setDescription(event.target.value)}
            />
            {descriptionTooLong ? (
              <p className="text-[11px] text-destructive">
                {t("remotes.admin.description.tooLong")}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <span className="text-xs">{t("remotes.create.gitignore")}</span>
              <Select
                value={gitignore}
                disabled={creating}
                onValueChange={setGitignore}
              >
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE} className="text-xs">
                    {t("remotes.create.none")}
                  </SelectItem>
                  {GITIGNORE_TEMPLATES.map((template) => (
                    <SelectItem key={template} value={template} className="text-xs">
                      {template}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-xs">{t("remotes.create.license")}</span>
              <Select value={license} disabled={creating} onValueChange={setLicense}>
                <SelectTrigger className="h-7 w-44 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE} className="text-xs">
                    {t("remotes.create.none")}
                  </SelectItem>
                  {LICENSE_TEMPLATES.map((item) => (
                    <SelectItem key={item.value} value={item.value} className="text-xs">
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error ? (
            <p className="whitespace-pre-wrap text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={creating}
            onClick={() => onOpenChange(false)}
          >
            {t("scm.common.cancel")}
          </Button>
          <Button disabled={!canCreate} onClick={() => void create()}>
            {creating
              ? t("remotes.create.running")
              : t("remotes.create.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}