import { convertFileSrc } from "@tauri-apps/api/core";
import type { ComponentProps, SyntheticEvent } from "react";
import { useState } from "react";

export type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  /** Directory of the markdown file being rendered, so `./x.png` resolves. */
  baseDir?: string | null;
};

/** Windows drive paths and UNC paths, which name a location on their own. */
function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * A markdown renderer normalizes `./x.png` to `/x.png` before it reaches us, so
 * a leading slash from markdown means "at the document root", not the drive
 * root. The caller strips it before joining; this records why.
 */
function stripDocumentRoot(value: string): string {
  return value.startsWith("/") ? value.replace(/^\/+/, "") : value;
}

/** Percent-decoding helpers only; a wrong guess must fall back to the raw text. */
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
 * Resolves a markdown image reference to something the webview can load.
 *
 * Relative references are joined onto the document's own directory, which is
 * what the author meant by `./demo.png`; absolute paths are used as given.
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

/** Markdown `img` override: local paths resolve, broken ones say so. */
export function MarkdownImage({
  src,
  alt,
  node: _node,
  baseDir,
  style,
  ...props
}: MarkdownImageProps) {
  const [failed, setFailed] = useState(false);
  const resolved = resolveImageSrc(src, baseDir);

  if (!resolved) {
    return <span className="text-muted-foreground">{alt ?? "image"}</span>;
  }
  if (failed) {
    return (
      <span
        className="rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive"
        title={src}
      >
        {alt || "image"} (not found)
      </span>
    );
  }
  // `width="null"` is what a markdown table cell passes through from HTML; it is
  // not a length, and letting it through makes the image sized by its intrinsic
  // pixels, which then spills out of the cell. Sizing is left to CSS so a wide
  // picture fits its column and shrinks with the window instead of being
  // clipped by the next cell.
  const { height, ...rest } = props;
  const numericHeight =
    typeof height === "number"
      ? height
      : typeof height === "string" && /^\d+$/.test(height)
        ? Number(height)
        : undefined;

  return (
    <img
      {...rest}
      src={resolved}
      alt={alt ?? ""}
      decoding="async"
      loading="lazy"
      height={numericHeight}
      style={{
        maxWidth: "100%",
        height: numericHeight === undefined ? "auto" : undefined,
        objectFit: "contain",
        ...style,
      }}
      className="block h-auto max-w-full rounded-sm"
      onError={(event: SyntheticEvent<HTMLImageElement>) => {
        setFailed(true);
        rest.onError?.(event);
      }}
    />
  );
}