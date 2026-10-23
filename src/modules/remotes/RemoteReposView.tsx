import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { native, type WireRemoteReposPayload, type WireRepoCiPayload } from "@/lib/native";
import { cn } from "@/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLanguage, useT, type MessageKey } from "@/modules/i18n";
import {
  loadProjectPaths,
  mergeProjectPaths,
  saveProjectPaths,
} from "@/modules/projects";
import { CloneRepoDialog } from "@/modules/projects/CloneRepoDialog";
import { AuthDialog } from "./AuthDialog";
import { RepoAdminDialog } from "./RepoAdminDialog";
import { RunListDialog } from "./RunListDialog";
import { ReleasesDialog } from "./ReleasesDialog";
import { IssuesDialog } from "./IssuesDialog";
import { TONE_CLASS, ciView, type CiView } from "./lib/ci";
import { cloneDestFromProjects } from "./lib/repoAdmin";
import { ciFromRuns } from "./lib/runs";
import { copyTextOf, filterRows, noticeOf, toRows } from "./lib/rows";
import type { RemoteRepoRow } from "./lib/types";

type Props = {
  /** Inactive tabs just sit in the background; they should not keep hitting the network. */
  active: boolean;
};

/**
 * Remote repo list (account-level repos read by the local gh). A center-area tab
 * following the same pattern as Projects: there is no local state like the
 * project list, everything comes from a single query.
 */
export function RemoteReposView({ active }: Props) {
  const t = useT();
  const language = useLanguage();

  const [payload, setPayload] = useState<WireRemoteReposPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** Raw message when the command itself failed (no `kind` at all); kept apart
   * from errors that gh reported. */
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
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
  /** Repo being cloned; `dest` is the prefilled destination directory. */
  const [cloneFor, setCloneFor] = useState<{
    row: RemoteRepoRow;
    dest: string;
  } | null>(null);
  /** Whether the account panel is open. */
  const [authOpen, setAuthOpen] = useState(false);
  const [ciBusy, setCiBusy] = useState<Record<string, boolean>>({});

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

  const read = useCallback(async () => {
    setReading(true);
    setFailure(null);
    try {
      setPayload(await native.githubRepos());
    } catch (e) {
      setFailure(String(e));
    } finally {
      setReading(false);
    }
  }, []);

  // Read once on first appearance; after that the refresh button is in charge,
  // and switching tabs does not re-hit the network.
  useEffect(() => {
    if (!active || payload !== null) return;
    void read();
  }, [active, payload, read]);

  const rows = useMemo(
    () => (payload ? toRows(payload, Date.now(), language) : []),
    [payload, language],
  );
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const notice = payload ? noticeOf(payload, visible.length, filter) : null;

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
              {payload.kind === "notLoggedIn" || payload.kind === "notInstalled" ? (
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
                <th className="w-[32%] py-1 font-medium">
                  {t("remotes.col.repo")}
                </th>
                <th className="w-[10%] py-1 font-medium">
                  {t("remotes.col.visibility")}
                </th>
                <th className="w-[12%] py-1 font-medium">
                  {t("remotes.col.language")}
                </th>
                <th className="w-[14%] py-1 font-medium">
                  {t("remotes.col.pushed")}
                </th>
                <th className="w-[10%] py-1 font-medium">
                  {t("remotes.col.ci")}
                </th>
                <th className="py-1 font-medium">
                  {t("remotes.col.description")}
                </th>
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
                  onOpenRuns={setRunsFor}
                  onOpenReleases={setReleasesFor}
                  onOpenIssues={setIssuesFor}
                  onOpenAdmin={setAdminFor}
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
  onOpenRuns,
  onOpenReleases,
  onOpenIssues,
  onOpenAdmin,
  onClone,
}: {
  row: RemoteRepoRow;
  onCopy: (value: string) => void;
  ci: WireRepoCiPayload | null;
  ciBusy: boolean;
  onCheckCi: (fullName: string, force?: boolean) => void;
  onOpenRuns: (fullName: string) => void;
  onOpenReleases: (fullName: string) => void;
  onOpenIssues: (fullName: string) => void;
  onOpenAdmin: (fullName: string) => void;
  onClone: (row: RemoteRepoRow) => void;
}) {
  const t = useT();
  const open = useCallback(() => {
    void openUrl(row.webUrl).catch(console.error);
  }, [row.webUrl]);
  const view = ciView(ci);
  // Check on hover: we never batch the whole list, only rows the user touches.
  const onHover = useCallback(() => {
    void onCheckCi(row.fullName);
  }, [onCheckCi, row.fullName]);

  return (
    <tr
      className="cursor-pointer border-t border-border/40 align-top hover:bg-accent/40"
      onClick={() => onOpenRuns(row.fullName)}
      onMouseEnter={onHover}
    >
      <td className="py-1.5 pr-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">
            {row.fullName}
          </span>
          {row.isFork ? <Flag label={t("remotes.flag.fork")} /> : null}
          {row.isArchived ? <Flag label={t("remotes.flag.archived")} /> : null}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">
        {row.isPrivate
          ? t("remotes.visibility.private")
          : t("remotes.visibility.public")}
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
      <td className="truncate py-1.5 pr-2 text-muted-foreground">
        {row.description ?? ""}
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