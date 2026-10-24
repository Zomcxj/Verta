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
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { CloneRepoDialog } from "./CloneRepoDialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLanguage, useT, type MessageKey } from "@/modules/i18n";
import {
  AGENT_TOOLS,
  AgentIcon,
  type AgentSession,
  type AgentTool,
  loadAllAgentSessions,
  relativeTime,
  topLevelSessions,
} from "@/modules/launcher";
import { native, type WireProjectTarget } from "@/lib/native";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  cycleSort,
  filterRows,
  sessionsForProject,
  sortRows,
  stateOf,
  type RowState,
  type SortKey,
  type SortState,
} from "./lib/rows";
import { loadProjectPaths, saveProjectPaths } from "./lib/store";
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
  /** Clicking a session in the hover popover: same resume path as the sessions panel
   * (cwd and session id come as a pair). */
  onOpenSession: (session: AgentSession) => void;
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
  onOpenSession,
  onOpenWorkspace,
  onOpenTerminal,
  onNewSession,
}: Props) {
  const t = useT();
  const language = useLanguage();

  const [paths, setPaths] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [scanning, setScanning] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<ProjectEntry | null>(null);
  const [cloneOpen, setCloneOpen] = useState(false);
  /** Normalized path of the project being pulled right now; null when idle. */
  const [pulling, setPulling] = useState<string | null>(null);

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

  const managed = useMemo(
    () => (paths ? entriesFromPaths(paths) : []),
    [paths],
  );

  // Subagent sessions are hidden, matching the sessions panel (the R1 rule).
  const topLevel = useMemo(() => topLevelSessions(sessions), [sessions]);

  const entries = useMemo(
    () => [...managed, ...discoveredEntries(sessions, managed)],
    [managed, sessions],
  );

  const refresh = useCallback(async () => {
    if (!active) return;
    if (entries.length === 0) {
      setStatuses({});
      setCheckedAt(Date.now());
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
      setStatuses(next);
      setCheckedAt(Date.now());
    } catch (e) {
      // A whole-batch failure (backend crash, say) is reported honestly instead of
      // pretending everything is clean.
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [active, entries]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows: ProjectRow[] = useMemo(
    () =>
      entries.map((entry) => ({
        ...entry,
        status: statuses[normalizePath(entry.path)] ?? null,
        checking,
      })),
    [entries, statuses, checking],
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
          className="h-7 text-xs"
          onClick={() => void refresh()}
          disabled={checking}
        >
          {checking ? t("projects.checking") : t("projects.refresh")}
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
                  className="w-[34%]"
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
                  sessions={sessionsForProject(topLevel, row)}
                  onOpenSession={onOpenSession}
                  onOpenWorkspace={onOpenWorkspace}
                  onOpenTerminal={onOpenTerminal}
                  onNewSession={onNewSession}
                  onRemove={
                    row.managed ? () => setPendingRemove(row) : undefined
                  }
                  onRefresh={() => void refresh()}
                  onPull={() => void handlePull(row)}
                  pulling={pulling === normalizePath(row.path)}
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

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: SortState;
  onSort: (next: SortState) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  return (
    <th className={cn("px-2 py-1 font-medium", className)}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
        onClick={() => onSort(cycleSort(sort, column))}
      >
        {label}
        {active ? <span>{sort?.ascending ? "▲" : "▼"}</span> : null}
      </button>
    </th>
  );
}

function ProjectRowView({
  row,
  sessions,
  onOpenSession,
  onOpenWorkspace,
  onOpenTerminal,
  onNewSession,
  onRemove,
  onRefresh,
  onPull,
  pulling,
}: {
  row: ProjectRow;
  sessions: AgentSession[];
  onOpenSession: (session: AgentSession) => void;
  onOpenWorkspace: (entry: ProjectEntry) => void;
  onOpenTerminal: (entry: ProjectEntry) => void;
  onNewSession: (entry: ProjectEntry, tool: AgentTool) => void;
  onRemove?: () => void;
  onRefresh: () => void;
  onPull: () => void;
  pulling: boolean;
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
            <HoverCard openDelay={250} closeDelay={120}>
              <HoverCardTrigger asChild>
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
              </HoverCardTrigger>
              <HoverCardContent
                align="start"
                className="w-80 p-2 text-xs"
                onClick={(event) => event.stopPropagation()}
              >
                <SessionHoverBody
                  row={row}
                  sessions={sessions}
                  onOpenSession={onOpenSession}
                  onNewSession={onNewSession}
                />
              </HoverCardContent>
            </HoverCard>
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
                title={t("projects.action.refreshOne")}
                className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={onRefresh}
              >
                ⟳
              </button>
              <button
                type="button"
                title={
                  pullBlocked
                    ? t(pullBlocked.key, pullBlocked.params)
                    : t("projects.pull.one", {
                        branch: row.status?.branch ?? "",
                      })
                }
                className={cn(
                  "rounded px-1",
                  pullBlocked
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                disabled={pullBlocked !== null || pulling}
                onClick={onPull}
              >
                {pulling ? t("projects.pull.running") : "⇣"}
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

function SessionHoverBody({
  row,
  sessions,
  onOpenSession,
  onNewSession,
}: {
  row: ProjectRow;
  sessions: AgentSession[];
  onOpenSession: (session: AgentSession) => void;
  onNewSession: (entry: ProjectEntry, tool: AgentTool) => void;
}) {
  const t = useT();
  const language = useLanguage();
  const usable = row.status === null || row.status.kind !== "missing";

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">{t("projects.sessions.title")}</p>
      {sessions.length === 0 ? (
        <p className="text-muted-foreground">{t("projects.sessions.empty")}</p>
      ) : (
        <div className="flex max-h-56 flex-col overflow-auto">
          {sessions.slice(0, 20).map((session) => (
            <button
              key={`${session.tool}:${session.id}`}
              type="button"
              className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left hover:bg-accent"
              onClick={() => onOpenSession(session)}
            >
              <span className="truncate">{session.title || session.id}</span>
              <span className="shrink-0 text-muted-foreground">
                {relativeTime(Date.now(), session.updatedAtMs, language)}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-1 border-t border-border/50 pt-1">
        {AGENT_TOOLS.map((tool) => (
          <button
            key={tool}
            type="button"
            disabled={!usable}
            className="block w-full rounded px-2 py-1 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={() => onNewSession(row, tool)}
          >
            {t("projects.sessions.new", { tool })}
          </button>
        ))}
        {usable ? null : (
          <p className="px-2 py-1 text-muted-foreground">
            {t("projects.sessions.unusable")}
          </p>
        )}
      </div>
    </div>
  );
}
