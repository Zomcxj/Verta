import type { WireReleasesPayload } from "@/lib/native";
import { relativeTime } from "@/modules/launcher";

/** 界面上一条 Release：wire 字段之外，加上显示用的时间与大小文案。 */
export type ReleaseRow = {
  id: number;
  tagName: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** 相对时间；两个日期都解不出来时是 null。 */
  when: string | null;
  htmlUrl: string;
  assets: ReleaseAssetRow[];
};

export type ReleaseAssetRow = {
  id: number;
  name: string;
  size: number;
  /** `1.5 MB` 这类展示文案。 */
  sizeLabel: string;
  downloadCount: number;
  contentType: string | null;
  updatedAt: string | null;
};

/**
 * 列表为空或读不到时该说点什么，有内容要画列表时是 null。
 * 文案是 i18n 键，色调决定提示块的样子。
 */
export type ReleaseNotice = {
  tone: "empty" | "warn" | "error";
  titleKey: string;
  hintKey: string;
  detail: string | null;
};

/** 一次下载的进度；速度是平滑后的值，避免数字乱跳。 */
export type DownloadProgress = {
  written: number;
  total: number;
  /** 字节每秒；第一个采样点是 0。 */
  speed: number;
  sampledAt: number;
  sampledWritten: number;
};

export type DownloadStatus = "running" | "ok" | "error" | "cancelled";

/** 界面上一个附件当前的下载状态，按附件 id 存放。 */
export type DownloadEntry = {
  /** 前端生成的标识，进度事件靠它认领。 */
  id: string;
  status: DownloadStatus;
  progress: DownloadProgress;
  /** 成功后的最终路径。 */
  path: string | null;
  error: string | null;
  cancelling: boolean;
};

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 二进制单位，一位小数；不到 1 KiB 就按字节说。 */
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

/** 已下载占总量的百分比；总量未知时是 null（界面走不确定态）。 */
export function percentOf(written: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(written)) return 0;
  return Math.min(100, Math.max(0, (written / total) * 100));
}

/** 速度文案；还没测出来时不显示（别写一个假的 0 KB/s）。 */
export function formatSpeed(bytesPerSecond: number): string | null {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${humanSize(bytesPerSecond)}/s`;
}

/** 采样间隔：比这更密的进度只更新字节数，不重算速度。 */
const SAMPLE_MS = 250;
const SMOOTHING = 0.3;

/**
 * 把一次进度事件折进状态。
 *
 * 速度用指数平滑：一次 IPC 抖动不该让数字从 12 MB/s 掉到 3 MB/s。间隔太短时保留上一次的值，
 * 但字节数与总量照常更新（进度条不能停）。
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

/** wire 数据 → 列表行。 */
export function releaseRows(
  payload: WireReleasesPayload,
  nowMs: number,
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
      when: Number.isFinite(ms) ? relativeTime(nowMs, ms) : null,
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

/** 读不到时 gh 的原话该配哪套文案；null 说明这次真的读到了。 */
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
