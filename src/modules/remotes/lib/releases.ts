import type { WireReleasesPayload } from "@/lib/native";
import type { Language } from "@/modules/i18n/language";
import { relativeTime } from "@/modules/launcher";

/** A release as shown in the UI: the wire fields plus display-ready time and size labels. */
export type ReleaseRow = {
  id: number;
  tagName: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** Relative time; null when neither date can be parsed. */
  when: string | null;
  htmlUrl: string;
  assets: ReleaseAssetRow[];
};

export type ReleaseAssetRow = {
  id: number;
  name: string;
  size: number;
  /** Display label such as `1.5 MB`. */
  sizeLabel: string;
  downloadCount: number;
  contentType: string | null;
  updatedAt: string | null;
};

/**
 * What to say when the list is empty or unreadable; null when there is content to
 * render. The copy is an i18n key, and the tone picks the styling of the notice
 * block.
 */
export type ReleaseNotice = {
  tone: "empty" | "warn" | "error";
  titleKey: string;
  hintKey: string;
  detail: string | null;
};

/** Progress of one download; the speed is smoothed so the number does not jump around. */
export type DownloadProgress = {
  written: number;
  total: number;
  /** Bytes per second; 0 at the first sample. */
  speed: number;
  sampledAt: number;
  sampledWritten: number;
};

export type DownloadStatus = "running" | "ok" | "error" | "cancelled";

/** Current download state of one asset, keyed by asset id. */
export type DownloadEntry = {
  /** Frontend-generated id; progress events are matched against it. */
  id: string;
  status: DownloadStatus;
  progress: DownloadProgress;
  /** Final path on success. */
  path: string | null;
  error: string | null;
  cancelling: boolean;
};

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Binary units with one decimal; below 1 KiB it reports bytes. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

/** Downloaded percentage of the total; null when the total is unknown (the UI then
 * goes indeterminate). */
export function percentOf(written: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(written)) return 0;
  return Math.min(100, Math.max(0, (written / total) * 100));
}

/** Speed label; nothing until it can be measured (no fake 0 KB/s). */
export function formatSpeed(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${humanSize(bytesPerSecond)}/s`;
}

/** Sampling interval: more frequent progress only updates the byte counts and
 * leaves the speed alone. */
const SAMPLE_MS = 250;
const SMOOTHING = 0.3;

/**
 * Fold one progress event into the state.
 *
 * Speed is exponentially smoothed: a single IPC hiccup should not drop it from
 * 12 MB/s to 3 MB/s. When the interval is too short, the previous value is kept
 * but bytes and total still update: the progress bar must not stall.
 */
export function nextDownloadProgress(
  previous: DownloadProgress | undefined,
  written: number,
  total: number,
  nowMs: number,
): DownloadProgress {
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  if (!previous) {
    return {
      written,
      total: safeTotal,
      speed: 0,
      sampledAt: nowMs,
      sampledWritten: written,
    };
  }
  const elapsed = nowMs - previous.sampledAt;
  if (elapsed < SAMPLE_MS) {
    return { ...previous, written, total: safeTotal };
  }
  const instant = Math.max(
    0,
    ((written - previous.sampledWritten) * 1000) / elapsed,
  );
  const speed =
    previous.speed > 0
      ? previous.speed * (1 - SMOOTHING) + instant * SMOOTHING
      : instant;
  return {
    written,
    total: safeTotal,
    speed,
    sampledAt: nowMs,
    sampledWritten: written,
  };
}

/** Wire data → UI rows. */
export function releaseRows(
  payload: WireReleasesPayload,
  nowMs: number,
  language: Language,
): ReleaseRow[] {
  return payload.releases.map((release) => {
    const stamp = release.publishedAt ?? release.createdAt;
    const ms = stamp ? Date.parse(stamp) : Number.NaN;
    return {
      id: release.id,
      tagName: release.tagName,
      name: release.name.trim() || release.tagName,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      when: Number.isFinite(ms) ? relativeTime(nowMs, ms, language) : null,
      htmlUrl: release.htmlUrl,
      assets: release.assets.map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.size,
        sizeLabel: humanSize(asset.size),
        downloadCount: asset.downloadCount,
        contentType: asset.contentType,
        updatedAt: asset.updatedAt,
      })),
    };
  });
}

/** Which copy to pair with gh's message on a failed read; null means the read
 * succeeded. */
export function releaseNotice(
  payload: WireReleasesPayload,
): ReleaseNotice | null {
  switch (payload.kind) {
    case "notInstalled":
      return {
        tone: "warn",
        titleKey: "remotes.releases.notInstalled.title",
        hintKey: "remotes.releases.notInstalled.hint",
        detail: null,
      };
    case "notLoggedIn":
      return {
        tone: "warn",
        titleKey: "remotes.releases.notLoggedIn.title",
        hintKey: "remotes.releases.notLoggedIn.hint",
        detail: null,
      };
    case "error":
      return {
        tone: "error",
        titleKey: "remotes.releases.error.title",
        hintKey: "remotes.releases.error.hint",
        detail: payload.error,
      };
    default:
      break;
  }
  if (payload.releases.length === 0) {
    return {
      tone: "empty",
      titleKey: "remotes.releases.empty.title",
      hintKey: "remotes.releases.empty.hint",
      detail: null,
    };
  }
  return null;
}
