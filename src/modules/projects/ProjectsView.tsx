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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CloneRepoDialog } from "./CloneRepoDialog";
import { Input } from "@/components/ui/input";
import { SortHeader } from "@/components/ui/sort-header";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useLanguage, useT, type MessageKey } from "@/modules/i18n";
import {
  AGENT_TOOLS,
  AgentIcon,
  type AgentSession,
  type AgentTool,
  loadAllAgentSessions,
  relativeTime,
} from "@/modules/launcher";
import { native, type WireProjectTarget } from "@/lib/native";
import { type Account, accountFrom, ownershipLabelKey } from "@/lib/ownership";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { discoveredEntries, entriesFromPaths } from "./lib/entries";
import {
  basename,
  mergeProjectPaths,
  normalizePath,
  removeProjectPath,
  samePath,
} from "./lib/paths";
import {
  filterRows,
  ownershipOfRow,
  sortRows,
  stateOf,
  type RowState,
  type SortState,
} from "./lib/rows";
import { loadProjectPaths, saveProjectPaths } from "./lib/store";
import {
  forgetStatuses,
  readStatusSnapshot,
  rememberStatuses,
} from "./lib/statusStore";
import { pickProjectDir } from "./lib/pickDir";
import { pullBlocker } from "./lib/pull";
import type { ProjectEntry, ProjectRow, ProjectStatus } from "./lib/types";

/** Scan depth. Two levels cover the "workspace directory → individual repos" layout. */
const SCAN_DEPTH = 2;

type Props = {
  /**
   * Whether this tab is the one currently shown. The view stays mounted (to keep
   * scroll and sort state), but the project list and statuses only load while
   * active: running git status over 15 repos at startup would be wasted work.
   */
  active: boolean;
  /** Clicking a project row: switch to a workspace rooted at that project, creating
   * one if needed. */
  onOpenWorkspace: (entry: ProjectEntry) => void;
  /** Open a plain terminal tab at the project root. */
  onOpenTerminal: (entry: ProjectEntry) => void;
  /** Start an interactive session for one agent at the project root (new session,
   * no --session). */
  onNewSession: (entry: ProjectEntry, tool: AgentTool) => void;
};

const TONE_CLASS: Record<RowState["tone"], string> = {
  clean: "text-emerald-500",
  dirty: "text-amber-500",
  ahead: "text-sky-500",
  behind: "text-orange-500",
  diverged: "text-orange-500",
  warn: "text-muted-foreground",
  error: "text-destructive",
  unknown: "text-muted-foreground",
};

export function ProjectsView({
  active,
  onOpenWorkspace,
  onOpenTerminal,
  onNewSession,
}: Props) {
  const t = useT();
  const language = useLanguage();

  const [paths, setPaths] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  /**
   * The last check, read from the file when the panel comes to the front (see `statusStore`):
   * opening it shows the rows as they were instead of showing every one of them as unchecked
   * until the batch of git reads comes back. The check that runs right after is what settles
   * anything that moved since.
   */
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  /** Which check the statuses on screen came from, to let a slower read lose the race. */
  const snapshotAt = useRef(0);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<Account>(null);
  const [accountRead, setAccountRead] = useState(false);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [scanning, setScanning] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<ProjectEntry | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  /** Normalized path of the project being pulled right now; null when idle. */
  const [pulling, setPulling] = useState<string | null>(null);
  /**
   * Normalized path of the row whose own refresh button was pressed.
   *
   * The refresh itself re-reads every row (it fetches first, then compares), so there is nothing
   * to make per-row on the back end. What has to be per-row is the *feedback*: the ⟳ the user
   * clicked is the one that has to spin, not the whole panel's button.
   */
  const [refreshingRow, setRefreshingRow] = useState<string | null>(null);

  // The list is read once and every later change is written back to the same file.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void loadProjectPaths()
      .then((loaded) => {
        if (alive) setPaths(loaded);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [active]);

  // Sessions link project rows to agent sessions; failing to read them must not
  // block the project list itself.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void loadAllAgentSessions()
      .then((load) => {
        if (!alive) return;
        setSessions(load.sessions);
      })
      .catch(() => {
        // A failed read only leaves the popover empty; the sessions panel is already
        // responsible for surfacing that error.
      });
    return () => {
      alive = false;
    };
  }, [active]);

  // Which projects are the account's own: read once the panel is shown, since it costs a
  // `gh repo list`. A failed read is not remembered, so switching sub-tabs tries again.
  useEffect(() => {
    if (!active || accountRead) return;
    let alive = true;
    void native
      .githubRepos()
      .then((payload) => {
        if (!alive) return;
        setAccount(accountFrom(payload.login, payload.repos));
        setAccountRead(true);
      })
      .catch(() => {
        // No account simply leaves the column unknown; the remote list reports why.
      });
    return () => {
      alive = false;
    };
  }, [active, accountRead]);

  // The file is what this window starts from, so it is read when the panel comes to the front.
  // The snapshot in it can be older than a check that has already run in this window, which is
  // what `snapshotAt` settles: a read that lands late does not undo what is on screen.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void readStatusSnapshot()
      .then((snapshot) => {
        if (!alive || !snapshot || snapshot.at <= snapshotAt.current) return;
        snapshotAt.current = snapshot.at;
        setStatuses(snapshot.statuses);
        setCheckedAt(snapshot.at);
      })
      .catch(() => {
        // Nothing remembered is the same as nothing to show; the check covers it.
      });
    return () => {
      alive = false;
    };
  }, [active]);

  const managed = useMemo(
    () => (paths ? entriesFromPaths(paths) : []),
    [paths],
  );

  const entries = useMemo(
    () => [...managed, ...discoveredEntries(sessions, managed)],
    [managed, sessions],
  );

  const refresh = useCallback(async () => {
    if (!active) return;
    // The list has not been read yet, so there is nothing to check and nothing to say about it:
    // the rows on screen stay as they are, and this runs again once the entries land (it depends
    // on them). Treating "not loaded yet" as "no projects" would write an empty snapshot into
    // the file and wipe what the next window was going to open on.
    if (paths === null) return;
    if (entries.length === 0) {
      setStatuses({});
      snapshotAt.current = Date.now();
      setCheckedAt(snapshotAt.current);
      rememberStatuses({ at: snapshotAt.current, statuses: {} });
      return;
    }
    setChecking(true);
    setError(null);
    try {
      // Authorize each one first: git cannot even start in an unauthorized project,
      // so its status would be wrong.
      await Promise.allSettled(
        entries.map((entry) =>
          native.workspaceAuthorize(entry.path, entry.workspace),
        ),
      );
      const items: WireProjectTarget[] = entries.map((entry) => ({
        path: entry.path,
        workspace: entry.workspace,
      }));
      // Checking fetches first: only remote-tracking refs move, no working tree is
      // touched, and "behind 3" then means 3 commits behind the remote as it is now.
      // A row whose fetch failed says so instead of passing off a stale comparison.
      const rows = await native.projectsStatus(items, true);
      const next: Record<string, ProjectStatus> = {};
      for (const row of rows) next[normalizePath(row.path)] = row;
      // Stamp it before the state lands, so a slower file read cannot undo it.
      snapshotAt.current = Date.now();
      setStatuses(next);
      setCheckedAt(snapshotAt.current);
      // Kept for the next window. A failed check writes nothing: what the file holds is the
      // last thing that was true.
      rememberStatuses({ at: snapshotAt.current, statuses: next });
    } catch (e) {
      // A whole-batch failure (backend crash, say) is reported honestly instead of
      // pretending everything is clean.
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [active, entries, paths]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows: ProjectRow[] = useMemo(
    () =>
      entries.map((entry) => {
        const status = statuses[normalizePath(entry.path)] ?? null;
        return {
          ...entry,
          status,
          checking,
          ownership: ownershipOfRow(status, account),
        };
      }),
    [entries, statuses, checking, account],
  );

  const visible = useMemo(
    () => sortRows(filterRows(rows, filter), sort),
    [rows, filter, sort],
  );

  const writePaths = useCallback(async (next: string[]) => {
    setPaths(next);
    await saveProjectPaths(next).catch((e) => {
      toast.error(String(e));
    });
  }, []);

  const addPaths = useCallback(
    (added: string[]) => {
      const next = mergeProjectPaths(paths ?? [], added);
      const grew = next.length !== (paths ?? []).length;
      void writePaths(next);
      return grew;
    },
    [paths, writePaths],
  );

  const handleCloned = useCallback(
    (path: string) => {
      // refresh re-runs on its own when the list changes (it depends on `entries`),
      // so no manual re-fetch is needed.
      addPaths([normalizePath(path)]);
      toast.success(t("projects.clone.done"));
    },
    [addPaths, t],
  );

  const handlePick = useCallback(async () => {
    if (scanning) return;
    let picked: string | null = null;
    try {
      picked = await pickProjectDir(t("projects.pick.title"));
    } catch (e) {
      toast.error(String(e));
      return;
    }
    // A cancelled dialog is not a failure: it just leaves the list alone.
    if (!picked) return;
    const root = normalizePath(picked);
    setScanning(true);
    try {
      await native.workspaceAuthorize(root).catch(() => null);
      // One picker covers both cases: a repository is found at the root itself, and a
      // plain directory is searched two levels down (see `projects_scan`).
      const found = await native.projectsScan(root, SCAN_DEPTH);
      if (found.length === 0) {
        toast.message(t("projects.scan.none"));
        return;
      }
      const added = found.filter((path) => !samePathAny(paths ?? [], path));
      addPaths(found);
      toast.success(
        t("projects.scan.done", {
          added: added.length,
          total: found.length,
        }),
      );
    } catch (e) {
      toast.error(String(e));
    } finally {
      setScanning(false);
    }
  }, [addPaths, paths, scanning, t]);

  /**
   * Pull one project: the explicit step the user takes after the check shows it is behind.
   *
   * Only a branch whose upstream carries the same name is pulled (see `lib/pull.ts`), and
   * the backend enforces the same rule, so a click that slips past a stale row still cannot
   * merge another branch into this one. Failures keep git's and the backend's own words; the
   * row is re-read either way, since a pull that could not fast-forward still fetched.
   */
  const handlePull = useCallback(
    async (entry: ProjectEntry) => {
      if (pulling) return;
      setPulling(normalizePath(entry.path));
      try {
        await native
          .workspaceAuthorize(entry.path, entry.workspace)
          .catch(() => null);
        const outcome = await native.projectsPull(entry.path, entry.workspace);
        toast.success(t("projects.pull.done", { branch: outcome.branch }));
      } catch (e) {
        toast.error(String(e));
      } finally {
        setPulling(null);
        await refresh().catch(() => null);
      }
    },
    [pulling, refresh, t],
  );

  const handleRemove = useCallback(async () => {
    if (!pendingRemove) return;
    const next = removeProjectPath(paths ?? [], pendingRemove.path);
    setPendingRemove(null);
    // The status of a project that is gone is not worth remembering either.
    void forgetStatuses([normalizePath(pendingRemove.path)]);
    await writePaths(next);
  }, [paths, pendingRemove, writePaths]);

  if (paths === null) {
    return (
      <div className="h-full min-h-0 px-3 py-2 text-sm text-muted-foreground">
        {active ? t("projects.loading") : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("projects.filter")}
          className="h-7 w-44 text-xs"
        />
        <span className="text-xs text-muted-foreground">
          {t("projects.count", {
            shown: visible.length,
            total: rows.length,
          })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void refresh()}
          disabled={checking}
          aria-busy={checking || undefined}
        >
          {/* A spinner beside the word, not the word swapping to `检查中…`: the label changing
              width under the cursor makes the neighbouring controls move. */}
          {checking ? <Spinner className="size-3" /> : null}
          {t("projects.refresh")}
        </Button>
        {checkedAt ? (
          <span className="text-xs text-muted-foreground">
            {t("projects.checkedAt")}
            {relativeTime(Date.now(), checkedAt, language)}
          </span>
        ) : null}
        <span className="grow" />
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => void handlePick()}
          disabled={scanning}
        >
          {scanning ? t("projects.scanning") : t("projects.pick")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => setCloneOpen(true)}
        >
          {t("projects.clone")}
        </Button>
      </div>

      {error ? (
        <p className="mt-2 text-xs whitespace-pre-wrap text-destructive">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <div className="mt-6 max-w-xl text-sm text-muted-foreground">
          <p className="text-foreground">{t("projects.empty.title")}</p>
          <p className="mt-1 text-xs">{t("projects.empty.hint")}</p>
        </div>
      ) : (
        <div className="mt-2 min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-left text-muted-foreground">
                <SortHeader
                  label={t("projects.col.project")}
                  column="name"
                  sort={sort}
                  onSort={setSort}
                  className="w-[26%]"
                />
                <SortHeader
                  label={t("projects.col.owner")}
                  column="owner"
                  sort={sort}
                  onSort={setSort}
                  className="w-[8%]"
                />
                <SortHeader
                  label={t("projects.col.branch")}
                  column="branch"
                  sort={sort}
                  onSort={setSort}
                  className="w-[14%]"
                />
                <SortHeader
                  label={t("projects.col.state")}
                  column="state"
                  sort={sort}
                  onSort={setSort}
                  className="w-[14%]"
                />
                <SortHeader
                  label={t("projects.col.dirty")}
                  column="dirty"
                  sort={sort}
                  onSort={setSort}
                  className="w-[7%] text-right"
                />
                <SortHeader
                  label={t("projects.col.upstream")}
                  column="upstream"
                  sort={sort}
                  onSort={setSort}
                  className="w-[15%]"
                />
                <SortHeader
                  label={t("projects.col.stashed")}
                  column="stashed"
                  sort={sort}
                  onSort={setSort}
                  className="w-[7%] text-right"
                />
                <th className="px-2 py-1 font-medium">
                  {t("projects.col.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <ProjectRowView
                  key={`${row.path}\u0000${row.workspace.kind === "wsl" ? row.workspace.distro : ""}`}
                  row={row}
                  onOpenWorkspace={onOpenWorkspace}
                  onOpenTerminal={onOpenTerminal}
                  onNewSession={onNewSession}
                  onRemove={
                    row.managed ? () => setPendingRemove(row) : undefined
                  }
                  onRefresh={() => {
                    const key = normalizePath(row.path);
                    setRefreshingRow(key);
                    void refresh().finally(() => {
                      // Only clear if this row is still the one in flight: a second click on
                      // another row must not be cleared by the first one finishing.
                      setRefreshingRow((current) =>
                        current === key ? null : current,
                      );
                    });
                  }}
                  onPull={() => void handlePull(row)}
                  pulling={pulling === normalizePath(row.path)}
                  refreshing={refreshingRow === normalizePath(row.path)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("projects.remove.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects.remove.body", {
                path: pendingRemove?.path ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("projects.remove.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleRemove()}>
              {t("projects.remove.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CloneRepoDialog
        open={cloneOpen}
        onOpenChange={setCloneOpen}
        onCloned={handleCloned}
      />
    </div>
  );
}

function samePathAny(paths: string[], target: string): boolean {
  return paths.some((path) => samePath(path, target));
}

function ProjectRowView({
  row,
  onOpenWorkspace,
  onOpenTerminal,
  onNewSession,
  onRemove,
  onRefresh,
  onPull,
  pulling,
  refreshing,
}: {
  row: ProjectRow;
  onOpenWorkspace: (entry: ProjectEntry) => void;
  onOpenTerminal: (entry: ProjectEntry) => void;
  onNewSession: (entry: ProjectEntry, tool: AgentTool) => void;
  onRemove?: () => void;
  onRefresh: () => void;
  onPull: () => void;
  pulling: boolean;
  refreshing: boolean;
}) {
  const t = useT();
  const state = stateOf(row.status);
  const name = row.status?.name ?? basename(row.path);
  const usable = row.status === null || row.status.kind !== "missing";
  const distro = row.workspace.kind === "wsl" ? row.workspace.distro : null;
  // The rule is the backend's too; this only decides how the button looks.
  const pullBlocked = pullBlocker(row.status);

  const copyPath = () => {
    void navigator.clipboard
      .writeText(row.path)
      .then(() => toast.success(t("projects.action.copied")))
      .catch((e) => toast.error(String(e)));
  };

  type Action = {
    key: string;
    /** Rendered label. Items carrying an agent render no text; the label only serves
     * as the accessible name and tooltip. */
    label?: string;
    /** Items carrying an agent collapse into one row of icons (see the rendering below). */
    agent?: AgentTool;
    disabled?: boolean;
    onSelect?: () => void;
    separator?: boolean;
  };
  // Dropdown and context menu share one action list so the two cannot drift apart.
  const actions: Action[] = [
    ...AGENT_TOOLS.map((tool) => ({
      key: `tool:${tool}`,
      label: t("projects.action.openWith", { tool }),
      agent: tool,
      disabled: !usable,
      onSelect: () => onNewSession(row, tool),
    })),
    { key: "sep-1", separator: true },
    {
      key: "terminal",
      label: t("projects.action.terminal"),
      disabled: !usable,
      onSelect: () => onOpenTerminal(row),
    },
    {
      key: "copy",
      label: t("projects.action.copy"),
      onSelect: copyPath,
    },
    ...(onRemove
      ? [
          { key: "sep-2", separator: true },
          {
            key: "remove",
            label: t("projects.action.remove"),
            onSelect: onRemove,
          },
        ]
      : []),
  ];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          className={cn(
            "border-b border-border/40 align-middle",
            "hover:bg-accent/40",
          )}
        >
          <td className="truncate px-2 py-1">
            <button
              type="button"
              className="block max-w-full truncate text-left"
              title={row.path}
              onClick={() => onOpenWorkspace(row)}
            >
              {name}
              {distro ? (
                <span className="ml-1 text-muted-foreground">
                  {t("projects.row.from", { distro })}
                </span>
              ) : null}
            </button>
          </td>
          <td className="truncate px-2 py-1 text-muted-foreground">
            {t(ownershipLabelKey(row.ownership))}
          </td>
          <td className="truncate px-2 py-1 text-muted-foreground">
            {row.status?.detached
              ? t("projects.detached")
              : (row.status?.branch ?? "")}
          </td>
          <td className={cn("truncate px-2 py-1", TONE_CLASS[state.tone])}>
            <span title={row.status?.error ?? undefined}>
              {t(state.key as MessageKey, state.params)}
            </span>
            {row.status?.fetchError ? (
              // A stale comparison must not look like a current one.
              <span
                className="ml-1 text-amber-500"
                title={t("projects.fetch.failed", {
                  error: row.status.fetchError,
                })}
              >
                ⚠
              </span>
            ) : null}
          </td>
          <td className="px-2 py-1 text-right text-muted-foreground">
            {row.status?.dirty ? row.status.dirty : ""}
          </td>
          <td className="truncate px-2 py-1 text-muted-foreground">
            {row.status?.upstream ?? ""}
          </td>
          <td className="px-2 py-1 text-right text-muted-foreground">
            {row.status?.stashed ? row.status.stashed : ""}
          </td>
          <td className="px-2 py-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                title={
                  refreshing
                    ? t("projects.checking")
                    : t("projects.action.refreshOne")
                }
                aria-busy={refreshing || undefined}
                disabled={refreshing}
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-progress"
                onClick={onRefresh}
              >
                {/* A spinner in place of the glyph rather than beside it: the button is one cell of
                    a table row, so anything that changes its size reflows the whole row. */}
                {refreshing ? (
                  <Spinner className="size-3" />
                ) : (
                  <span aria-hidden>⟳</span>
                )}
              </button>
              <button
                type="button"
                title={
                  pulling
                    ? t("projects.pull.running")
                    : pullBlocked
                      ? t(pullBlocked.key, pullBlocked.params)
                      : t("projects.pull.one", {
                          branch: row.status?.branch ?? "",
                        })
                }
                aria-busy={pulling || undefined}
                className={cn(
                  "inline-flex size-5 items-center justify-center rounded",
                  pullBlocked
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                disabled={pullBlocked !== null || pulling}
                onClick={onPull}
              >
                {/* The glyph is one character and the button is one cell: the running state is a
                    spinner of the same size, not the word `正在拉取…`. The word used to wrap inside
                    a `px-1` button and turn the row's action area into a column. The title and the
                    `aria-busy` flag still say what is happening. */}
                {pulling ? (
                  <Spinner className="size-3" />
                ) : (
                  <span aria-hidden>⇣</span>
                )}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    title={t("projects.action.more")}
                    className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    ⋯
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  {actions.some((action) => action.agent) ? (
                    <div className="flex items-center gap-1 px-1 py-1">
                      {actions
                        .filter((action) => action.agent)
                        .map((action) => (
                          <DropdownMenuItem
                            key={action.key}
                            disabled={action.disabled}
                            onSelect={action.onSelect}
                            title={action.label}
                            aria-label={action.label}
                            className="justify-center px-2"
                          >
                            <AgentIcon agent={action.agent ?? ""} size={14} />
                          </DropdownMenuItem>
                        ))}
                    </div>
                  ) : null}
                  {actions
                    .filter((action) => !action.agent)
                    .map((action) =>
                      action.separator ? (
                        <DropdownMenuSeparator key={action.key} />
                      ) : (
                        <DropdownMenuItem
                          key={action.key}
                          disabled={action.disabled}
                          onSelect={action.onSelect}
                        >
                          {action.label}
                        </DropdownMenuItem>
                      ),
                    )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </td>
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48">
        {actions.some((action) => action.agent) ? (
          <div className="flex items-center gap-1 px-1 py-1">
            {actions
              .filter((action) => action.agent)
              .map((action) => (
                <ContextMenuItem
                  key={action.key}
                  disabled={action.disabled}
                  onSelect={action.onSelect}
                  title={action.label}
                  aria-label={action.label}
                  className="justify-center px-2"
                >
                  <AgentIcon agent={action.agent ?? ""} size={14} />
                </ContextMenuItem>
              ))}
          </div>
        ) : null}
        {actions
          .filter((action) => !action.agent)
          .map((action) =>
            action.separator ? (
              <ContextMenuSeparator key={action.key} />
            ) : (
              <ContextMenuItem
                key={action.key}
                disabled={action.disabled}
                onSelect={action.onSelect}
              >
                {action.label}
              </ContextMenuItem>
            ),
          )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

