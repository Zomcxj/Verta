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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * The operations picked from the branch dropdown. Each maps to one dialog, and the
 * union member decides which dialog is shown.
 */
export type BranchDialogRequest =
  | { kind: "create-branch" }
  | { kind: "rename-branch"; from: string }
  | { kind: "delete-branch"; name: string }
  | { kind: "add-worktree" }
  | { kind: "remove-worktree"; path: string; branch: string };

type DialogsProps = {
  repoRoot: string | null;
  request: BranchDialogRequest | null;
  onClose: () => void;
  /** Refresh the branch list after a successful operation. */
  onChanged: () => void;
};

/**
 * Whichever branch / worktree dialog is open; nothing renders without a request.
 *
 * Each dialog is its own component with a key, so performing the same action on two
 * branches in a row does not leave the previous form contents behind.
 */
export function BranchDialogs({
  repoRoot,
  request,
  onClose,
  onChanged,
}: DialogsProps) {
  if (!request || !repoRoot) return null;
  switch (request.kind) {
    case "create-branch":
      return (
        <CreateBranchDialog
          key="create-branch"
          repoRoot={repoRoot}
          onClose={onClose}
          onChanged={onChanged}
        />
      );
    case "rename-branch":
      return (
        <RenameBranchDialog
          key={`rename-${request.from}`}
          repoRoot={repoRoot}
          from={request.from}
          onClose={onClose}
          onChanged={onChanged}
        />
      );
    case "delete-branch":
      return (
        <DeleteBranchDialog
          key={`delete-${request.name}`}
          repoRoot={repoRoot}
          name={request.name}
          onClose={onClose}
          onChanged={onChanged}
        />
      );
    case "add-worktree":
      return (
        <AddWorktreeDialog
          key="add-worktree"
          repoRoot={repoRoot}
          onClose={onClose}
          onChanged={onChanged}
        />
      );
    case "remove-worktree":
      return (
        <RemoveWorktreeDialog
          key={`remove-${request.path}`}
          repoRoot={repoRoot}
          path={request.path}
          branch={request.branch}
          onClose={onClose}
          onChanged={onChanged}
        />
      );
  }
}

/**
 * Submit a change: close the dialog only on success; on failure keep git's own words
 * in the dialog so the user can fix the input.
 */
function useSubmit(onClose: () => void, onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (action: () => Promise<void>, done: string) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
        onChanged();
        toast.message(done);
        onClose();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, onChanged, onClose],
  );

  return { busy, error, submit };
}

function CreateBranchDialog({
  repoRoot,
  onClose,
  onChanged,
}: {
  repoRoot: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [switchTo, setSwitchTo] = useState(true);
  const { busy, error, submit } = useSubmit(onClose, onChanged);

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void submit(
      () =>
        native.gitCreateBranch(repoRoot, trimmed, start.trim() || null, switchTo),
      t("scm.branch.created"),
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("scm.branch.newTitle")}</DialogTitle>
          <DialogDescription>{t("scm.branch.newHint")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              create();
            }
          }}
          placeholder={t("scm.branch.namePlaceholder")}
        />
        <Input
          value={start}
          onChange={(event) => setStart(event.target.value)}
          placeholder={t("scm.branch.startPlaceholder")}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={switchTo}
            onChange={(event) => setSwitchTo(event.target.checked)}
          />
          {t("scm.branch.switchAfter")}
        </label>
        {error ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("scm.common.cancel")}
          </Button>
          <Button onClick={create} disabled={busy || !name.trim()}>
            {t("scm.common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameBranchDialog({
  repoRoot,
  from,
  onClose,
  onChanged,
}: {
  repoRoot: string;
  from: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(from);
  const { busy, error, submit } = useSubmit(onClose, onChanged);

  const rename = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void submit(
      () => native.gitRenameBranch(repoRoot, from, trimmed),
      t("scm.branch.renamed"),
    );
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("scm.branch.renameTitle", { name: from })}</DialogTitle>
          <DialogDescription>{t("scm.branch.renameHint")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              rename();
            }
          }}
        />
        {error ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("scm.common.cancel")}
          </Button>
          <Button onClick={rename} disabled={busy || !name.trim()}>
            {t("scm.common.rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete a branch. When git refuses to delete an unmerged one it reports that
 * verbatim, and only then do we offer an explicit "force delete" button, exactly the
 * moment the user needs to see that unmerged commits go with it.
 */
function DeleteBranchDialog({
  repoRoot,
  name,
  onClose,
  onChanged,
}: {
  repoRoot: string;
  name: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { busy, error, submit } = useSubmit(onClose, onChanged);

  return (
    <AlertDialog open onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("scm.branch.deleteTitle", { name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("scm.branch.deleteBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div className="space-y-1">
            <p className="whitespace-pre-wrap text-xs text-destructive">
              {error}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("scm.branch.deleteForceHint")}
            </p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("scm.common.cancel")}
          </Button>
          {error ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void submit(
                  () => native.gitDeleteBranch(repoRoot, name, true),
                  t("scm.branch.deleted"),
                )
              }
            >
              {t("scm.branch.deleteForce")}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void submit(
                  () => native.gitDeleteBranch(repoRoot, name, false),
                  t("scm.branch.deleted"),
                )
              }
            >
              {t("scm.common.delete")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The destination defaults to a sibling of the repo: `<repo>-<branch>`, and stops
 * auto-updating once the user has touched the field. */
function suggestWorktreePath(repoRoot: string, branch: string): string {
  const base = repoRoot.replace(/[\\/]+$/, "");
  return `${base}-${branch.trim() || "worktree"}`;
}

function AddWorktreeDialog({
  repoRoot,
  onClose,
  onChanged,
}: {
  repoRoot: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState(suggestWorktreePath(repoRoot, ""));
  const [pathTouched, setPathTouched] = useState(false);
  const [createNewBranch, setCreateNewBranch] = useState(true);
  const [start, setStart] = useState("");
  const { busy, error, submit } = useSubmit(onClose, onChanged);

  useEffect(() => {
    if (pathTouched) return;
    setPath(suggestWorktreePath(repoRoot, branch));
  }, [branch, pathTouched, repoRoot]);

  const add = () => {
    const trimmedBranch = branch.trim();
    const trimmedPath = path.trim();
    if (!trimmedBranch || !trimmedPath) return;
    void submit(async () => {
      await native.gitWorktreeAdd(
        repoRoot,
        trimmedPath,
        trimmedBranch,
        createNewBranch,
        start.trim() || null,
      );
    }, t("scm.worktree.added"));
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("scm.worktree.addTitle")}</DialogTitle>
          <DialogDescription>{t("scm.worktree.addHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={createNewBranch}
              onChange={(event) => setCreateNewBranch(event.target.checked)}
            />
            {t("scm.worktree.createBranch")}
          </label>
          <Input
            autoFocus
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            placeholder={t("scm.worktree.branchPlaceholder")}
          />
          {createNewBranch ? (
            <Input
              value={start}
              onChange={(event) => setStart(event.target.value)}
              placeholder={t("scm.branch.startPlaceholder")}
            />
          ) : null}
          <Input
            value={path}
            onChange={(event) => {
              setPathTouched(true);
              setPath(event.target.value);
            }}
            placeholder={t("scm.worktree.pathPlaceholder")}
          />
        </div>
        {error ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("scm.common.cancel")}
          </Button>
          <Button
            onClick={add}
            disabled={busy || !branch.trim() || !path.trim()}
          >
            {t("scm.common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Remove a worktree. git refuses while the directory has uncommitted changes, and
 * only then does "force remove" appear, exactly when the user must be told the
 * changes go with it.
 */
function RemoveWorktreeDialog({
  repoRoot,
  path,
  branch,
  onClose,
  onChanged,
}: {
  repoRoot: string;
  path: string;
  branch: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const { busy, error, submit } = useSubmit(onClose, onChanged);

  return (
    <AlertDialog open onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("scm.worktree.removeTitle", { branch })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("scm.worktree.removeBody", { path })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <div className="space-y-1">
            <p className="whitespace-pre-wrap text-xs text-destructive">
              {error}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("scm.worktree.removeForceHint")}
            </p>
          </div>
        ) : null}
        <AlertDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("scm.common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void submit(
                // This button is only reachable after git has refused once, so this is
                // an explicit force.
                () => native.gitWorktreeRemove(repoRoot, path, Boolean(error)),
                t("scm.worktree.removed"),
              )
            }
          >
            {error ? t("scm.worktree.removeForce") : t("scm.common.delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}