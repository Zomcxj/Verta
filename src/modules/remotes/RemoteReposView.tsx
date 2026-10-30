import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SortHeader } from "@/components/ui/sort-header";
import { ownershipLabelKey } from "@/lib/ownership";
import { cn } from "@/lib/utils";
import {
  native,
  type WireRepoActivityPayload,
  type WireRemoteReposPayload,
  type WireRepoCiPayload,
} from "@/lib/native";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useLanguage, useT, type MessageKey } from "@/modules/i18n";
import {
  loadProjectPaths,
  mergeProjectPaths,
  saveProjectPaths,
} from "@/modules/projects";
import { CloneRepoDialog } from "@/modules/projects/CloneRepoDialog";
import { AuthDialog } from "./AuthDialog";
import { DescriptionDialog } from "./DescriptionDialog";
import { RepoAdminDialog } from "./RepoAdminDialog";
import { RunListDialog } from "./RunListDialog";
import { ReleasesDialog } from "./ReleasesDialog";
import { IssuesDialog } from "./IssuesDialog";
import { NewRepoDialog } from "./NewRepoDialog";
import { TONE_CLASS, ciView, type CiView } from "./lib/ci";
import { cloneDestFromProjects } from "./lib/repoAdmin";
import { ciFromRuns } from "./lib/runs";
import {
  readActivityCursor,
  readRepoSnapshot,
  rememberActivityCursor,
  rememberRepoSnapshot,
} from "./lib/listStore";
import {
  type ActivityCursor,
  advanceCursor,
  answerFresh,
  isNewer,
  laterOf,
  renameRepo,
} from "./lib/activity";
import {
  cloneUrlOf,
  copyTextOf,
  filterRows,
  noticeOf,
  sortRows,
  toRows,
  type RemoteSortState,
} from "./lib/rows";
import type { RemoteRepoRow } from "./lib/types";

type Props = {
  /** Inactive tabs just sit in the background; they should not keep hitting the network. */
  active: boolean;
};

/**
 * Remote repo list (account-level repos read by the local gh). A center-area tab
 * following the same pattern as Projects: there is no local state like the
 * project list, everything comes from a single query.
 *
 * The query is not what the panel waits for: it draws the list it read last (see
 * `listStore`) and reads again right away, so reopening the tab is not a blank panel while
 * gh runs. A read that comes back saying something else about the machine, or that fails
 * outright, is reported above the rows it already has rather than replacing them.
 */
export function RemoteReposView({ active }: Props) {
  const t = useT();
  const language = useLanguage();

  const [payload, setPayload] = useState<WireRemoteReposPayload | null>(null);
  /**
   * What the latest read had to say when it would not replace the rows on screen. Kept
   * apart from `payload` so the rows stay and the reason shows above them.
   */
  const [noticePayload, setNoticePayload] =
    useState<WireRemoteReposPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** Raw message when the command itself failed (no `kind` at all); kept apart
   * from errors that gh reported. */
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<RemoteSortState>(null);
  /** CI results already checked, keyed by `owner/name`; cached so they are not
   * re-checked automatically. */
  const [ci, setCi] = useState<Record<string, WireRepoCiPayload>>({});
  /** Repo whose runs are being viewed; null when the dialog is closed. */
  const [runsFor, setRunsFor] = useState<string | null>(null);
  /** Repo whose releases are being viewed; null when the dialog is closed. */
  const [releasesFor, setReleasesFor] = useState<string | null>(null);
  /** Repo whose issues / PRs are being viewed; null when the dialog is closed. */
  const [issuesFor, setIssuesFor] = useState<string | null>(null);
  /** Repo being edited; null when the dialog is closed. */
  const [adminFor, setAdminFor] = useState<string | null>(null);
  /** Row whose description is being edited; null when the dialog is closed. */
  const [descriptionFor, setDescriptionFor] = useState<RemoteRepoRow | null>(
    null,
  );
  /** Row whose switch to public is waiting for a yes; null when nothing is pending. */
  const [confirmPublic, setConfirmPublic] = useState<RemoteRepoRow | null>(null);
  /** Full name of the row whose visibility is being written right now. */
  const [visibilityBusy, setVisibilityBusy] = useState<string | null>(null);
  /** Repo being cloned; `dest` is the prefilled destination directory. */
  const [cloneFor, setCloneFor] = useState<{
    row: RemoteRepoRow;
    dest: string;
  } | null>(null);
  /** Whether the account panel is open. */
  const [authOpen, setAuthOpen] = useState(false);
  /** Whether the "new repository" dialog is open. */
  const [createOpen, setCreateOpen] = useState(false);
  const [ciBusy, setCiBusy] = useState<Record<string, boolean>>({});
  /**
   * Newest open PR / issue update per repository, already asked for, and when it was asked.
   *
   * The time is part of the answer because this one goes stale while the CI badge does not: a
   * cached "nothing new" from an hour ago would hide everything that happened since, and caching
   * without an expiry would only clear on the next restart.
   */
  const [activity, setActivity] = useState<
    Record<string, { at: number; payload: WireRepoActivityPayload }>
  >({});
  const [activityBusy, setActivityBusy] = useState<Record<string, boolean>>({});
  /** When each repository was last looked at; loaded from the previous window. */
  const [seen, setSeen] = useState<ActivityCursor>({});

  /**
   * Check CI for one repo.
   *
   * One repo at a time: querying a whole list one by one burns the API quota, so
   * we only check rows the user actually touches (hover, or a click on a badge
   * that has no result yet). `force` retries a badge that says "can't check".
   *
   * The "Check CI" entry was removed from the row menu: it means the same thing
   * as "Runs…" (the badge is the latest run) and keeping both gave two entry
   * points with two different stories. The runs panel reports the newest run back
   * and the badge follows it.
   */
  const checkCi = useCallback(
    async (fullName: string, force = false) => {
      if (!fullName) return;
      if (ciBusy[fullName]) return;
      if (!force && ci[fullName]) return;
      setCiBusy((prev) => ({ ...prev, [fullName]: true }));
      try {
        const result = await native.githubRepoCi(fullName);
        setCi((prev) => ({ ...prev, [fullName]: result }));
      } catch (e) {
        // The command itself failed (not an error reported by gh): fold it into the
        // result so the row can explain itself.
        setCi((prev) => ({
          ...prev,
          [fullName]: {
            kind: "error",
            repo: fullName,
            run: null,
            error: String(e),
          },
        }));
      } finally {
        setCiBusy((prev) => {
          const next = { ...prev };
          delete next[fullName];
          return next;
        });
      }
    },
    [ci, ciBusy],
  );

  /**
   * Ask one repository whether anything is new, and only when the row is touched.
   *
   * Same on-demand shape as the CI check, for the same reason: a list of every repository the
   * account can reach, asked all at once, is a burst of gh calls for repositories nobody is
   * looking at. Nothing is asked at startup, so no dot is drawn at startup either.
   */
  const checkActivity = useCallback(
    async (fullName: string) => {
      if (!fullName) return;
      if (activityBusy[fullName]) return;
      if (answerFresh(activity[fullName]?.at, Date.now())) return;
      setActivityBusy((prev) => ({ ...prev, [fullName]: true }));
      try {
        const result = await native.githubRepoActivity(fullName);
        setActivity((prev) => ({
          ...prev,
          [fullName]: { at: Date.now(), payload: result },
        }));
      } catch (e) {
        setActivity((prev) => ({
          ...prev,
          [fullName]: {
            at: Date.now(),
            payload: {
              kind: "error",
              repo: fullName,
              latest: null,
              error: String(e),
            },
          },
        }));
      } finally {
        setActivityBusy((prev) => {
          const next = { ...prev };
          delete next[fullName];
          return next;
        });
      }
    },
    [activity, activityBusy],
  );

  /**
   * The marks as the next write needs to see them.
   *
   * State alone is not enough here: the write has to happen where the decision was made rather than
   * inside a state updater, which React is free to call more than once.
   */
  const seenRef = useRef<ActivityCursor>({});
  /** The activity answers, for the same reason: the mark reads the newest one it knows. */
  const activityRef = useRef(activity);
  activityRef.current = activity;

  /** Keep a new set of marks: state, ref and disk in one step. */
  const commitSeen = useCallback((next: ActivityCursor) => {
    if (next === seenRef.current) return;
    seenRef.current = next;
    setSeen(next);
    rememberActivityCursor(next);
  }, []);

  /**
   * An entry was opened: this repository has been read up to now.
   *
   * "Now" rather than the item's own timestamp: being in the detail means the list as it stands
   * has been seen, and anything that arrives while the detail is open is still news afterwards.
   * Never *before* the newest update it knows about, though: the answer comes from GitHub's clock
   * and the mark from this machine's, and a machine running behind would write a mark older than
   * the item just read - leaving a dot lit on it with nothing to clear it.
   */
  const recordSeen = useCallback(
    (fullName: string) => {
      const known = activityRef.current[fullName]?.payload.latest;
      commitSeen(
        advanceCursor(
          seenRef.current,
          fullName,
          laterOf(new Date().toISOString(), known),
        ),
      );
    },
    [commitSeen],
  );

  // The marks from the window before this one. Read once: they describe when things were looked
  // at, which does not change under this window until this window looks at something.
  useEffect(() => {
    let live = true;
    void readActivityCursor().then((stored) => {
      if (!live) return;
      const merged = { ...stored, ...seenRef.current };
      seenRef.current = merged;
      setSeen(merged);
    });
    return () => {
      live = false;
    };
  }, []);

  /** The rows on screen, read inside `read` without making it depend on them. */
  const heldPayload = useRef(payload);
  heldPayload.current = payload;

  const read = useCallback(async () => {
    setReading(true);
    setFailure(null);
    try {
      const fresh = await native.githubRepos();
      const held = heldPayload.current;
      if (fresh.kind === "ready" || !held || held.kind !== "ready") {
        setPayload(fresh);
        setNoticePayload(null);
        // Kept for the next window; a list that only describes this machine is not written.
        rememberRepoSnapshot({ at: Date.now(), payload: fresh });
      } else {
        // The rows stay: what came back describes the machine, not the account, so it is
        // said above the list instead of replacing it.
        setNoticePayload(fresh);
      }
    } catch (e) {
      // The command itself failed; the rows on screen stay and the message goes above them.
      setFailure(String(e));
    } finally {
      setReading(false);
    }
  }, []);

  // An opened panel draws what it remembers and then reads once, whatever it drew. After
  // that the refresh button is in charge, and switching sub-tabs does not re-hit the
  // network. Closing the tab and opening it again is a new mount, so it reads again.
  const readOnOpen = useRef(false);
  useEffect(() => {
    if (!active || readOnOpen.current) return;
    readOnOpen.current = true;
    void read();
  }, [active, read]);

  // The file is only consulted when this window has nothing to draw: what it holds has sat
  // there since the last window closed.
  useEffect(() => {
    if (!active || heldPayload.current) return;
    let alive = true;
    void readRepoSnapshot()
      .then((snapshot) => {
        if (!alive || !snapshot || heldPayload.current) return;
        heldPayload.current = snapshot.payload;
        setPayload(snapshot.payload);
      })
      .catch(() => {
        // The read that runs anyway decides what the panel shows.
      });
    return () => {
      alive = false;
    };
  }, [active]);

  const rows = useMemo(
    () => (payload ? toRows(payload, Date.now(), language) : []),
    [payload, language],
  );
  const visible = useMemo(
    () => sortRows(filterRows(rows, filter), sort),
    [rows, filter, sort],
  );
  const noticeSource = noticePayload ?? payload;
  const notice = noticeSource
    ? noticeOf(noticeSource, visible.length, filter)
    : null;

  const copy = useCallback((value: string) => {
    // Clipboard is best-effort: stay silent when permission is missing rather
    // than reporting a failed copy as a list error.
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.message(t("remotes.action.copied")))
      .catch(() => {});
  }, [t]);

  /**
   * Clone this row: the destination defaults to "next to the existing projects,
   * plus the repo name".
   *
   * When the project list cannot be read the field stays empty for the user to
   * fill in: guessing a directory that does not exist only wastes a clone.
   */
  const startClone = useCallback(async (row: RemoteRepoRow) => {
    let dest = "";
    try {
      const paths = await loadProjectPaths();
      dest = cloneDestFromProjects(paths, row.name);
    } catch {
      // An unreadable project list does not block cloning; the user fills in the
      // destination.
    }
    setCloneFor({ row, dest });
  }, []);

  /** Merge the new directory into the project list so the Projects tab shows it. */
  const handleCloned = useCallback(
    async (path: string) => {
      try {
        const paths = await loadProjectPaths();
        await saveProjectPaths(mergeProjectPaths(paths, [path]));
      } catch (e) {
        // The clone succeeded; only the list write failed. Say so plainly, so it
        // does not look like a failed clone.
        toast.error(String(e));
        return;
      }
      toast.success(t("projects.clone.done"));
    },
    [t],
  );

  /** Patch just the affected row after a description / visibility change
   * instead of refetching everything. */
  const applyPatch = useCallback(
    (
      repo: string,
      patch: { description?: string | null; visibility?: string | null },
    ) => {
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              repos: prev.repos.map((item) =>
                item.fullName === repo
                  ? {
                      ...item,
                      description:
                        patch.description === undefined
                          ? item.description
                          : patch.description,
                      isPrivate:
                        patch.visibility === undefined
                          ? item.isPrivate
                          : patch.visibility === "PRIVATE",
                    }
                  : item,
              ),
            }
          : prev,
      );
    },
    [],
  );

  /**
   * Follow a rename in the list.
   *
   * GitHub keeps redirecting the old name, so nothing on disk breaks, but the row has to
   * show the name the repo now has: the filter matches on it and the link points at it.
   * Derived from the new slug rather than a re-read, the same way the rest of the panel
   * builds a GitHub URL.
   */
  const applyRename = useCallback(
    (repo: string, newSlug: string) => {
      // The mark belongs to the repository, not to the name it had: moved here, or the new name
      // looks like somewhere nobody has ever read.
      commitSeen(renameRepo(seenRef.current, repo, newSlug));
      const owner = newSlug.split("/")[0] ?? "";
      const name = newSlug.split("/").pop() ?? "";
      const webUrl = `https://github.com/${newSlug}`;
      setPayload((prev) =>
        prev
          ? {
              ...prev,
              repos: prev.repos.map((item) =>
                item.fullName === repo
                  ? {
                      ...item,
                      fullName: newSlug,
                      owner,
                      name,
                      webUrl,
                      cloneUrl: cloneUrlOf(webUrl),
                    }
                  : item,
              ),
            }
          : prev,
      );
    },
    [commitSeen],
  );

  /**
   * Switch one repo's visibility from the list.
   *
   * Whether the account may do this is GitHub's call rather than a guess, so the click
   * goes straight through and a refusal comes back in its own words. The list is patched
   * from the result instead of re-reading: one row changed, not the whole account.
   */
  const setVisibility = useCallback(
    async (fullName: string, isPrivate: boolean) => {
      setVisibilityBusy(fullName);
      try {
        const result = await native.githubRepoSetVisibility(fullName, isPrivate);
        if (result.kind !== "ready") {
          toast.error(result.error ?? t("remotes.ci.error"));
          return;
        }
        applyPatch(fullName, { visibility: isPrivate ? "PRIVATE" : "PUBLIC" });
        toast.success(t("remotes.admin.visibility.done"));
      } catch (e) {
        toast.error(String(e));
      } finally {
        setVisibilityBusy(null);
        // The confirm dialog, when there was one, has said its part either way.
        setConfirmPublic(null);
      }
    },
    [applyPatch, t],
  );

  /**
   * The visibility cell toggles on click. Only the switch **to public** asks first: that
   * is the direction that cannot be taken back, while going private only tightens access
   * and is undone by clicking again.
   */
  const toggleVisibility = useCallback(
    (row: RemoteRepoRow) => {
      if (row.isPrivate) {
        setConfirmPublic(row);
        return;
      }
      void setVisibility(row.fullName, true);
    },
    [setVisibility],
  );

  if (!payload) {
    if (failure) {
      return (
        <div className="h-full min-h-0 px-3 py-2">
          <p className="text-sm text-foreground">{t("remotes.error.title")}</p>
          <p className="mt-1 font-mono text-xs whitespace-pre-wrap text-destructive">
            {failure}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 text-xs"
            onClick={() => void read()}
            disabled={reading}
          >
            {t("remotes.reload")}
          </Button>
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 px-3 py-2 text-sm text-muted-foreground">
        {active ? t("remotes.loading") : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("remotes.filter")}
          className="h-7 w-44 text-xs"
        />
        <span className="text-xs text-muted-foreground">
          {t("remotes.count", { shown: visible.length, total: rows.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => void read()}
          disabled={reading}
        >
          {reading ? t("remotes.reading") : t("remotes.refresh")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          disabled={reading}
          onClick={() => setCreateOpen(true)}
        >
          {t("remotes.create.open")}
        </Button>
        <span className="grow" />
        <button
          type="button"
          title={t("remotes.auth.open")}
          className="rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setAuthOpen(true)}
        >
          {payload.login
            ? t("remotes.account", { login: payload.login })
            : t("remotes.account.unnamed")}
        </button>
      </div>

      {failure ? (
        <p className="mt-2 font-mono text-xs whitespace-pre-wrap text-destructive">
          {failure}
        </p>
      ) : null}

      {payload.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("remotes.truncated", { count: rows.length })}
        </p>
      ) : null}

      {notice ? (
        <div className="mt-6 max-w-xl text-sm text-muted-foreground">
          <p className="text-foreground">
            {t(notice.titleKey as MessageKey, notice.params)}
          </p>
          <p className="mt-1 text-xs">{t(notice.hintKey as MessageKey)}</p>
          {notice.detail ? (
            <p className="mt-2 rounded border border-border/60 bg-card px-2 py-1 font-mono text-xs whitespace-pre-wrap">
              {notice.detail}
            </p>
          ) : null}
          {notice.tone === "empty" ? null : (
            <div className="mt-2 flex flex-wrap gap-2">
              {/* When gh is missing or logged out, the account panel is the most
                  direct next step. */}
              {noticeSource?.kind === "notLoggedIn" ||
              noticeSource?.kind === "notInstalled" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setAuthOpen(true)}
                >
                  {t("remotes.auth.open")}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void read()}
                disabled={reading}
              >
                {t("remotes.reload")}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-left text-muted-foreground">
                <SortHeader
                  label={t("remotes.col.repo")}
                  column="repo"
                  sort={sort}
                  onSort={setSort}
                  className="w-[28%] px-0"
                />
                <SortHeader
                  label={t("remotes.col.owner")}
                  column="owner"
                  sort={sort}
                  onSort={setSort}
                  className="w-[8%] px-0"
                />
                <SortHeader
                  label={t("remotes.col.visibility")}
                  column="visibility"
                  sort={sort}
                  onSort={setSort}
                  className="w-[10%] px-0"
                />
                <SortHeader
                  label={t("remotes.col.language")}
                  column="language"
                  sort={sort}
                  onSort={setSort}
                  className="w-[12%] px-0"
                />
                <SortHeader
                  label={t("remotes.col.pushed")}
                  column="pushed"
                  sort={sort}
                  onSort={setSort}
                  className="w-[14%] px-0"
                />
                <th className="w-[10%] py-1 font-medium">
                  {t("remotes.col.ci")}
                </th>
                <SortHeader
                  label={t("remotes.col.description")}
                  column="description"
                  sort={sort}
                  onSort={setSort}
                  className="px-0"
                />
                <th className="w-[4%] py-1" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <RepoRow
                  key={row.fullName}
                  row={row}
                  onCopy={copy}
                  ci={ci[row.fullName] ?? null}
                  ciBusy={Boolean(ciBusy[row.fullName])}
                  onCheckCi={checkCi}
                  hasNew={isNewer(
                    activity[row.fullName]?.payload.latest,
                    seen[row.fullName],
                  )}
                  onCheckActivity={checkActivity}
                  onOpenRuns={setRunsFor}
                  onOpenReleases={setReleasesFor}
                  onOpenIssues={setIssuesFor}
                  onOpenAdmin={setAdminFor}
                  onEditDescription={setDescriptionFor}
                  onToggleVisibility={toggleVisibility}
                  visibilityBusy={visibilityBusy === row.fullName}
                  onClone={(target) => void startClone(target)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RunListDialog
        repo={runsFor}
        onOpenChange={(open) => {
          if (!open) setRunsFor(null);
        }}
        onLoaded={(payload) => {
          // The badge and the panel tell the same story: once the panel has loaded,
          // update the row badge from its newest run.
          setCi((prev) => ({ ...prev, [payload.repo]: ciFromRuns(payload) }));
        }}
      />
      <ReleasesDialog
        repo={releasesFor}
        onOpenChange={(open) => {
          if (!open) setReleasesFor(null);
        }}
      />
      <IssuesDialog
        repo={issuesFor}
        onOpenChange={(open) => {
          if (!open) setIssuesFor(null);
        }}
        onDetailOpened={recordSeen}
      />
      <RepoAdminDialog
        repo={adminFor}
        onOpenChange={(open) => {
          if (!open) setAdminFor(null);
        }}
        onChanged={applyPatch}
        onDeleted={(repo) => {
          // Drop it from the list right away; a refresh would not bring it back
          // either.
          setPayload((prev) =>
            prev
              ? {
                  ...prev,
                  repos: prev.repos.filter((item) => item.fullName !== repo),
                }
              : prev,
          );
          setAdminFor(null);
        }}
        onRenamed={(repo, newSlug) => {
          applyRename(repo, newSlug);
          // Keep the dialog on this repo: it reads settings keyed by the slug, and the
          // old name is now only a redirect.
          setAdminFor(newSlug);
        }}
      />
      <CloneRepoDialog
        open={cloneFor !== null}
        defaultUrl={
          cloneFor ? `https://github.com/${cloneFor.row.fullName}.git` : undefined
        }
        defaultDest={cloneFor?.dest}
        onOpenChange={(open) => {
          if (!open) setCloneFor(null);
        }}
        onCloned={(path) => void handleCloned(path)}
      />
      <NewRepoDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          // The list is the only thing that knows the account's repositories, so read it
          // again; an active filter would hide the new row, so clear that too.
          setFilter("");
          void read();
        }}
      />
      <DescriptionDialog
        repo={descriptionFor?.fullName ?? null}
        current={descriptionFor?.description ?? null}
        onOpenChange={(open) => {
          if (!open) setDescriptionFor(null);
        }}
        onSaved={(repo, description) => applyPatch(repo, { description })}
      />
      <AlertDialog
        open={confirmPublic !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmPublic(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("remotes.admin.visibility.toPublic.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block font-mono text-xs text-foreground">
                {confirmPublic?.fullName ?? ""}
              </span>
              {t("remotes.admin.visibility.toPublic.hint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="ghost"
              disabled={visibilityBusy !== null}
              onClick={() => setConfirmPublic(null)}
            >
              {t("scm.common.cancel")}
            </Button>
            <Button
              disabled={visibilityBusy !== null}
              onClick={() => {
                if (confirmPublic) {
                  void setVisibility(confirmPublic.fullName, false);
                }
              }}
            >
              {visibilityBusy !== null
                ? t("remotes.runs.working")
                : t("remotes.admin.visibility.toPublic")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AuthDialog
        open={authOpen}
        onOpenChange={(next) => {
          setAuthOpen(next);
          // Re-read the list on close: the account panel may have logged in or out,
          // and both the header and the list have to follow.
          if (!next) void read();
        }}
      />
    </div>
  );
}

function RepoRow({
  row,
  onCopy,
  ci,
  ciBusy,
  onCheckCi,
  hasNew,
  onCheckActivity,
  onOpenRuns,
  onOpenReleases,
  onOpenIssues,
  onOpenAdmin,
  onEditDescription,
  onToggleVisibility,
  visibilityBusy,
  onClone,
}: {
  row: RemoteRepoRow;
  onCopy: (value: string) => void;
  ci: WireRepoCiPayload | null;
  ciBusy: boolean;
  onCheckCi: (fullName: string, force?: boolean) => void;
  /** Whether anything here is newer than the last time this repository was read. */
  hasNew: boolean;
  onCheckActivity: (fullName: string, force?: boolean) => void;
  onOpenRuns: (fullName: string) => void;
  onOpenReleases: (fullName: string) => void;
  onOpenIssues: (fullName: string) => void;
  onOpenAdmin: (fullName: string) => void;
  onEditDescription: (row: RemoteRepoRow) => void;
  onToggleVisibility: (row: RemoteRepoRow) => void;
  visibilityBusy: boolean;
  onClone: (row: RemoteRepoRow) => void;
}) {
  const t = useT();
  const open = useCallback(() => {
    void openUrl(row.webUrl).catch(console.error);
  }, [row.webUrl]);
  const view = ciView(ci);
  // Check on hover: we never batch the whole list, only rows the user touches. Two questions share
  // this one trigger - the latest run, and whether anything is new - because they are both "tell me
  // what is going on with this row" and a second hover listener would only fire twice.
  const onHover = useCallback(() => {
    void onCheckCi(row.fullName);
    void onCheckActivity(row.fullName);
  }, [onCheckCi, onCheckActivity, row.fullName]);

  return (
    <tr
      // One door, and it is the column that shows the result: the CI button opens the runs panel. A
      // row-wide click made every column a door, so a click that missed the visibility toggle or the
      // description's edit box opened a panel over them instead.
      className="border-t border-border/40 align-top hover:bg-accent/40"
      onMouseEnter={onHover}
    >
      <td className="py-1.5 pr-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">
            {row.fullName}
          </span>
          {row.isFork ? <Flag label={t("remotes.flag.fork")} /> : null}
          {row.isArchived ? <Flag label={t("remotes.flag.archived")} /> : null}
          {/* Beside the name rather than in a column of its own: it belongs to this repository,
              not to a field, and the name is what it is read next to. `shrink-0` because the name
              is `truncate`d and would otherwise squeeze a 6px dot to nothing. */}
          {hasNew ? (
            <span
              data-repo-activity="new"
              role="img"
              aria-label={t("remotes.activity.new")}
              title={t("remotes.activity.new")}
              className="mb-px size-1.5 shrink-0 self-center rounded-full bg-amber-500"
            />
          ) : null}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">
        {t(ownershipLabelKey(row.ownership))}
      </td>
      <td className="py-1.5 pr-2">
        <button
          type="button"
          title={t("remotes.visibility.toggle")}
          className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          disabled={visibilityBusy}
          onClick={(event) => {
            event.stopPropagation();
            onToggleVisibility(row);
          }}
        >
          {row.isPrivate
            ? t("remotes.visibility.private")
            : t("remotes.visibility.public")}
        </button>
      </td>
      <td className="truncate py-1.5 pr-2 text-muted-foreground">
        {row.language ?? t("remotes.unknown")}
      </td>
      <td className="truncate py-1.5 pr-2 text-muted-foreground">
        {row.pushed ?? t("remotes.unknown")}
      </td>
      <td className="truncate py-1.5 pr-2">
        <CiCell
          view={view}
          busy={ciBusy}
          checkLabel={t("remotes.ci.check")}
          onCheck={() => onCheckCi(row.fullName, true)}
          onOpenDetail={() => onOpenRuns(row.fullName)}
        />
      </td>
      <td className="truncate py-1.5 pr-2">
        <button
          type="button"
          title={
            row.description
              ? t("remotes.description.edit")
              : t("remotes.description.add")
          }
          className="block max-w-full truncate rounded px-1 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            onEditDescription(row);
          }}
        >
          {row.description ?? "+"}
        </button>
      </td>
      <td className="py-1.5 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={t("remotes.action.more")}
              className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              ⋯
            </button>
          </DropdownMenuTrigger>
          {/* Radix portals the menu content to body, but React events still bubble
              up the component tree to the row; without stopping them, clicking
              "Repo settings…" also opens the runs dialog on top of it. */}
          <DropdownMenuContent
            align="end"
            className="min-w-48"
            onClick={(event) => event.stopPropagation()}
          >
            <DropdownMenuItem onSelect={open}>
              {t("remotes.action.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onOpenRuns(row.fullName)}>
              {t("remotes.runs.open")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenReleases(row.fullName)}>
              {t("remotes.releases.open")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenIssues(row.fullName)}>
              {t("remotes.issues.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onClone(row)}>
              {t("remotes.admin.clone")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenAdmin(row.fullName)}>
              {t("remotes.admin.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onCopy(copyTextOf(row, "name"))}>
              {t("remotes.action.copyName")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopy(copyTextOf(row, "clone"))}>
              {t("remotes.action.copyClone")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

/**
 * CI badge for one row.
 *
 * With a result it opens that run; without one (or while checking) it is a
 * "Check CI" button that runs the query now. Either way the click must not
 * bubble to the row, which would open the browser to the repo home page.
 */
function CiCell({
  view,
  busy,
  checkLabel,
  onCheck,
  onOpenDetail,
}: {
  view: CiView;
  busy: boolean;
  checkLabel: string;
  onCheck: () => void;
  /** With a result, clicking shows the run in-app rather than opening a browser. */
  onOpenDetail: () => void;
}) {
  const t = useT();
  const label = busy ? t("remotes.ci.checking") : t(view.key);
  const className = cn(
    "rounded border px-1 text-[10px] leading-4",
    TONE_CLASS[view.tone],
  );

  return (
    <button
      type="button"
      title={view.detail ?? checkLabel}
      disabled={busy}
      className={cn(className, "hover:bg-accent disabled:opacity-60")}
      // Clicks must not bubble to the row (a row click opens the runs panel).
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (view.url) onOpenDetail();
        else onCheck();
      }}
    >
      {label}
    </button>
  );
}

function Flag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground">
      {label}
    </span>
  );
}