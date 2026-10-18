import { convertFileSrc } from "@tauri-apps/api/core";
import type { ComponentProps, SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  /** Directory of the markdown file being rendered, so `./x.png` resolves. */
  baseDir?: string | null;
};

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

type Sizing = { height: number; width: number };

/** Used when the markdown asks for no height, so a picture is still tangible. */
const FALLBACK_HEIGHT = 260;

/**
 * The size a picture takes inside a markdown table.
 *
 * The table is the unit that scales. Its usable width is split evenly between
 * the columns that hold a picture, and each column's picture fills that width at
 * its own ratio; the shortest of those heights is then given to every picture in
 * the table, so rows stay flat while the pictures still cover their cells as far
 * as their ratio allows. Everything derives from the table's width, so shrinking
 * the page shrinks the table instead of pushing it off screen.
 *
 * Nothing here reads a cell's width to decide a picture's width: a cell sizes
 * itself from its content, so that would feed back into the table's own width
 * and either grow it without bound or reach the page edge and stop shrinking.
 */
function useTableSizing(
  ref: React.RefObject<HTMLImageElement | null>,
  requested: number | undefined,
): Sizing | null {
  const [sizing, setSizing] = useState<Sizing | null>(null);

  const measure = useCallback(() => {
    const img = ref.current;
    const table = img?.closest("table");
    if (!img || !table || !img.naturalWidth || !img.naturalHeight) {
      setSizing(null);
      return;
    }

    // Columns that hold a picture are the ones competing for the width.
    const cells = new Set<Element>();
    const pictures: HTMLImageElement[] = [];
    for (const picture of table.querySelectorAll("img")) {
      const owner = picture.closest("td, th");
      if (!owner || !picture.naturalWidth || !picture.naturalHeight) continue;
      cells.add(owner);
      pictures.push(picture);
    }
    if (pictures.length === 0) {
      setSizing(null);
      return;
    }

    // Cell padding is taken by the cell itself, not by the picture.
    const padding = [...cells].reduce((sum, node) => {
      const style = getComputedStyle(node);
      return (
        sum +
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0)
      );
    }, 0);

    // Usable width per picture column. The table's own border adds a couple of
    // pixels, which the floor below absorbs.
    const available = table.getBoundingClientRect().width - padding;
    if (available <= 0) {
      setSizing(null);
      return;
    }
    const share = available / pictures.length;

    // One height for the whole table: the shortest height at which any picture
    // still spans its column. A taller picture then leaves a little air beside
    // it rather than stretching, and the row stays flat.
    let rowHeight = Number.POSITIVE_INFINITY;
    for (const picture of pictures) {
      const own = picture.naturalWidth / picture.naturalHeight;
      if (own <= 0) continue;
      rowHeight = Math.min(rowHeight, share / own);
    }
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
      setSizing(null);
      return;
    }
    // An author's own height is a ceiling, which lets a document keep pictures
    // small without breaking the row.
    const height = Math.max(1, Math.floor(Math.min(rowHeight, requested ?? rowHeight)));
    const ratio = img.naturalWidth / img.naturalHeight;
    // Both numbers in px: a percentage width on an auto-sized cell is what made
    // the table grow past the page.
    const width = Math.max(1, Math.min(Math.floor(share), Math.round(height * ratio)));
    setSizing({ height, width });
  }, [ref, requested]);

  useEffect(() => {
    const img = ref.current;
    const table = img?.closest("table");
    if (!img || !table) {
      setSizing(null);
      return;
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [measure, ref]);

  return sizing;
}

/**
 * Markdown `img` override: local paths resolve, broken ones say so, and pictures
 * inside a table fill their cells at one shared height.
 */
export function MarkdownImage({
  src,
  alt,
  node: _node,
  baseDir,
  style,
  width,
  height,
  ...props
}: MarkdownImageProps) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  const resolved = resolveImageSrc(src, baseDir);
  const asked = requestedHeight(height);
  const sizing = useTableSizing(ref, asked);

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

  // In a table the measured box wins: it is what keeps a row flat and the table
  // inside the page. Outside one the author's size stands, with `max-width`
  // keeping a wide picture from running past the text.
  const sized = sizing
    ? { height: `${sizing.height}px`, width: `${sizing.width}px`, maxWidth: "none" as const }
    : {
        ...(asked === undefined ? { height: `${FALLBACK_HEIGHT}px` } : { height: `${asked}px` }),
        ...(typeof width === "number" ? { width: `${width}px` } : {}),
        maxWidth: "100%",
      };

  return (
    <img
      {...props}
      ref={ref}
      src={resolved}
      alt={alt ?? ""}
      decoding="async"
      loading="lazy"
      // Size lives in CSS: an HTML height attribute beats any CSS that keeps the
      // ratio, which is what squashed the wide screenshots.
      className="block rounded-sm"
      style={{ objectFit: "contain", ...sized, ...style }}
      onLoad={(event: SyntheticEvent<HTMLImageElement>) => {
        props.onLoad?.(event);
      }}
      onError={(event: SyntheticEvent<HTMLImageElement>) => {
        setFailed(true);
        props.onError?.(event);
      }}
    />
  );
}
