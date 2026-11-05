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
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type GitBranchEntry, native } from "@/lib/native";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/modules/explorer/FileIcon";
import {
  copyToClipboard,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import {
  COMPACT_CONTENT,
  COMPACT_ITEM,
} from "@/modules/explorer/lib/menuItemClass";
import { joinPath } from "@/modules/explorer/lib/useFileTree";
import { useT } from "@/modules/i18n";
import { lineCounts, statusLetter, statusLetterLabel } from "@/modules/source-control/lineCounts";
import {
  allInPaneSelected,
  filesInPane,
  paneAction,
  selectedInPane,
  togglePaneSelection,
  type ScmPane,
} from "@/modules/source-control/panes";
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  CheckmarkCircle01Icon,
  Download01Icon,
  Folder01Icon,
  FolderCloudIcon,
  FolderGitTwoIcon,
  GitBranchIcon,
  Refresh01Icon,
  RemoveSquareIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { type BranchDialogRequest, BranchDialogs } from "./BranchDialogs";
import {
  repositoryTargetIsPending,
  type SourceControlRepositoryTarget,
} from "./repositoryTarget";
import { StashSection } from "./StashSection";
import type { SourceControlSummary } from "./useSourceControl";
import {
  type SourceControlFileEntry,
  useSourceControlPanel,
} from "./useSourceControlPanel";

type Props = {
  open: boolean;
  sourceControl: SourceControlSummary;
  onOpenGitGraph?: () => void;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath: string | null;
    title?: string;
  }) => void;
  onOpenFile?: (absolutePath: string) => void;
  onNavigateToPath?: (path: string) => void;
  repositoryTarget: SourceControlRepositoryTarget;
  onFollowRepositoryContext: () => void;
};

const SOURCE_CONTROL_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

const ROW_HEIGHTS = {
  banner: 32,
  header: 30,
  entry: 30,
} as const;

type RowDescriptor =
  | { kind: "banner-diverged"; key: string }
  | { kind: "list-header"; key: string; count: number; pane: ScmPane }
  | { kind: "entry"; key: string; entry: SourceControlFileEntry };

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function entryPathLabel(entry: SourceControlFileEntry): string {
  if (entry.originalPath) return `${entry.originalPath} → ${entry.path}`;
  return dirname(entry.path);
}

function upstreamBadgeLabel(
  upstream: string | null | undefined,
  fallback: string,
): string {
  if (!upstream) return fallback;
  return upstream;
}

function statusAccent(code: string): string {
  switch (code) {
    case "A":
      return "bg-emerald-500/85";
    case "U":
      return "bg-teal-500/85";
    case "M":
      return "bg-amber-500/85";
    case "D":
      return "bg-rose-500/85";
    case "R":
      return "bg-sky-500/85";
    default:
      return "bg-muted-foreground/40";
  }
}

/// The letter's colour, matched to the bar beside it so the two read as one statement.
function statusLetterColor(code: string): string {
  switch (code) {
    case "A":
      return "text-emerald-500/90";
    case "U":
      return "text-teal-500/90";
    case "M":
      return "text-amber-500/90";
    case "D":
      return "text-rose-500/90";
    case "R":
      return "text-sky-500/90";
    default:
      return "text-muted-foreground/70";
  }
}

function BranchDropdown({
  repoRoot,
  repoLabel,
  displayRepoRoot,
  repositoryTarget,
  onFollowRepositoryContext,
  onNavigateToPath,
  onRefresh,
}: {
  repoRoot: string | null;
  repoLabel: string;
  displayRepoRoot: string | null;
  repositoryTarget: SourceControlRepositoryTarget;
  onFollowRepositoryContext: () => void;
  onNavigateToPath?: (path: string) => void;
  onRefresh: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [dialog, setDialog] = useState<BranchDialogRequest | null>(null);
  const requestRef = useRef(0);
  const checkoutInFlight = useRef(false);

  const loadBranches = useCallback(async () => {
    const id = ++requestRef.current;
    if (!repoRoot) {
      setBranches([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await native.gitListBranches(repoRoot);
      if (id !== requestRef.current) return;
      setBranches(result.branches);
    } catch (e) {
      if (id !== requestRef.current) return;
      setError(String(e));
      setBranches([]);
    } finally {
      if (id === requestRef.current) {
        setLoading(false);
      }
    }
  }, [repoRoot]);

  useEffect(() => {
    if (open) {
      void loadBranches();
    }
  }, [open, loadBranches]);

  const handleCheckout = useCallback(
    async (branch: string) => {
      if (!repoRoot || checkoutInFlight.current) return;
      checkoutInFlight.current = true;
      setCheckingOut(true);
      try {
        await native.gitCheckoutBranch(repoRoot, branch);
        setBranches([]);
        setOpen(false);
        onRefresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        checkoutInFlight.current = false;
        setCheckingOut(false);
      }
    },
    [repoRoot, onRefresh],
  );

  const localBranches = useMemo(
    () => branches.filter((b) => b.kind === "local"),
    [branches],
  );
  const worktrees = useMemo(
    () => branches.filter((b) => b.kind === "worktree"),
    [branches],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={checkingOut}
          title={displayRepoRoot ?? repoLabel}
          // Which repository the panel is on. The header is the only place it says so, and a probe
          // reading the panel has to ask this rather than guess from the file rows.
          data-scm-repo={displayRepoRoot ?? undefined}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-default disabled:opacity-70"
        >
          <HugeiconsIcon
            icon={FolderGitTwoIcon}
            size={12}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground"
          />
          {displayRepoRoot ? (
            <>
              <span className="max-w-22 truncate">
                {basename(displayRepoRoot)}
              </span>
              <span className="text-muted-foreground/60">/</span>
            </>
          ) : null}
          <span className="max-w-24 truncate">{repoLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {displayRepoRoot ? (
          <>
            <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
              {t("scm.repository")}
            </DropdownMenuLabel>
            <div
              className="truncate px-2 pb-1.5 text-[11px] text-muted-foreground"
              title={displayRepoRoot}
            >
              {displayRepoRoot}
            </div>
            {repositoryTarget.mode === "fixed" ? (
              <DropdownMenuItem
                onSelect={() => {
                  onFollowRepositoryContext();
                  setOpen(false);
                }}
                className="cursor-pointer text-[12px]"
              >
                {t("scm.followActiveContext")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            {t("scm.loadingBranches")}
          </div>
        ) : error ? (
          <div className="px-3 py-3 text-[11px] leading-snug text-destructive">
            {error}
          </div>
        ) : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => setDialog({ kind: "create-branch" })}
                className="cursor-pointer text-[12px]"
              >
                {t("scm.branch.new")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {localBranches.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                  {t("scm.localBranches")}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {localBranches.map((b) => (
                    <DropdownMenuSub key={b.name}>
                      <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-2 text-[12px]">
                        {b.isHead ? (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            size={14}
                            strokeWidth={1.8}
                            className="shrink-0"
                          />
                        ) : (
                          <span className="w-3.5 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">
                          {b.name}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-52">
                        <DropdownMenuItem
                          disabled={b.isHead || checkingOut}
                          onSelect={() => void handleCheckout(b.name)}
                          className="cursor-pointer text-[12px]"
                        >
                          {t("scm.branch.switch")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            setDialog({ kind: "rename-branch", from: b.name })
                          }
                          className="cursor-pointer text-[12px]"
                        >
                          {t("scm.branch.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={b.isHead}
                          variant="destructive"
                          onSelect={() =>
                            setDialog({ kind: "delete-branch", name: b.name })
                          }
                          className="cursor-pointer text-[12px]"
                        >
                          {t("scm.branch.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {worktrees.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/85">
                  {t("scm.worktrees")}
                </DropdownMenuLabel>
                <DropdownMenuGroup>
                  {worktrees.map((b) => (
                    <DropdownMenuSub key={b.worktreePath ?? b.name}>
                      <DropdownMenuSubTrigger className="flex cursor-pointer items-center gap-2 text-[12px]">
                        <HugeiconsIcon
                          icon={Folder01Icon}
                          size={14}
                          strokeWidth={1.5}
                          className="shrink-0 text-muted-foreground"
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{b.name}</span>
                          {b.worktreePath && (
                            <span className="truncate text-[10px] text-muted-foreground">
                              {b.worktreePath}
                            </span>
                          )}
                        </div>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-52">
                        <DropdownMenuItem
                          disabled={!b.worktreePath || !onNavigateToPath}
                          onSelect={() => {
                            if (b.worktreePath && onNavigateToPath) {
                              onNavigateToPath(b.worktreePath);
                            }
                          }}
                          className="cursor-pointer text-[12px]"
                        >
                          {t("scm.worktree.open")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={!b.worktreePath}
                          variant="destructive"
                          onSelect={() => {
                            if (!b.worktreePath) return;
                            setDialog({
                              kind: "remove-worktree",
                              path: b.worktreePath,
                              branch: b.name,
                            });
                          }}
                          className="cursor-pointer text-[12px]"
                        >
                          {t("scm.worktree.remove")}
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={() => setDialog({ kind: "add-worktree" })}
                className="cursor-pointer text-[12px]"
              >
                {t("scm.worktree.new")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {branches.length === 0 && (
              <div className="px-3 py-3 text-[11px] text-muted-foreground">
                {t("scm.noBranches")}
              </div>
            )}
          </>
        )}
      </DropdownMenuContent>
      <BranchDialogs
        repoRoot={repoRoot}
        request={dialog}
        onClose={() => setDialog(null)}
        onChanged={() => {
          void loadBranches();
          onRefresh();
        }}
      />
    </DropdownMenu>
  );
}

export const SourceControlPanel = memo(function SourceControlPanel({
  open,
  sourceControl,
  onOpenGitGraph,
  onOpenDiff,
  onOpenFile,
  onNavigateToPath,
  repositoryTarget,
  onFollowRepositoryContext,
}: Props) {
  const t = useT();
  const scm = useSourceControlPanel(open, sourceControl, onOpenDiff);
  const refreshAnimationRef = useRef<number | null>(null);
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  // Which half of the working tree the list shows. The changes pane first, like the editor's own
  // source control: what you are about to stage is the more frequent question.
  const [pane, setPane] = useState<ScmPane>("changes");
  // A row's checkbox is a selection, not the action: nothing on disk changes until the button above
  // the list acts on what is ticked. Cleared when the rows underneath change identity (another pane,
  // another repository, or a batch that moved the ticked files).
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const paneRepoRoot = scm.repo?.repoRoot ?? null;
  // The pane belongs to the repository it was chosen in: another repository's rows are different
  // files, and the focused row key would name a row that no longer exists. Adjusted during render
  // (the documented "store the previous value in state" pattern) rather than in an effect, so the
  // list never paints one frame of the new repository under the old pane.
  const [paneOwner, setPaneOwner] = useState<string | null>(null);
  if (paneOwner !== paneRepoRoot) {
    setPaneOwner(paneRepoRoot);
    setPane("changes");
    setSelected(new Set());
    setFocusedRowKey(null);
  }

  useEffect(() => {
    return () => {
      if (refreshAnimationRef.current) {
        window.clearTimeout(refreshAnimationRef.current);
      }
    };
  }, []);

  const fixedTargetPending = repositoryTargetIsPending({
    target: repositoryTarget,
    loadedContextPath: sourceControl.contextPath,
    loadedRepoRoot: sourceControl.repo?.repoRoot ?? null,
    isLoading: sourceControl.isLoading,
  });
  const panelState = fixedTargetPending ? "loading" : scm.panelState;
  const isRefreshing = panelState === "loading";
  // `t` has to be a dependency: two of the three strings below are translations, so a
  // language switch must recompute the label. Because it was left out, the selector kept
  // showing the previous language until something else changed.
  const repoLabel = useMemo(() => {
    if (fixedTargetPending) return t("scm.loadingRepo");
    if (!scm.status) return t("scm.sourceControl");
    return scm.status.isDetached ? t("scm.detached") : scm.status.branch;
  }, [fixedTargetPending, scm.status, t]);

  const commitShortcut = IS_MAC ? "⌘↩" : "Ctrl+Enter";
  const canCommit =
    scm.stagedEntries.length > 0 &&
    scm.commitMessage.trim().length > 0 &&
    !fixedTargetPending &&
    !scm.actionBusy;
  const commitDisabledReason = scm.actionBusy
    ? t("scm.hint.busy")
    : scm.stagedEntries.length === 0
      ? t("scm.hint.stageFirst")
      : scm.commitMessage.trim().length === 0
        ? t("scm.hint.messageFirst")
        : null;
  const commitHint = canCommit
    ? t("scm.commitWith", { shortcut: commitShortcut })
    : (commitDisabledReason ??
      t("scm.commitWith", { shortcut: commitShortcut }));
  const pushHint = scm.pushHint ?? t("scm.pushUnavailable");
  const stagedCount = scm.stagedEntries.length;
  const unstagedCount = scm.unstagedEntries.length;
  // The list shows one pane at a time, so its header counts that pane's files rather than every
  // changed file in the repository.
  const paneFiles = useMemo(
    () => filesInPane(scm.fileEntries, pane),
    [pane, scm.fileEntries],
  );
  const paneCount = paneFiles.length;
  // The ticked rows of the pane on screen: what the button acts on, read the same way the list
  // header reads it.
  const tickedPaths = selectedInPane(scm.fileEntries, pane, selected);
  const tickedCount = tickedPaths.length;
  const allTicked = allInPaneSelected(scm.fileEntries, pane, selected);
  const pushDisabledReason = fixedTargetPending
    ? t("scm.hint.repoLoading")
    : scm.actionBusy
      ? t("scm.hint.busy")
      : pushHint;
  // The button above the list is the pane's action on the ticked rows, so its reason for being
  // unavailable is that nothing is ticked - or that the repository is not ready, or busy.
  const stageDisabledReason = fixedTargetPending
    ? t("scm.hint.repoLoading")
    : scm.actionBusy
      ? t("scm.hint.busy")
      : tickedCount === 0
        ? t("scm.hint.nothingSelected")
        : null;
  const stageHint =
    stageDisabledReason ??
    (pane === "staged" ? t("scm.unstageSelected") : t("scm.stageSelected"));
  const pushStatusLabel = upstreamBadgeLabel(
    scm.status?.upstream,
    t("scm.noUpstream"),
  );
  const hasUpstream = !!scm.status?.upstream;
  const isDiverged =
    !!scm.status && scm.status.ahead > 0 && scm.status.behind > 0;

  const canPull =
    hasUpstream &&
    !!scm.status &&
    scm.status.behind > 0 &&
    !isDiverged &&
    !fixedTargetPending &&
    !scm.actionBusy &&
    !sourceControl.busyAction;
  const canFetch =
    hasUpstream &&
    !fixedTargetPending &&
    !scm.actionBusy &&
    !sourceControl.busyAction;

  const footerFeedback = useMemo(() => {
    if (scm.actionError)
      return { tone: "error", message: scm.actionError } as const;
    if (scm.remoteError)
      return { tone: "error", message: scm.remoteError } as const;
    if (scm.actionMessage)
      return { tone: "success", message: scm.actionMessage } as const;
    return null;
  }, [scm.actionError, scm.actionMessage, scm.remoteError]);

  const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      canCommit
    ) {
      event.preventDefault();
      void scm.commit();
      return;
    }
  };

  /**
   * The three header actions, reading the latest summaries through a ref.
   *
   * `scm` and `sourceControl` are new objects on every refresh, so depending on them would give these
   * callbacks a new identity on every refresh, which is exactly what a memoised header compares
   * against. They are handed to the header as props, so their identity has to be stable.
   */
  const latestScm = useRef({ scm, sourceControl });
  latestScm.current = { scm, sourceControl };

  const handleRefresh = useCallback(() => {
    setRefreshAnimating(true);
    if (refreshAnimationRef.current) {
      window.clearTimeout(refreshAnimationRef.current);
    }
    void latestScm.current.scm.refresh().finally(() => {
      refreshAnimationRef.current = window.setTimeout(() => {
        setRefreshAnimating(false);
        refreshAnimationRef.current = null;
      }, 450);
    });
  }, []);

  const handleFetch = useCallback(() => {
    void latestScm.current.sourceControl.runRemoteAction("fetch");
  }, []);

  const handlePull = useCallback(() => {
    void latestScm.current.sourceControl.runRemoteAction("pull");
  }, []);

  const rows = useMemo<RowDescriptor[]>(() => {
    const result: RowDescriptor[] = [];
    if (isDiverged) {
      result.push({ kind: "banner-diverged", key: "banner-diverged" });
    }
    if (paneCount > 0) {
      result.push({
        kind: "list-header",
        key: "list-header",
        count: paneCount,
        pane,
      });
      for (const entry of paneFiles) {
        result.push({ kind: "entry", key: entry.key, entry });
      }
    }
    return result;
  }, [isDiverged, pane, paneCount, paneFiles]);

  const rowKeyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      map.set(row.key, index);
    });
    return map;
  }, [rows]);

  useEffect(() => {
    if (!focusedRowKey) return;
    if (!rowKeyToIndex.has(focusedRowKey)) {
      setFocusedRowKey(null);
    }
  }, [focusedRowKey, rowKeyToIndex]);

  const focusableIndices = useMemo(() => {
    const out: number[] = [];
    rows.forEach((row, index) => {
      if (row.kind === "entry") out.push(index);
    });
    return out;
  }, [rows]);

  const estimateSize = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return ROW_HEIGHTS.entry;
      switch (row.kind) {
        case "banner-diverged":
          return ROW_HEIGHTS.banner;
        case "list-header":
          return ROW_HEIGHTS.header;
        case "entry":
          return ROW_HEIGHTS.entry;
      }
    },
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      if (focusableIndices.length === 0) return;
      const currentIndex =
        focusedRowKey === null ? -1 : (rowKeyToIndex.get(focusedRowKey) ?? -1);
      let pos = focusableIndices.indexOf(currentIndex);
      if (pos === -1) pos = direction > 0 ? -1 : focusableIndices.length;
      let nextPos = pos + direction;
      if (nextPos < 0) nextPos = 0;
      if (nextPos > focusableIndices.length - 1)
        nextPos = focusableIndices.length - 1;
      const targetRowIndex = focusableIndices[nextPos];
      const target = rows[targetRowIndex];
      if (!target) return;
      setFocusedRowKey(target.key);
      virtualizer.scrollToIndex(targetRowIndex, { align: "auto" });
    },
    [focusableIndices, focusedRowKey, rowKeyToIndex, rows, virtualizer],
  );

  const focusedEntry = useCallback((): SourceControlFileEntry | null => {
    if (!focusedRowKey) return null;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return null;
    const row = rows[index];
    return row && row.kind === "entry" ? row.entry : null;
  }, [focusedRowKey, rowKeyToIndex, rows]);

  /**
   * A row's checkbox is a selection, not the action: the button above the list acts on what is
   * ticked - staging in the changes pane, unstaging in the staged pane. Ticking a box therefore
   * leaves the repository alone, which is the whole point of it (a tick used to stage on the spot).
   */
  const toggleTick = useCallback((path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleAllTicked = useCallback(() => {
    setSelected((current) => togglePaneSelection(scm.fileEntries, pane, current));
  }, [pane, scm.fileEntries]);

  const applyToTicked = useCallback(async () => {
    const paths = selectedInPane(scm.fileEntries, pane, selected);
    if (paths.length === 0) return;
    await scm.setFilesStaged(paths, paneAction(pane) === "stage");
    // Those paths have moved to the other pane; a selection naming them would name rows this pane no
    // longer lists.
    setSelected(new Set());
  }, [pane, scm.fileEntries, scm.setFilesStaged, selected]);

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.closest("button"))
      ) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        handleRefresh();
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Enter": {
          const entry = focusedEntry();
          if (entry) {
            event.preventDefault();
            void scm.selectFile(entry);
          }
          break;
        }
        case " ":
        case "s":
        case "S": {
          if (meta) break;
          const entry = focusedEntry();
          if (entry) {
            // The same reading as the row's checkbox: tick it, change nothing on disk.
            event.preventDefault();
            toggleTick(entry.path);
          }
          break;
        }
        case "d":
        case "D": {
          if (meta) break;
          const entry = focusedEntry();
          if (entry?.unstaged) {
            event.preventDefault();
            scm.requestDiscardFile(entry);
          }
          break;
        }
      }
    },
    [focusedEntry, handleRefresh, moveFocus, scm, toggleTick],
  );

  if (!open) return null;

  const fetchBusy = sourceControl.busyAction === "fetch";
  const pullBusy = sourceControl.busyAction === "pull";

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <aside className="flex min-h-0 min-w-0 flex-1 flex-col [contain:layout_style]">
        <ScmHeader
          repoRoot={fixedTargetPending ? null : (scm.repo?.repoRoot ?? null)}
          repoLabel={repoLabel}
          displayRepoRoot={
            repositoryTarget.mode === "fixed"
              ? repositoryTarget.repoRoot
              : (scm.repo?.repoRoot ?? null)
          }
          repositoryTarget={repositoryTarget}
          ahead={scm.status?.ahead ?? 0}
          behind={scm.status?.behind ?? 0}
          detached={scm.status?.isDetached === true}
          fetchBusy={fetchBusy}
          pullBusy={pullBusy}
          isDiverged={isDiverged}
          hasUpstream={hasUpstream}
          canFetch={canFetch}
          canPull={canPull}
          refreshDisabled={isRefreshing || !!scm.actionBusy}
          refreshing={isRefreshing}
          refreshAnimating={refreshAnimating}
          onFollowRepositoryContext={onFollowRepositoryContext}
          onNavigateToPath={onNavigateToPath}
          onRefresh={handleRefresh}
          onFetch={handleFetch}
          onPull={handlePull}
        />

        {onOpenGitGraph ? (
          <button
            type="button"
            onClick={() => onOpenGitGraph()}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={13}
              strokeWidth={1.85}
              className="shrink-0"
            />
            <span className="flex-1 text-[12px] font-medium">
              {t("scm.commitGraph")}
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2}
              className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5"
            />
          </button>
        ) : null}

        {panelState === "loading" ? (
          <PanelCenter title={t("scm.loading")} />
        ) : null}

        {panelState === "no-repo" ? (
          <PanelCenter title={t("scm.noRepo")} body={t("scm.noRepo.body")} />
        ) : null}

        {panelState === "error" ? (
          <PanelCenter
            title={t("scm.error")}
            body={scm.statusError ?? t("scm.unknownError")}
            action={
              <Button size="sm" onClick={() => void scm.refresh()}>
                {t("scm.retry")}
              </Button>
            }
          />
        ) : null}

        {panelState === "ready" && scm.status ? (
          <>
            <div className="relative shrink-0 space-y-2 border-b border-border/40 bg-gradient-to-b from-card/65 to-card/30 px-2.5 pb-2.5 pt-2.5">
              <div
                className={cn(
                  "relative rounded-lg border bg-background/95 shadow-sm transition-colors",
                  scm.commitMessage.length > 0
                    ? "border-border/70"
                    : "border-border/45",
                  "focus-within:border-primary/45 focus-within:shadow-md focus-within:shadow-primary/5",
                )}
              >
                <Textarea
                  value={scm.commitMessage}
                  onChange={(event) => scm.setCommitMessage(event.target.value)}
                  onKeyDown={handleCommitShortcut}
                  placeholder={t("scm.commitMessage")}
                  rows={3}
                  className={cn(
                    "min-h-[72px] border-border resize-none rounded-lg bg-transparent px-3 pb-7 pt-2.5 text-[12.5px] leading-snug shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-0 focus:border-0",
                  )}
                />
                <div className="pointer-events-none absolute inset-x-3 bottom-1.5 flex items-center justify-between p-1 gap-2 text-[10px] tabular-nums text-muted-foreground/55">
                  {scm.commitMessage.length > 0 ? (
                    <span>
                      {t("scm.charCount", { count: scm.commitMessage.length })}
                    </span>
                  ) : (
                    <span className="flex gap-2 items-center">
                      {commitShortcut} <p>{t("scm.commitHintSuffix")}</p>
                    </span>
                  )}
                </div>
              </div>

              <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full transition-colors",
                    canCommit
                      ? "bg-foreground/80"
                      : stagedCount > 0
                        ? "bg-muted-foreground/60"
                        : "bg-muted-foreground/30",
                  )}
                />
                <span className="truncate font-medium text-foreground/85">
                  {stagedCount === 0
                    ? t("scm.nothingStaged")
                    : t(
                        stagedCount === 1
                          ? "scm.stagedFile"
                          : "scm.stagedFiles",
                        {
                          count: String(stagedCount),
                        },
                      )}
                </span>
                <span className="ml-auto shrink-0 truncate text-muted-foreground/65">
                  {pushStatusLabel}
                </span>
              </div>

              <div className="grid w-full grid-cols-3 gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="secondary"
                      data-scm-stage-all=""
                      data-scm-selected-count={tickedCount}
                      className="h-7 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={stageDisabledReason !== null}
                      onClick={() => void applyToTicked()}
                    >
                      {scm.actionBusy === "stage:selection"
                        ? t("scm.staging")
                        : scm.actionBusy === "unstage:selection"
                          ? t("scm.unstaging")
                          : pane === "staged"
                            ? t("scm.unstage")
                            : t("scm.stage")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "max-w-64 text-[10.5px]",
                    )}
                  >
                    {stageHint}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      className="h-7 cursor-pointer text-[11.5px] font-semibold tracking-tight shadow-sm disabled:cursor-not-allowed disabled:shadow-none"
                      disabled={!canCommit}
                      onClick={() => void scm.commit()}
                    >
                      {scm.actionBusy === "commit"
                        ? t("scm.committing")
                        : t("scm.commit")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "text-[10.5px]",
                    )}
                  >
                    {commitHint}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={
                        !scm.canPush || fixedTargetPending || !!scm.actionBusy
                      }
                      onClick={() => void scm.push()}
                    >
                      {scm.actionBusy === "push"
                        ? t("scm.pushing")
                        : t("scm.push")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "max-w-64 text-[10.5px]",
                    )}
                  >
                    {pushDisabledReason}
                  </TooltipContent>
                </Tooltip>
              </div>

              <CommitFeedback feedback={footerFeedback} />
            </div>

            {scm.allClean ? (
              <CleanTreeHint repoLabel={repoLabel} />
            ) : (
              <>
                <PaneTabs
                  pane={pane}
                  stagedCount={stagedCount}
                  unstagedCount={unstagedCount}
                  onSelect={(next) => {
                    setPane(next);
                    // A selection belongs to the pane it was made in: the rows below are about to be
                    // different files.
                    setSelected(new Set());
                  }}
                />
                <div
                  ref={containerRef}
                  tabIndex={0}
                  role="listbox"
                  aria-label={t("scm.changedFiles")}
                  aria-activedescendant={
                    focusedRowKey ? `scm-row-${focusedRowKey}` : undefined
                  }
                  onKeyDown={handlePanelKeyDown}
                  className="relative min-h-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                >
                  <div
                    ref={scrollRef}
                    className="h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
                  >
                    {paneCount === 0 ? (
                      // One pane can be empty while the other is not, which the clean-tree hint
                      // above would be wrong about: it speaks for the whole working tree.
                      <p
                        data-scm-empty=""
                        className="px-3 py-2 text-[11px] text-muted-foreground"
                      >
                        {pane === "staged"
                          ? scm.stagedEmptyText
                          : scm.unstagedEmptyText}
                      </p>
                    ) : (
                      <div
                        style={{
                          height: virtualizer.getTotalSize(),
                          position: "relative",
                          width: "100%",
                        }}
                      >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                          const row = rows[virtualRow.index];
                          if (!row) return null;
                          return (
                            <div
                              key={virtualRow.key}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                height: virtualRow.size,
                                transform: `translateY(${virtualRow.start}px)`,
                              }}
                            >
                          <RowRenderer
                            row={row}
                            focused={focusedRowKey === row.key}
                            selectedPath={scm.selected?.path ?? null}
                            actionBusy={scm.actionBusy}
                            allTicked={allTicked}
                            repoRoot={scm.repo?.repoRoot ?? null}
                            pane={pane}
                            tickedPaths={selected}
                            onFocusRow={setFocusedRowKey}
                            onToggleAll={toggleAllTicked}
                            onToggleTick={toggleTick}
                            onSelectFile={scm.selectFile}
                            onToggleStageFile={scm.toggleStageFile}
                            onDiscardFile={scm.requestDiscardFile}
                            onOpenFile={onOpenFile}
                          />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        ) : null}
      </aside>

      {panelState === "ready" && scm.repo ? (
        <StashSection
          repoRoot={scm.repo.repoRoot}
          onChanged={() => scm.refresh()}
        />
      ) : null}

      <AlertDialog
        open={scm.pendingDiscard !== null}
        onOpenChange={(o) => {
          if (!o) scm.cancelPendingDiscard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("scm.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {scm.pendingDiscard?.scope === "all"
                ? t("scm.discardAll.body", { label: scm.pendingDiscard.label })
                : scm.pendingDiscard
                  ? t("scm.discardOne.body", {
                      label: scm.pendingDiscard.label,
                    })
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => scm.cancelPendingDiscard()}>
              {t("scm.common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void scm.confirmPendingDiscard()}>
              {t("scm.common.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
});

function PanelCenter({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body ? (
        <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

function CleanTreeHint({ repoLabel }: { repoLabel: string }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full border border-border/55 text-muted-foreground">
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <div className="text-[12px] font-medium text-foreground">
        {t("scm.workingTreeClean")}
      </div>
      <div className="text-[10.5px] leading-snug text-muted-foreground">
        {t("scm.cleanTreeOn")}{" "}
        <span className="font-mono text-foreground/80">{repoLabel}</span>
      </div>
    </div>
  );
}

type RowRendererProps = {
  row: RowDescriptor;
  focused: boolean;
  selectedPath: string | null;
  actionBusy: string | null;
  /** Whether every row in the pane is ticked - what the list header's checkbox shows. */
  allTicked: boolean;
  repoRoot: string | null;
  /** Which pane's rows these are: the list header and the row labels both read it. */
  pane: ScmPane;
  /** The ticked paths of the whole panel; a row reads its own out of it. */
  tickedPaths: ReadonlySet<string>;
  onFocusRow: (key: string | null) => void;
  onToggleAll: () => void;
  /** Ticking a row: a selection, not a stage. */
  onToggleTick: (path: string) => void;
  onSelectFile: (entry: SourceControlFileEntry) => Promise<void>;
  onToggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  onDiscardFile: (entry: SourceControlFileEntry) => void;
  onOpenFile?: (absolutePath: string) => void;
};

const RowRenderer = memo(function RowRenderer(props: RowRendererProps) {
  const { row } = props;
  switch (row.kind) {
    case "banner-diverged":
      return <DivergedBanner />;
    case "list-header":
      return <ListHeader {...props} row={row} />;
    case "entry":
      return <EntryRow {...props} row={row} />;
  }
});

function DivergedBanner() {
  const t = useT();
  return (
    <div className="mx-2 mt-1 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-foreground/[0.04] px-2 text-[10.5px] leading-none text-muted-foreground">
      <HugeiconsIcon
        icon={Alert02Icon}
        size={11}
        strokeWidth={1.9}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground/85">
          {t("scm.diverged")}
        </span>
        <span className="ml-1 opacity-75">{t("scm.diverged.hint")}</span>
      </span>
    </div>
  );
}

/**
 * The two panes of the working tree, as one strip above the list. The same shape as the sidebar
 * rail's sessions/files switch, because it is the same kind of control: two views of one list, not
 * an action and its fallback.
 */
function PaneTabs({
  pane,
  stagedCount,
  unstagedCount,
  onSelect,
}: {
  pane: ScmPane;
  stagedCount: number;
  unstagedCount: number;
  onSelect: (pane: ScmPane) => void;
}) {
  const t = useT();
  return (
    <div className="flex shrink-0 items-stretch gap-1 border-b border-border/40 px-2 py-1">
      {(["changes", "staged"] as const).map((id) => {
        const active = pane === id;
        return (
          <button
            key={id}
            type="button"
            data-scm-pane={id}
            aria-pressed={active}
            onClick={() => onSelect(id)}
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
              active
                ? "bg-foreground/[0.07] text-foreground dark:bg-foreground/[0.09]"
                : "text-muted-foreground hover:bg-foreground/[0.045] hover:text-foreground",
            )}
          >
            <span className="truncate">
              {t(id === "staged" ? "scm.pane.staged" : "scm.changes")}
            </span>
            <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full border border-border/60 px-1 text-[9.5px] font-semibold tabular-nums">
              {id === "staged" ? stagedCount : unstagedCount}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ListHeader({
  row,
  allTicked,
  actionBusy,
  onToggleAll,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "list-header" }>;
}) {
  const t = useT();
  return (
    <div className="flex h-7 items-center gap-2 px-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        {t(row.pane === "staged" ? "scm.pane.staged" : "scm.changes")}
      </span>
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 px-1 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
        {row.count}
      </span>
      {/* "All" here means all of this pane's rows are ticked - the button above is what acts on
          them. */}
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the label wraps a Radix checkbox, which renders a button with its own aria-label, so the control cannot be resolved statically */}
      <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground">
        <span>{t("scm.all")}</span>
        <Checkbox
          aria-label={t("scm.all")}
          checked={allTicked}
          disabled={actionBusy !== null}
          onCheckedChange={() => onToggleAll()}
          className="size-3.5"
        />
      </label>
    </div>
  );
}

const EntryRow = memo(function EntryRow({
  row,
  focused,
  selectedPath,
  actionBusy,
  repoRoot,
  pane,
  tickedPaths,
  onFocusRow,
  onSelectFile,
  onToggleTick,
  onToggleStageFile,
  onDiscardFile,
  onOpenFile,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "entry" }>;
}) {
  const t = useT();
  const entry = row.entry;
  const counts = lineCounts(entry.added, entry.removed);
  const isSelected = selectedPath === entry.path;
  const fileName = basename(entry.path);
  const pathLabel = entryPathLabel(entry);
  // The pane says what the row's own controls mean. Its checkbox is the tick the button above acts
  // on; discarding is offered only where there is a working-tree edit to lose.
  const paneStaged = pane === "staged";
  const ticked = tickedPaths.has(entry.path);
  const showDiscard = !paneStaged;
  const isStageBusy =
    actionBusy === `stage:${entry.path}` ||
    actionBusy === `unstage:${entry.path}`;
  const isDiscardBusy = actionBusy === `discard:${entry.path}`;
  const disabled = actionBusy !== null;

  const absolutePath = repoRoot
    ? joinPath(repoRoot.replace(/\\/g, "/"), entry.path.replace(/\\/g, "/"))
    : null;
  const isDeleted = entry.statusCode === "D";
  const statusLetterOf = statusLetter(entry.statusCode);
  const statusLetterLabelOf = statusLetterLabel(entry.statusCode);
  const revealLabel = IS_MAC ? t("scm.revealFinder") : t("scm.revealManager");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/useFocusableInteractive: the listbox above holds DOM focus and points at the active row with aria-activedescendant, so the option must not be focusable */}
        <div
          id={`scm-row-${row.key}`}
          data-scm-row=""
          data-scm-path={entry.path}
          data-focused={focused || undefined}
          data-selected={isSelected || undefined}
          role="option"
          aria-selected={isSelected}
          onMouseDown={() => onFocusRow(row.key)}
          className={cn(
            "group relative flex h-[30px] items-center gap-2 rounded-md pl-2 pr-2 transition-all duration-100",
            focused
              ? "bg-accent/60"
              : isSelected
                ? "bg-accent/55 text-foreground"
                : "hover:bg-accent/30",
          )}
        >
          <span
            className={cn(
              "pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity",
              statusAccent(entry.statusCode),
              isSelected || focused
                ? "opacity-100"
                : "opacity-55 group-hover:opacity-95",
            )}
            aria-hidden
          />
          <button
            type="button"
            onClick={() => {
              onFocusRow(row.key);
              void onSelectFile(entry);
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            <FileIcon name={fileName} className="size-4 shrink-0" />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
              <span
                className={cn(
                  "truncate text-[12px] leading-tight",
                  isSelected || focused
                    ? "font-semibold text-foreground"
                    : "font-medium text-foreground/95",
                  pathLabel ? "max-w-[58%] shrink-0" : "min-w-0 flex-1",
                )}
              >
                {fileName}
              </span>
              {pathLabel ? (
                <span className="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-muted-foreground/75">
                  {pathLabel}
                </span>
              ) : null}
            </div>
          </button>

          {counts ? (
            // aria-label rather than two bare spans: "+13 -0" is read as "plus thirteen minus
            // zero" otherwise, which is not a sentence. `data-scm-counts` is the probe's handle on
            // the two numbers; the row above carries `data-scm-path` to name them.
            <span
              data-scm-counts=""
              role="img"
              aria-label={t("scm.lineCounts", {
                added: String(entry.added),
                removed: String(entry.removed),
              })}
              title={t("scm.lineCounts", {
                added: String(entry.added),
                removed: String(entry.removed),
              })}
              className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-medium tabular-nums"
            >
              <span className="text-emerald-500">{counts.added}</span>
              <span className="text-rose-500">{counts.removed}</span>
            </span>
          ) : null}

          {statusLetterOf ? (
            // After the counts, in a fixed-width slot so a column of letters lines up down the
            // list. The bar on the left already carries this colour; the letter says what it means.
            <span
              data-scm-status={statusLetterOf}
              title={statusLetterLabelOf}
              className={cn(
                "w-3 shrink-0 text-center text-[10px] font-semibold leading-none",
                statusLetterColor(entry.statusCode),
              )}
            >
              {statusLetterOf}
            </span>
          ) : null}

          {showDiscard ? (
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 data-[focused=true]:opacity-100 data-[selected=true]:opacity-100">
              <IconActionButton
                label={t("scm.discardFile", { path: entry.path })}
                disabled={disabled}
                side="top"
                onClick={() => onDiscardFile(entry)}
              >
                {isDiscardBusy ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon
                    icon={RemoveSquareIcon}
                    size={11}
                    strokeWidth={1.9}
                  />
                )}
              </IconActionButton>
            </div>
          ) : null}

          <span className="flex size-5 shrink-0 items-center justify-center">
            {isStageBusy ? (
              <Spinner className="size-3" />
            ) : (
              <Checkbox
                aria-label={
                  paneStaged
                    ? t("scm.tickToUnstage", { path: entry.path })
                    : t("scm.tickToStage", { path: entry.path })
                }
                checked={ticked}
                disabled={disabled}
                onCheckedChange={() => onToggleTick(entry.path)}
                className="size-3.5"
              />
            )}
          </span>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className={COMPACT_CONTENT}>
        {/* Open actions */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => {
            onFocusRow(row.key);
            void onSelectFile(entry);
          }}
        >
          {t("scm.openDiff")}
        </ContextMenuItem>
        {!isDeleted && onOpenFile && absolutePath ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenFile(absolutePath)}
          >
            {t("scm.openFile")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />

        {/* Stage / Unstage */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          disabled={disabled}
          onSelect={() => void onToggleStageFile(entry)}
        >
          {entry.checkState === "checked" ? t("scm.unstage") : t("scm.stage")}
        </ContextMenuItem>
        {entry.unstaged ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            variant="destructive"
            disabled={disabled}
            onSelect={() => onDiscardFile(entry)}
          >
            {t("scm.discardChanges")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />

        {/* Copy paths */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(entry.path.replace(/\\/g, "/"))}
        >
          {t("scm.copyRelativePath")}
        </ContextMenuItem>
        {absolutePath ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => void copyToClipboard(absolutePath)}
          >
            {t("scm.copyAbsolutePath")}
          </ContextMenuItem>
        ) : null}

        {/* Reveal in Finder: only for existing files */}
        {!isDeleted && absolutePath ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void revealInFinder(absolutePath)}
            >
              {revealLabel}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
});

type ScmHeaderProps = {
  repoRoot: string | null;
  repoLabel: string;
  displayRepoRoot: string | null;
  repositoryTarget: SourceControlRepositoryTarget;
  ahead: number;
  behind: number;
  detached: boolean;
  fetchBusy: boolean;
  pullBusy: boolean;
  isDiverged: boolean;
  hasUpstream: boolean;
  canFetch: boolean;
  canPull: boolean;
  refreshDisabled: boolean;
  refreshing: boolean;
  refreshAnimating: boolean;
  onFollowRepositoryContext: () => void;
  onNavigateToPath?: (path: string) => void;
  onRefresh: () => void;
  onFetch: () => void;
  onPull: () => void;
};

/**
 * The panel's header: the branch selector, the ahead/behind counts and the three remote actions.
 *
 * Memoised, and every input is a primitive or a stable callback, because the panel re-renders on
 * every `git status` (a refresh replaces the whole summary object) while the header's own contents
 * change only when the branch, the counts or a busy flag do. It was the most expensive single piece
 * of those re-renders: three icon buttons, each with a tooltip and a popper layer, plus the branch
 * menu beside them.
 */
const ScmHeader = memo(function ScmHeader({
  repoRoot,
  repoLabel,
  displayRepoRoot,
  repositoryTarget,
  ahead,
  behind,
  detached,
  fetchBusy,
  pullBusy,
  isDiverged,
  hasUpstream,
  canFetch,
  canPull,
  refreshDisabled,
  refreshing,
  refreshAnimating,
  onFollowRepositoryContext,
  onNavigateToPath,
  onRefresh,
  onFetch,
  onPull,
}: ScmHeaderProps) {
  const t = useT();

  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 pb-2.5 pt-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <BranchDropdown
          repoRoot={repoRoot}
          repoLabel={repoLabel}
          displayRepoRoot={displayRepoRoot}
          repositoryTarget={repositoryTarget}
          onFollowRepositoryContext={onFollowRepositoryContext}
          onNavigateToPath={onNavigateToPath}
          onRefresh={onRefresh}
        />
        {ahead > 0 || behind > 0 ? (
          <div className="flex shrink-0 items-center gap-0.5 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground">
            {ahead > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                <HugeiconsIcon
                  icon={ArrowUp01Icon}
                  size={9}
                  strokeWidth={2.2}
                />
                {ahead}
              </span>
            ) : null}
            {behind > 0 ? (
              <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  size={9}
                  strokeWidth={2.2}
                />
                {behind}
              </span>
            ) : null}
          </div>
        ) : null}
        {detached ? (
          <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("scm.detached")}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconActionButton
          label={fetchBusy ? t("scm.fetching") : t("scm.fetch")}
          disabled={!canFetch}
          onClick={onFetch}
          side="bottom"
        >
          {fetchBusy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon
              icon={FolderCloudIcon}
              size={14}
              strokeWidth={1.85}
            />
          )}
        </IconActionButton>
        <IconActionButton
          label={
            pullBusy
              ? t("scm.pulling")
              : isDiverged
                ? t("scm.pullDiverged")
                : !hasUpstream
                  ? t("scm.pullNoUpstream")
                  : behind === 0
                    ? t("scm.pullUpToDate")
                    : t("scm.pullBehind", { count: String(behind) })
          }
          disabled={!canPull}
          onClick={onPull}
          side="bottom"
        >
          {pullBusy ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={Download01Icon} size={14} strokeWidth={1.9} />
          )}
        </IconActionButton>
        <IconActionButton
          label={t("scm.refresh")}
          disabled={refreshDisabled}
          onClick={onRefresh}
          side="bottom"
        >
          {refreshing ? (
            <Spinner className="size-3.5" />
          ) : (
            <HugeiconsIcon
              icon={Refresh01Icon}
              size={14}
              strokeWidth={1.9}
              className={cn(refreshAnimating && "animate-spin")}
            />
          )}
        </IconActionButton>
      </div>
    </header>
  );
});

function IconActionButton({
  label,
  disabled,
  side = "left",
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top" | "right" | "bottom";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6 p-3 cursor-pointer rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function CommitFeedback({
  feedback,
}: {
  feedback: { tone: "error" | "success"; message: string } | null;
}) {
  const [visibleFeedback, setVisibleFeedback] = useState(feedback);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!feedback) {
      setIsVisible(false);
      return;
    }
    setVisibleFeedback(feedback);
    setIsVisible(true);
    const hideTimer = window.setTimeout(() => setIsVisible(false), 3600);
    const clearTimer = window.setTimeout(() => {
      setVisibleFeedback((current) =>
        current?.message === feedback.message && current.tone === feedback.tone
          ? null
          : current,
      );
    }, 3900);
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [feedback]);

  if (!visibleFeedback) return null;

  const isError = visibleFeedback.tone === "error";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-3 top-[calc(100%-0.25rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 transition-all duration-200",
        isVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
        isError
          ? "border-destructive/30 bg-card text-destructive"
          : "border-border/70 bg-card text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError ? "bg-destructive" : "bg-foreground/70",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {visibleFeedback.message}
      </span>
    </div>
  );
}
