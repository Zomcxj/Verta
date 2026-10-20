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
 * 分支下拉里点出来的那几种操作。每种对应一个弹窗，弹窗内容由这个联合类型决定。
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
  /** 操作成功后刷新分支列表。 */
  onChanged: () => void;
};

/**
 * 弹出中的那个分支/worktree 弹窗。没有请求时什么都不渲染。
 *
 * 每个弹窗都是独立组件并带 key：连续对两个分支做同一件事时，表单不会留下上一次的
 * 内容。
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
 * 提交一次改动：成功才收弹窗，失败把 git 的原话留在弹窗里让用户改。
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
 * 删分支。git 拒绝删未合并的分支时会报原文，这里再给一个明确的「强制删除」按钮 ——
 * 那正是用户需要看见「会连带丢掉未合并提交」的时刻。
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

/** 目标目录默认摆在仓库旁边：`<仓库>-<分支>`，用户动过输入框就不再自动改。 */
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
 * 移除 worktree。目录里有未提交改动时 git 会拒绝，这时才出现「强制移除」——
 * 那也正是要告诉用户「改动会一起没了」的时刻。
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
                // 第一次被 git 拒绝之后才走到这个按钮，所以这里就是明确的强制。
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