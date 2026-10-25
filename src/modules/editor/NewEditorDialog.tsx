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
import { type MessageKey, useT } from "@/modules/i18n";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { File02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { memo, useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootPath: string | null;
  onCreated: (path: string) => void;
};

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

/**
 * Memoised: the dialog is mounted whether or not it is open, and its own inputs (whether it is open,
 * the folder it creates in) do not change on a tab switch. Its `onCreated` is a stable callback in the
 * window for the same reason.
 */
export const NewEditorDialog = memo(function NewEditorDialog({
  open,
  onOpenChange,
  rootPath,
  onCreated,
}: Props) {
  const [name, setName] = useState("untitled.txt");
  // Holds a key, not a sentence: the language can change while the dialog is
  // open, and the old language must not stick around.
  const [error, setError] = useState<MessageKey | null>(null);
  // The backend's own error text is a runtime message, not a key: it is shown as it comes.
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setName("untitled.txt");
    setError(null);
    setErrorDetail(null);
    // Pre-select the basename so the user can quickly retype the filename
    // while keeping the extension handy.
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const dot = el.value.lastIndexOf(".");
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    }, 0);
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("editor.newFile.nameRequired");
      return;
    }
    if (trimmed.includes("..")) {
      setError("editor.newFile.relative");
      return;
    }
    if (!rootPath) {
      setError("cmd.noWorkspaceRoot");
      return;
    }
    const path = trimmed.startsWith("/")
      ? trimmed
      : joinPath(rootPath, trimmed);
    try {
      await invoke("fs_create_file", {
        path,
        workspace: currentWorkspaceEnv(),
      });
      onCreated(path);
      onOpenChange(false);
    } catch (e) {
      setErrorDetail(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex gap-1.75">
            <HugeiconsIcon icon={File02Icon} size={16} strokeWidth={1.75} />
            {t("explorer.newFile")}
          </DialogTitle>
          <DialogDescription>
            {t("editor.newFile.description")}
          </DialogDescription>
        </DialogHeader>
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
            setErrorDetail(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="example.ts"
        />
        {error ? (
          <div className="text-xs text-destructive">{t(error)}</div>
        ) : errorDetail ? (
          <div className="text-xs text-destructive">{errorDetail}</div>
        ) : (
          <div className="text-xs text-muted-foreground truncate">
            {rootPath ? joinPath(rootPath, name.trim() || "…") : "—"}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("scm.common.cancel")}
          </Button>
          <Button onClick={() => void submit()}>
            {t("scm.common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
