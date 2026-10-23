import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { lazy, Suspense } from "react";
import {
  type DownloadEntry,
  type ReleaseAssetRow,
  type ReleaseRow,
  formatSpeed,
  humanSize,
  percentOf,
} from "./lib/releases";

/**
 * The Markdown renderer (including Streamdown) loads on demand: the Releases dialog
 * stays mounted with its tab, and a static import would drag the whole layout engine
 * into the startup graph, which the bundle-budget test would catch immediately.
 */
const Markdown = lazy(() =>
  import("@/modules/markdown/MarkdownRender").then((module) => ({
    default: module.MarkdownRender,
  })),
);

type Props = {
  release: ReleaseRow;
  downloads: Record<number, DownloadEntry>;
  onBack: () => void;
  onDownload: (asset: ReleaseAssetRow) => void;
  onCancel: (assetId: number) => void;
};

/** Detail of one release: the body plus asset rows (download / progress / cancel / show
 * in folder). */
export function ReleaseDetail({
  release,
  downloads,
  onBack,
  onDownload,
  onCancel,
}: Props) {
  const t = useT();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={onBack}
        >
          ← {t("remotes.releases.back")}
        </Button>
        <span className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-nowrap text-muted-foreground">
          {release.tagName}
        </span>
        <span className="min-w-0 truncate text-sm">{release.name}</span>
        {release.draft ? <Flag label={t("remotes.releases.flag.draft")} /> : null}
        {release.prerelease ? (
          <Flag label={t("remotes.releases.flag.prerelease")} />
        ) : null}
        {release.when ? (
          <span className="text-[11px] text-muted-foreground">{release.when}</span>
        ) : null}
        <span className="grow" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px] text-muted-foreground"
          onClick={() => void openUrl(release.htmlUrl).catch(console.error)}
        >
          {t("remotes.releases.inGithub")}
        </Button>
      </div>

      <div className="max-h-[42vh] overflow-auto rounded border border-border/40 px-3 py-2">
        {release.body.trim() ? (
          <Suspense
            fallback={
              <p className="text-xs text-muted-foreground">
                {t("remotes.releases.loading")}
              </p>
            }
          >
            <Markdown content={release.body} path="" />
          </Suspense>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("remotes.releases.bodyEmpty")}
          </p>
        )}
      </div>

      <div>
        <div className="mb-1 text-xs font-medium">
          {t("remotes.releases.assets", { count: release.assets.length })}
        </div>
        {release.assets.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("remotes.releases.noAssets")}
          </p>
        ) : (
          <ul className="space-y-1">
            {release.assets.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                entry={downloads[asset.id]}
                onDownload={onDownload}
                onCancel={onCancel}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Flag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground">
      {label}
    </span>
  );
}

function AssetRow({
  asset,
  entry,
  onDownload,
  onCancel,
}: {
  asset: ReleaseAssetRow;
  entry: DownloadEntry | undefined;
  onDownload: (asset: ReleaseAssetRow) => void;
  onCancel: (assetId: number) => void;
}) {
  const t = useT();
  const running = entry?.status === "running";
  const percent = entry
    ? percentOf(entry.progress.written, entry.progress.total)
    : null;
  const speed = entry ? formatSpeed(entry.progress.speed) : null;

  return (
    <li className="rounded border border-border/40 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs" title={asset.name}>
          {asset.name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {asset.sizeLabel}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {t("remotes.releases.asset.downloads", {
            count: asset.downloadCount,
          })}
        </span>

        {running ? (
          <>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {humanSize(entry.progress.written)}
              {entry.progress.total > 0
                ? ` / ${humanSize(entry.progress.total)}`
                : ""}
            </span>
            {speed ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {speed}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px] text-destructive"
              disabled={entry.cancelling}
              onClick={() => onCancel(asset.id)}
            >
              {entry.cancelling
                ? t("remotes.releases.download.cancelling")
                : t("remotes.releases.download.cancel")}
            </Button>
          </>
        ) : entry?.status === "ok" ? (
          <>
            <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-500">
              {t("remotes.releases.download.done")}
            </span>
            {entry.path ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-1.5 text-[11px]"
                onClick={() => {
                  void revealItemInDir(entry.path ?? "").catch(console.error);
                }}
              >
                {t("remotes.releases.download.openFolder")}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {entry?.status === "error" ? (
              <span
                className="max-w-64 shrink-0 truncate text-[11px] text-destructive"
                title={entry.error ?? ""}
              >
                {entry.error}
              </span>
            ) : null}
            {entry?.status === "cancelled" ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {t("remotes.releases.download.cancelled")}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[11px]"
              onClick={() => onDownload(asset)}
            >
              {entry
                ? t("remotes.releases.download.retry")
                : t("remotes.releases.asset.download")}
            </Button>
          </>
        )}
      </div>

      {running ? (
        <div
          className={cn(
            "mt-1 h-1 overflow-hidden rounded bg-muted",
            percent === null && "opacity-60",
          )}
        >
          <div
            className="h-full bg-primary transition-[width] duration-150"
            style={{ width: `${percent ?? 0}%` }}
          />
        </div>
      ) : null}
    </li>
  );
}
