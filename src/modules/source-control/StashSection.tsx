import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { native, type GitStashEntry } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/modules/i18n";

type Props = {
  /** 面板所在仓库；换仓库时重新读一遍。 */
  repoRoot: string | null;
  /** 文件列表变化后（比如刚 stash 走一份改动）让外面刷新状态。 */
  onChanged: () => Promise<void>;
};

/**
 * 储藏列表。默认收起，展开才去读：储藏是「要用才翻」的东西，不该和文件列表
 * 抢每次刷新的开销。
 */
export function StashSection({ repoRoot, onChanged }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<GitStashEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<GitStashEntry | null>(null);
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);

  const load = useCallback(
    async (root: string) => {
      try {
        setEntries(await native.gitStashList(root));
        setError(null);
      } catch (e) {
        setEntries([]);
        setError(String(e));
      }
    },
    [],
  );

  // 换仓库、或第一次展开时才读。
  useEffect(() => {
    if (!repoRoot) {
      setEntries(null);
      return;
    }
    if (!open) return;
    void load(repoRoot);
  }, [repoRoot, open, load]);

  const run = useCallback(
    async (action: () => Promise<void>, done: string): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      try {
        await action();
        if (repoRoot) await load(repoRoot);
        await onChanged();
        toast.message(done);
        return true;
      } catch (e) {
        // git 的报错原样带出来：冲突、没东西可存这些都要让用户看见。
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load, onChanged, repoRoot],
  );

  const handleStash = useCallback(() => {
    if (!repoRoot) return;
    const trimmed = message.trim();
    void run(
      () => native.gitStashPush(repoRoot, trimmed || null, includeUntracked),
      t("scm.stash.done"),
    ).then((ok) => {
      // 只有真的存进去了才清空输入框，失败时留着让人改。
      if (ok) setMessage("");
    });
  }, [includeUntracked, message, repoRoot, run, t]);

  const count = entries?.length ?? 0;

  return (
    <div className="shrink-0 border-t border-border/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <span className={cn("transition-transform", open && "rotate-90")}>
          ›
        </span>
        <span className="font-medium">{t("scm.stash.title")}</span>
        {count > 0 ? (
          <span className="rounded-full border border-border/60 px-1 text-[10px] tabular-nums">
            {count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="px-2.5 pb-2">
          <div className="flex items-center gap-1">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleStash();
              }}
              placeholder={t("scm.stash.messagePlaceholder")}
              className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-transparent px-1.5 text-[11px] outline-none focus:border-primary/45"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              onClick={handleStash}
              disabled={busy || !repoRoot}
            >
              {t("scm.stash.push")}
            </Button>
          </div>

          <label className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            {t("scm.stash.includeUntracked")}
          </label>

          {error ? (
            <p className="mt-1 whitespace-pre-wrap text-[10.5px] text-destructive">
              {error}
            </p>
          ) : null}

          {entries === null ? (
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              {t("scm.stash.loading")}
            </p>
          ) : entries.length === 0 ? (
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              {t("scm.stash.empty")}
            </p>
          ) : (
            <ul className="mt-1 max-h-40 overflow-y-auto">
              {entries.map((entry) => (
                <li
                  key={entry.reference}
                  className="group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/40"
                >
                  <span
                    title={`${entry.reference}\n${entry.message}`}
                    className="min-w-0 flex-1 truncate text-[11px]"
                  >
                    {entry.message || entry.reference}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title={t("scm.stash.more")}
                        className="shrink-0 rounded px-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                      >
                        ⋯
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem
                        disabled={busy || !repoRoot}
                        onSelect={() => {
                          if (!repoRoot) return;
                          void run(
                            () => native.gitStashApply(repoRoot, entry.reference),
                            t("scm.stash.applied"),
                          );
                        }}
                      >
                        {t("scm.stash.apply")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy || !repoRoot}
                        onSelect={() => {
                          if (!repoRoot) return;
                          void run(
                            () => native.gitStashPop(repoRoot, entry.reference),
                            t("scm.stash.popped"),
                          );
                        }}
                      >
                        {t("scm.stash.pop")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={busy}
                        onSelect={() => setPendingDrop(entry)}
                      >
                        {t("scm.stash.drop")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <AlertDialog
        open={pendingDrop !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDrop(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("scm.stash.drop.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("scm.stash.drop.body", {
                message: pendingDrop?.message || pendingDrop?.reference || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("scm.stash.drop.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pendingDrop;
                setPendingDrop(null);
                if (!repoRoot || !target) return;
                void run(
                  () => native.gitStashDrop(repoRoot, target.reference),
                  t("scm.stash.dropped"),
                );
              }}
            >
              {t("scm.stash.drop.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}