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
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { type MessageKey, useT } from "@/modules/i18n";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ReleaseDetail } from "./ReleaseDetail";
import { pickDownloadDir } from "./lib/pickDownloadDir";
import {
  type DownloadEntry,
  type ReleaseAssetRow,
  type ReleaseRow,
  nextDownloadProgress,
  releaseNotice,
  releaseRows,
} from "./lib/releases";

type Props = {
  /** 要看 Releases 的仓库全名；null 表示弹窗关着。 */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
};

const DOWNLOAD_EVENT = "verta://github-download";

/**
 * 某个仓库的 Release 列表 + 详情 + 附件下载。
 *
 * 正文与附件都在同一次查询里，点一行才展开详情。下载状态与进度监听都挂在这一层：
 * 从详情退回列表、甚至关掉弹窗，正在跑的下载都不会丢状态（命令在后端继续跑）。
 */
export function ReleasesDialog({ repo, onOpenChange }: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireReleasesPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文，与 gh 报错分开记。 */
  const [fatal, setFatal] = useState<string | null>(null);
  /** 展开详情的那个版本；null 表示还停在列表上。 */
  const [detail, setDetail] = useState<ReleaseRow | null>(null);
  const [downloads, setDownloads] = useState<Record<number, DownloadEntry>>({});
  /** 已经读过的仓库：关掉再打开同一个仓库不重复打网络，也不清掉下载进度。 */
  const loadedRepo = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!repo) return;
    setReading(true);
    setFatal(null);
    try {
      setPayload(await native.githubReleases(repo));
    } catch (error) {
      setPayload(null);
      setFatal(String(error));
    } finally {
      setReading(false);
    }
  }, [repo]);

  useEffect(() => {
    if (!repo || loadedRepo.current === repo) return;
    loadedRepo.current = repo;
    setPayload(null);
    setFatal(null);
    setDetail(null);
    setDownloads({});
    void load();
  }, [repo, load]);

  // 进度事件按前端生成的 id 认领；其他下载（或别的窗口）的事件一律不理。
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
        // 没有事件通道时下载照样能完成，只是进度条不动。
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
      // 用户取消了目录选择：什么都没发生，也不留一行假进度。
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
          // 重试会生成新 id：旧那次的结局不该覆盖新那次。
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

  const rows = useMemo(
    () => (payload ? releaseRows(payload, Date.now()) : []),
    [payload],
  );
  const notice = payload ? releaseNotice(payload) : null;

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
