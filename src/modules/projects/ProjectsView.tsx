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
import { listen } from "@tauri-apps/api/event";
import { watchAdd, watchRemove } from "@/modules/explorer/lib/watch";
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
  changeTouchesRepo,
  forgetStatuses,
  readStatusSnapshot,
  rememberStatuses,
} from "./lib/statusStore";
import { pickProjectDir } from "./lib/pickDir";
import { pullBlocker } from "./lib/pull";
import { addPull, canStartPull, removePull } from "./lib/pullGate";
import type { ProjectEntry, ProjectRow, ProjectStatus } from "./lib/types";

/**
 * How often the watcher may re-read one project's status.
 *
 * An editor save fires once per write-behind flush and a `git status` walks the working tree, so a
 * burst of saves must not turn into a burst of walks.
 */
const STATUS_REREAD_MIN_INTERVAL_MS = 2000;

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
  /**
   * Normalized paths of the projects being pulled right now.
   *
   * A set rather than one path: a pull holds a row for as long as git takes, and one row at a time
   * meant a list of thirty had to be worked through in order. Two at a time, and never during a
   * check - see `pullGate`, which is also what decides whether the button is enabled, so the two
   * cannot disagree.
   */
  const [pulling, setPulling] = useState<ReadonlySet<string>>(new Set());
  /**
   * The same gate, readable from inside a callback.
   *
   * `canStartPull` has to see what is in flight now, not what it was when the row rendered: two
   * clicks in the same frame would otherwise both read the empty set and both go through.
   */
  const gateRef = useRef<{ checking: boolean; pulling: ReadonlySet<string> }>({
    checking: false,
    pulling: new Set(),
  });
  gateRef.current = { checking, pulling };
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

  /**
   * Ordering for row reads. Several can be in flight - a full check of thirty-two projects takes
   * seconds, and the pull a person just made answers one row at once - and a read is answered with
   * the repository as it was when that read ran, so the answers can arrive out of order. The read
   * that *started* last is the one that must win. Measured without this: a pull settled its row in
   * 1.0 s, and a read that had started while the pull was still fetching put the pre-pull "落后 1"
   * back on screen at 2.1 s, which reads exactly like a status that never updated.
   */
  const readSeqRef = useRef(new Map<string, number>());
  const readAnsweredRef = useRef(new Map<string, number>());
  /** Stamps a read of these projects and returns the stamp each answer has to carry to be used. */
  const beginReads = useCallback((keys: readonly string[]) => {
    const started = new Map<string, number>();
    for (const key of keys) {
      const next = (readSeqRef.current.get(key) ?? 0) + 1;
      readSeqRef.current.set(key, next);
      started.set(key, next);
    }
    return started;
  }, []);
  /** The rows of an answer that no later read has already superseded. */
  const unSuperseded = useCallback(
    (started: Map<string, number>, rows: Record<string, ProjectStatus>) => {
      const fresh: Record<string, ProjectStatus> = {};
      for (const [key, row] of Object.entries(rows)) {
        const seq = started.get(key);
        if (seq === undefined || seq < (readAnsweredRef.current.get(key) ?? 0)) {
          continue;
        }
        readAnsweredRef.current.set(key, seq);
        fresh[key] = row;
      }
      return fresh;
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!active) return;
    // Nothing to check until the list is in. This is not an answer, and it must not be the end of
    // the attempt: the effect below re-runs `refresh` once `paths` lands, and that is the only
    // thing that ever made the first check happen. Reported as rows that stayed unread - and a
    // pull that left its old "3 behind" on screen - until Refresh was pressed by hand.
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
      const started = beginReads(items.map((item) => normalizePath(item.path)));
      // Checking fetches first: only remote-tracking refs move, no working tree is
      // touched, and "behind 3" then means 3 commits behind the remote as it is now.
      // A row whose fetch failed says so instead of passing off a stale comparison.
      const rows = await native.projectsStatus(items, true);
      const next: Record<string, ProjectStatus> = {};
      for (const row of rows) next[normalizePath(row.path)] = row;
      // A check of the whole list takes long enough that a pull made while it runs answers its own
      // row first, and that answer is the newer one: the rows here that a later read already
      // answered are left as they are instead of being put back to what this check saw.
      const fresh = unSuperseded(started, next);
      // Stamp it before the state lands, so a slower file read cannot undo it.
      snapshotAt.current = Date.now();
      setStatuses((current) => ({ ...current, ...fresh }));
      setCheckedAt(snapshotAt.current);
      // Kept for the next window. A failed check writes nothing: what the file holds is the
      // last thing that was true.
      rememberStatuses({ at: snapshotAt.current, statuses: next });
    } catch (e) {
      // A whole-batch failure (backend crash, say) is reported honestly instead of
      // pretending everything is clean. What the last good check found stays on screen *and* in
      // the file: a failed read is not evidence that every project is clean, and writing the
      // empty result down made every row draw "not checked" until Refresh was pressed by hand.
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [active, beginReads, entries, paths, unSuperseded]);

  // Runs on mount, on a list change, and again when the list finally loads: `refresh` identity
  // moves with `paths`, so the check that returned early above is retried by this alone. Kept as
  // the single trigger rather than a second call site, so a list that lands twice cannot start
  // two checks.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Re-read the rows of the projects a pull just touched.
   *
   * The wrong way to settle a pull is `refresh()`: it fetches every project on the list before it
   * reads any of them, so on this machine - thirty-two projects - the row that was pulled kept
   * saying "落后 2" for eighteen seconds and then changed on its own, which reads exactly like a
   * status that never updates. The pull has already fetched, so what the row needs is a plain read
   * of that one project: no network, no other row. The per-row ⟳ asks for the same read with
   * `fetch`, because pressing it is asking whether anything new is upstream.
   *
   * Merged into the statuses already on screen, and into the file beside them, because this answer
   * covers a few projects and the rest belong to the last full check.
   */
  const readRows = useCallback(
    async (targets: readonly ProjectEntry[], fetch = false) => {
      if (!active || targets.length === 0) return;
      const items: WireProjectTarget[] = targets.map((entry) => ({
        path: entry.path,
        workspace: entry.workspace,
      }));
      const started = beginReads(items.map((item) => normalizePath(item.path)));
      try {
        const rows = await native.projectsStatus(items, fetch);
        if (rows.length === 0) return;
        const byPath: Record<string, ProjectStatus> = {};
        for (const row of rows) byPath[normalizePath(row.path)] = row;
        const fresh = unSuperseded(started, byPath);
        if (Object.keys(fresh).length === 0) return;
        setStatuses((current) => ({ ...current, ...fresh }));
        const at = Date.now();
        setCheckedAt(at);
        void readStatusSnapshot()
          .catch(() => null)
          .then((held) =>
            rememberStatuses({
              at,
              statuses: { ...(held?.statuses ?? {}), ...fresh },
            }),
          );
      } catch {
        // A re-read that fails changes nothing: the row keeps the last thing that was true, and
        // the panel's own error already covers a check that went wrong.
      }
    },
    [active, beginReads, unSuperseded],
  );

  const readRowsRef = useRef(readRows);
  readRowsRef.current = readRows;
  /**
   * The rows as they are now, for the watcher below: its subscription is set up once, and a project
   * added after that still has to be re-read when its tree changes.
   */
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  /** Whether the panel is the tab on screen, for the change subscription, which outlives it. */
  const activeRef = useRef(active);
  activeRef.current = active;
  /** When each project was last re-read, so a burst of saves cannot become a burst of walks. */
  const lastReadAtRef = useRef(new Map<string, number>());
  /** Rows whose tree changed while the panel was not the tab on screen. */
  const queuedRef = useRef(new Map<string, ProjectEntry>());
  /**
   * The watch list as one string, so the effect below does not tear down and re-register the
   * watches on every status read: only a change of roots or remotes may move them, and a string
   * compares by value.
   */
  const watchDirs = useMemo(
    () =>
      entries
        .map((entry) => normalizePath(entry.path))
        .flatMap((root) => {
          const upstream = statuses[root]?.upstream ?? "";
          const remote = upstream.slice(0, upstream.indexOf("/"));
          return [
            `${root}/.git`,
            `${root}/.git/refs/heads`,
            ...(remote ? [`${root}/.git/refs/remotes/${remote}`] : []),
          ];
        })
        .join("\n"),
    [entries, statuses],
  );

  /**
   * The directories this panel needs change events for, held as long as the tab is.
   *
   * Not only while it is the tab on screen: the terminal that pulls a repository is the tab on
   * screen at that moment, with the panel behind it, and a watch registered at the moment the panel
   * is looked at again is registered after the pull has already happened. What that costs is a
   * handle per directory for a tab that is open, which is why the tab's own lifetime is the bound.
   *
   * Measured before this existed (`projects-terminal-git-updates-row.mjs`): a pull typed in a
   * terminal left its row stale for 13.3 s, and `fs:changed` never fired for that project at all.
   * Nothing was wrong with the event - a directory registered by hand reported at once - the
   * project was simply not being watched: the file watcher only covers what the *explorer* is
   * showing, and the project panel is a different surface with no tree on screen.
   *
   * A pull's result lands inside `<root>/.git`, which the listing filter drops for the explorer, so
   * those directories are asked for explicitly - and they are watched *with their contents*, because
   * a pull past the first one moves no name at the top of `.git` at all: it rewrites `ORIG_HEAD` and
   * a ref where they are. The watcher is one directory deep, so the refs are named out: `refs/heads`
   * is where a commit or a fast-forward lands, `refs/remotes/<remote>` is where a fetch or a push
   * lands, and the remote comes from the row's upstream.
   *
   * Authorization comes first: a directory outside the authorized workspace is dropped by
   * `fs_watch_add` without an error, and on first open this effect would otherwise run before
   * `refresh` has authorized anything and register nothing, silently.
   */
  useEffect(() => {
    if (watchDirs === "") return;
    const dirs = watchDirs.split("\n");
    // Captured here and removed by the same values: the refcounts are shared with the explorer's
    // own watches, so a cleanup must release exactly what its own add took and nothing else.
    const added = entriesRef.current.map((entry) => normalizePath(entry.path));
    let cancelled = false;
    let registered = false;
    void (async () => {
      await Promise.allSettled(
        entriesRef.current.map((entry) =>
          native.workspaceAuthorize(entry.path, entry.workspace),
        ),
      );
      if (cancelled) return;
      watchAdd(added);
      watchAdd(dirs, [], { includeSkipped: true });
      registered = true;
    })();
    return () => {
      cancelled = true;
      if (!registered) return;
      watchRemove(added);
      watchRemove(dirs);
    };
  }, [watchDirs]);

  /**
   * A `git pull`, a checkout or a commit in a **terminal** moves the same row the panel shows, and
   * the panel is not the one that ran it.
   *
   * Measured on this machine before this effect existed (`projects-terminal-git-updates-row.mjs`,
   * pulling in the terminal and then only reading the table): the row settled 15.8 s after the pull.
   * The change event does arrive - the repository's own working tree is watched - but what it
   * triggered was a full check, and a full check fetches every project on the list (thirty-two
   * here) before it reads any of them.
   *
   * So the event is answered with the same narrow read the panel's own pull uses: only the rows
   * whose project contains a changed directory, and without a fetch, because whatever happened
   * already talked to the remote. A save in the editor fires per write-behind flush, so one project
   * is re-read at most once per `STATUS_REREAD_MIN_INTERVAL_MS`.
   *
   * The subscription lives as long as the tab does, not only while it is the tab on screen: the
   * terminal that pulls is the tab on screen at that moment, and the panel is behind it. A read
   * then would be a read nobody sees, and the event is not repeated later, so the touched rows are
   * remembered instead and settled the moment the panel is looked at again - which is the whole
   * complaint, "需要手动点刷新，有时切画面才刷新".
   */
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ paths: string[] }>("fs:changed", (event) => {
      if (disposed) return;
      const changed = event.payload?.paths;
      if (!Array.isArray(changed) || changed.length === 0) return;
      const at = Date.now();
      const touched = entriesRef.current.filter((entry) => {
        if (
          at - (lastReadAtRef.current.get(entry.path) ?? 0) <
          STATUS_REREAD_MIN_INTERVAL_MS
        ) {
          return false;
        }
        // The status is filed under a normalized path, which is the form this comparison works in;
        // for a WSL entry it is the path inside the distro, and the watcher reports that spelling.
        return changeTouchesRepo(changed, normalizePath(entry.path));
      });
      if (touched.length === 0) return;
      if (!activeRef.current) {
        for (const entry of touched) {
          queuedRef.current.set(normalizePath(entry.path), entry);
        }
        return;
      }
      for (const entry of touched) lastReadAtRef.current.set(entry.path, at);
      void readRowsRef.current(touched);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        console.error("[verta] projects change listen failed:", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * Settle the rows that changed while the panel was behind another tab, as soon as it is looked at.
   *
   * One narrow read, without a fetch: the change already talked to the remote, and the panel's own
   * check that runs on the way in fetches every project before it reads any of them.
   */
  useEffect(() => {
    if (!active || queuedRef.current.size === 0) return;
    const keys = new Set(queuedRef.current.keys());
    queuedRef.current.clear();
    const queued = entriesRef.current.filter((entry) =>
      keys.has(normalizePath(entry.path)),
    );
    if (queued.length === 0) return;
    const at = Date.now();
    for (const entry of queued) lastReadAtRef.current.set(entry.path, at);
    void readRowsRef.current(queued);
  }, [active]);

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
      const key = normalizePath(entry.path);
      // Read the gate from the state itself rather than from a captured value: `pulling` in this
      // closure is whatever it was when the row was rendered, and two rows clicked in one frame
      // would both see the empty set.
      if (!canStartPull(gateRef.current, key)) return;
      const started = addPull(gateRef.current, key);
      gateRef.current = started;
      setPulling(started.pulling);
      try {
        await native
          .workspaceAuthorize(entry.path, entry.workspace)
          .catch(() => null);
        const outcome = await native.projectsPull(entry.path, entry.workspace);
        toast.success(t("projects.pull.done", { branch: outcome.branch }));
      } catch (e) {
        toast.error(String(e));
      } finally {
        const ended = removePull(gateRef.current, key);
        gateRef.current = ended;
        setPulling(ended.pulling);
        // That row and no other: the pull fetched this project, so reading it is a `git status`
        // and nothing on the network. `refresh()` here was what made the row keep its old count
        // for as long as a fetch of the whole list takes.
        await readRows([entry]);
      }
    },
    [readRows, t],
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
                    // This row only. It re-checked everything before, which is why one row could
                    // not be settled without a fetch of the whole list.
                    void readRows([row], true).finally(() => {
                      // Only clear if this row is still the one in flight: a second click on
                      // another row must not be cleared by the first one finishing.
                      setRefreshingRow((current) =>
                        current === key ? null : current,
                      );
                    });
                  }}
                  onPull={() => void handlePull(row)}
                  pulling={pulling.has(normalizePath(row.path))}
                  pullEnabled={canStartPull(
                    { checking, pulling },
                    normalizePath(row.path),
                  )}
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
  pullEnabled,
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
  /** Whether a pull may start now: not while a check runs, not past the limit, not twice. */
  pullEnabled: boolean;
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
                  !pullEnabled
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                // Waiting for a check to finish and waiting for a slot are both "not now": the
                // button is the same size either way, so the row does not jump.
                disabled={pullBlocked !== null || !pullEnabled}
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

