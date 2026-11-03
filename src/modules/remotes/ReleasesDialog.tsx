import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  native,
  type WireReleaseDownloadProgress,
  type WireReleasesPayload,
  type WireRepoPermissionPayload,
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { type MessageKey, useLanguage, useT } from "@/modules/i18n";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ReleaseDetail } from "./ReleaseDetail";
import {
  PERMISSION_SNAPSHOT_TTL_MS,
  readListSnapshot,
  writeListSnapshot,
} from "./lib/listSnapshot";
import { pickDownloadDir } from "./lib/pickDownloadDir";
import { canWrite } from "./lib/permission";
import {
  beginScope,
  isCurrentTicket,
  newReadTickets,
  takeTicket,
} from "./lib/readTicket";
import {
  type DownloadEntry,
  type ReleaseAssetRow,
  type ReleaseRow,
  nextDownloadProgress,
  releaseNotice,
  releaseRows,
} from "./lib/releases";

type Props = {
  /** Full name of the repo whose releases are shown; null when the dialog is closed. */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
};

const DOWNLOAD_EVENT = "verta://github-download";

/**
 * Release list + detail + asset downloads for one repo.
 *
 * Bodies and assets come in the same query, and clicking a row expands the detail.
 * Download state and the progress listener live at this level: going back from the
 * detail, or even closing the dialog, never loses the state of a running download
 * (the command keeps running in the backend).
 */
export function ReleasesDialog({ repo, onOpenChange }: Props) {
  const t = useT();
  const language = useLanguage();
  const [payload, setPayload] = useState<WireReleasesPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** Raw message when the command itself failed (no `kind` at all); kept apart from
   * errors gh reported. */
  const [fatal, setFatal] = useState<string | null>(null);
  /** Release opened in detail view; null while still on the list. */
  const [detail, setDetail] = useState<ReleaseRow | null>(null);
  const [downloads, setDownloads] = useState<Record<number, DownloadEntry>>({});
  /** Permission on this repo: only affects whether the edit button shows; reads still
   * work. */
  const [permission, setPermission] =
    useState<WireRepoPermissionPayload | null>(null);
  /** Repo already read: reopening the same one neither hits the network again nor
   * clears download progress. */
  const loadedRepo = useRef<string | null>(null);
  /**
   * Which repository each read is answering for, and which read of each kind is newest.
   *
   * One instance is reused across repositories (`RemoteReposView` swaps the `repo` prop), and the
   * list read had no guard at all: B's screen drew A's releases whenever A answered last. The row
   * is not only a display - opening one and saving edits writes to the release under the current
   * repository, so the read has to be refused before anything is drawn from it.
   */
  const tickets = useRef(newReadTickets()).current;

  const editable = canWrite(permission);

  useEffect(() => {
    if (!repo) {
      setPermission(null);
      return;
    }
    const key = `permission:${repo}`;
    const cached = readListSnapshot<WireRepoPermissionPayload>(
      key,
      PERMISSION_SNAPSHOT_TTL_MS,
    );
    if (cached) {
      setPermission(cached);
      return;
    }
    setPermission(null);
    let alive = true;
    native
      .githubRepoPermission(repo)
      .then((result) => {
        writeListSnapshot(key, result);
        if (alive) setPermission(result);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo]);

  const load = useCallback(async () => {
    if (!repo) return;
    const ticket = takeTicket(tickets, "list");
    setReading(true);
    setFatal(null);
    try {
      const payload = await native.githubReleases(repo);
      if (!isCurrentTicket(tickets, "list", ticket)) return;
      writeListSnapshot(`releases:${repo}`, payload);
      setPayload(payload);
    } catch (error) {
      if (!isCurrentTicket(tickets, "list", ticket)) return;
      setPayload(null);
      setFatal(String(error));
    } finally {
      if (isCurrentTicket(tickets, "list", ticket)) setReading(false);
    }
  }, [repo, tickets]);

  const rows = useMemo(
    () => (payload ? releaseRows(payload, Date.now(), language) : []),
    [payload, language],
  );
  const notice = payload ? releaseNotice(payload) : null;

  const saveRelease = useCallback(
    async (name: string, body: string): Promise<string | null> => {
      if (!repo || !detail) return null;
      // The write names the release by the id on screen, under the repository the panel is on; an
      // id that is not one of this repository's rows belongs to another repository's release.
      if (!rows.some((row) => row.id === detail.id)) return null;
      try {
        // The form field is a title: leading and trailing space is a typo, and GitHub
        // would store it verbatim.
        const result = await native.githubReleaseEdit(
          repo,
          detail.id,
          name.trim(),
          body,
        );
        if (result.kind !== "ready") {
          return result.error ?? t("remotes.ci.error");
        }
        toast.success(t("remotes.releases.edit.saved"));
        await load();
        return null;
      } catch (error) {
        return String(error);
      }
    },
    [repo, detail, load, rows, t],
  );

  useEffect(() => {
    if (!repo || loadedRepo.current === repo) return;
    // Everything in flight belongs to the repository being left, and so does the detail on screen.
    beginScope(tickets);
    loadedRepo.current = repo;
    setFatal(null);
    setDetail(null);
    setDownloads({});
    // A read from a few moments ago is as good as asking again, and this dialog
    // is closed and reopened constantly while browsing repos.
    const cached = readListSnapshot<WireReleasesPayload>(`releases:${repo}`);
    if (cached) {
      // Answering from the cache replaces the read it answered, so a request still in flight for
      // this repository cannot land on top of it.
      takeTicket(tickets, "list");
      setReading(false);
      setPayload(cached);
      return;
    }
    setPayload(null);
    void load();
  }, [repo, load, tickets]);

  // Progress events are claimed by the frontend-generated id; events from other
  // downloads (or other windows) are ignored.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void listen<WireReleaseDownloadProgress>(DOWNLOAD_EVENT, (event) => {
      const progress = event.payload;
      setDownloads((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const [key, entry] of Object.entries(previous)) {
          if (entry.id !== progress.id || entry.status !== "running") continue;
          next[Number(key)] = {
            ...entry,
            progress: nextDownloadProgress(
              entry.progress,
              progress.written,
              progress.total,
              Date.now(),
            ),
          };
          changed = true;
        }
        return changed ? next : previous;
      });
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Without an event channel the download still completes; only the progress
        // bar stays still.
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const startDownload = useCallback(
    async (asset: ReleaseAssetRow) => {
      if (!repo) return;
      if (downloads[asset.id]?.status === "running") return;

      let dir: string | null = null;
      try {
        dir = await pickDownloadDir(t("remotes.releases.pick.dir"));
      } catch (error) {
        toast.error(String(error));
        return;
      }
      // The user cancelled the directory picker: nothing happened, and no fake
      // progress row is left behind.
      if (!dir) return;

      const id = crypto.randomUUID();
      const startedAt = Date.now();
      setDownloads((previous) => ({
        ...previous,
        [asset.id]: {
          id,
          status: "running",
          progress: {
            written: 0,
            total: asset.size,
            speed: 0,
            sampledAt: startedAt,
            sampledWritten: 0,
          },
          path: null,
          error: null,
          cancelling: false,
        },
      }));

      try {
        const result = await native.githubReleaseDownload({
          id,
          repo,
          assetId: asset.id,
          name: asset.name,
          dir,
          total: asset.size,
        });
        setDownloads((previous) => {
          const entry = previous[asset.id];
          // A retry generates a new id, so the old attempt's outcome must not
          // overwrite the new one.
          if (!entry || entry.id !== id) return previous;
          if (result.kind === "ok") {
            return {
              ...previous,
              [asset.id]: {
                ...entry,
                status: "ok",
                path: result.path,
                progress: {
                  ...entry.progress,
                  written: asset.size > 0 ? asset.size : entry.progress.written,
                },
              },
            };
          }
          if (result.kind === "cancelled") {
            return {
              ...previous,
              [asset.id]: { ...entry, status: "cancelled", cancelling: false },
            };
          }
          return {
            ...previous,
            [asset.id]: {
              ...entry,
              status: "error",
              error: result.error ?? t("remotes.ci.error"),
              cancelling: false,
            },
          };
        });
      } catch (error) {
        setDownloads((previous) => {
          const entry = previous[asset.id];
          if (!entry || entry.id !== id) return previous;
          return {
            ...previous,
            [asset.id]: {
              ...entry,
              status: "error",
              error: String(error),
              cancelling: false,
            },
          };
        });
      }
    },
    [downloads, repo, t],
  );

  const cancelDownload = useCallback(
    (assetId: number) => {
      const entry = downloads[assetId];
      if (entry?.status !== "running" || entry.cancelling) return;
      setDownloads((previous) => ({
        ...previous,
        [assetId]: { ...previous[assetId], cancelling: true },
      }));
      void native.githubReleaseDownloadCancel(entry.id);
    },
    [downloads],
  );

  // After a reload the open detail must show the fresh text rather than the copy taken
  // when it was opened. The row is looked up again by id.
  useEffect(() => {
    if (!detail) return;
    const fresh = rows.find((row) => row.id === detail.id);
    if (fresh && fresh !== detail) setDetail(fresh);
  }, [rows, detail]);

  return (
    <Dialog
      open={repo !== null}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <DialogContent className={detail ? "sm:max-w-3xl" : "sm:max-w-2xl"}>
        {detail ? (
          <ReleaseDetail
            release={detail}
            downloads={downloads}
            editable={editable}
            onSave={saveRelease}
            onBack={() => setDetail(null)}
            onDownload={(asset) => void startDownload(asset)}
            onCancel={cancelDownload}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {t("remotes.releases.title", { repo: repo ?? "" })}
              </DialogTitle>
              <DialogDescription>
                {t("remotes.releases.hint")}
              </DialogDescription>
            </DialogHeader>

            {fatal ? (
              <div className="space-y-2">
                <p className="whitespace-pre-wrap text-xs text-destructive">
                  {fatal}
                </p>
                <Button variant="ghost" size="sm" onClick={() => void load()}>
                  {t("remotes.releases.retry")}
                </Button>
              </div>
            ) : reading && !payload ? (
              <p className="text-xs text-muted-foreground">
                {t("remotes.releases.loading")}
              </p>
            ) : notice ? (
              <div className="mt-4 max-w-xl text-sm text-muted-foreground">
                <p className="text-foreground">
                  {t(notice.titleKey as MessageKey)}
                </p>
                <p className="mt-1 text-xs">
                  {t(notice.hintKey as MessageKey)}
                </p>
                {notice.detail ? (
                  <p className="mt-2 rounded border border-border/60 bg-card px-2 py-1 font-mono text-xs whitespace-pre-wrap">
                    {notice.detail}
                  </p>
                ) : null}
                {notice.tone === "empty" ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-7 text-xs"
                    onClick={() => void load()}
                    disabled={reading}
                  >
                    {t("remotes.releases.retry")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-auto">
                <ul className="space-y-1">
                  {rows.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        className="w-full rounded border border-border/40 px-2 py-1.5 text-left hover:bg-accent/40"
                        onClick={() => setDetail(row)}
                      >
                        <span className="flex flex-wrap items-baseline gap-2">
                          <span className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-nowrap text-muted-foreground">
                            {row.tagName}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 truncate text-xs",
                              row.draft && "text-muted-foreground",
                            )}
                          >
                            {row.name}
                          </span>
                          {row.draft ? (
                            <Badge label={t("remotes.releases.flag.draft")} />
                          ) : null}
                          {row.prerelease ? (
                            <Badge
                              label={t("remotes.releases.flag.prerelease")}
                            />
                          ) : null}
                          <span className="grow" />
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {t("remotes.releases.assets", {
                              count: row.assets.length,
                            })}
                          </span>
                          {row.when ? (
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {row.when}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground">
      {label}
    </span>
  );
}
