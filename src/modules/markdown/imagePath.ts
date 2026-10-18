import { convertFileSrc } from "@tauri-apps/api/core";
import type { ComponentProps } from "react";

/** Windows drive paths and UNC paths, which name a location on their own. */
function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** Percent-decoding only; a wrong guess must fall back to the raw text. */
function decode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

/**
 * Collapses `.` and `..` segments without touching the root. A leading drive or
 * UNC share is preserved, and a `..` that would escape the root is dropped
 * instead of climbing above it.
 */
export function normalizePath(path: string): string {
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Never remove a drive letter (`F:`) or climb past the first segment.
      const last = out[out.length - 1];
      if (last && last !== ".." && !/^[a-zA-Z]:$/.test(last)) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join(separator);
  // Keep the leading separator of a POSIX absolute path.
  return path.startsWith("/") ? `/${joined}` : joined;
}

/**
 * A markdown renderer normalizes `./x.png` to `/x.png` before it reaches us, so
 * a leading slash from markdown means "at the document root", not the drive
 * root. The caller strips it before joining.
 */
function stripDocumentRoot(value: string): string {
  return value.startsWith("/") ? value.replace(/^\/+/, "") : value;
}

/**
 * Resolves a markdown image reference to something the webview can load.
 *
 * Relative references are joined onto the document's own directory, which is
 * what the author meant by `./demo.png`; absolute paths are given as written.
 * Remotely hosted images and inline `data:` images pass straight through.
 * Nothing here reads the file: the asset protocol serves it, and it only
 * answers for paths the app has been granted.
 */
export function resolveImageSrc(
  src: string | undefined,
  baseDir: string | null | undefined,
): string | null {
  if (!src) return null;
  const raw = src.trim();
  if (!raw) return null;
  if (/^(https?:)?\/\//i.test(raw) || raw.startsWith("data:")) return raw;
  // A bare `#fragment` is a same-page anchor, not an image.
  if (raw.startsWith("#")) return null;

  const path = decode(raw.split(/[?#]/)[0] ?? raw);
  if (!path) return null;
  if (path.startsWith("file://")) {
    return convertFileSrc(normalizePath(decode(path.slice(7)).replace(/\//g, "\\")));
  }
  if (isAbsolutePath(path)) return convertFileSrc(normalizePath(path.replace(/\//g, "\\")));
  // Markdown's own leading slash is relative to the document, not the drive.
  const relative = stripDocumentRoot(path);
  if (!relative) return null;
  if (!baseDir) return convertFileSrc(relative);

  // Percent-decoded already; keep the separator style of the base directory.
  const separator = baseDir.includes("\\") ? "\\" : "/";
  const joined = `${baseDir.replace(/[\\/]+$/, "")}${separator}${relative.replace(/[\\/]+/g, separator)}`;
  return convertFileSrc(normalizePath(joined));
}

/** A height attribute, when the markdown actually asked for one. */
export function requestedHeight(height: ComponentProps<"img">["height"]): number | undefined {
  if (typeof height === "number") return height > 0 ? height : undefined;
  if (typeof height === "string" && /^\d+$/.test(height)) {
    const value = Number(height);
    return value > 0 ? value : undefined;
  }
  return undefined;
}

