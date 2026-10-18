import { convertFileSrc } from "@tauri-apps/api/core";
import type { ComponentProps, SyntheticEvent } from "react";
import { useEffect, useRef, useState } from "react";

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

/** A height attribute, when the markdown actually asked for one. */
export function requestedHeight(height: ComponentProps<"img">["height"]): number | undefined {
  if (typeof height === "number") return height > 0 ? height : undefined;
  if (typeof height === "string" && /^\d+$/.test(height)) {
    const value = Number(height);
    return value > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Markdown `img` override: local paths resolve, broken ones say so, and rows of
 * pictures share one height.
 *
 * A markdown table asks for a height and leaves the width to each image. Sizing
 * every picture at that height alone makes the row wider than the page once the
 * columns are narrow, so each picture also reports the height at which it would
 * exactly fill its own column; the smallest of those wins for the whole row.
 * That keeps a row flat and inside the table at any window size.
 */
export function MarkdownImage({
  src,
  alt,
  node: _node,
  baseDir,
  style,
  height,
  ...props
}: MarkdownImageProps) {
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /** Reported to the row so every picture can agree on one height. */
  const [fitHeight, setFitHeight] = useState<number | null>(null);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const ref = useRef<HTMLImageElement>(null);
  const resolved = resolveImageSrc(src, baseDir);
  const asked = requestedHeight(height);

  // Publish the height this picture would need to fill its column exactly.
  useEffect(() => {
    const img = ref.current;
    if (!img || !natural) return;
    const measure = () => {
      const cell = img.closest("td, th")?.getBoundingClientRect().width ?? 0;
      const ratio = natural.w / natural.h;
      if (cell <= 0 || ratio <= 0) {
        setFitHeight(null);
        return;
      }
      setFitHeight(Math.floor(cell / ratio));
    };
    measure();
    const table = img.closest("table");
    if (!table) return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [natural]);

  // Read back the height the row settled on.
  useEffect(() => {
    const img = ref.current;
    const row = img?.closest("tr");
    if (!row) return;
    const read = () => {
      const value = row.getAttribute("data-row-image-height");
      setRowHeight(value ? Number(value) : null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(row, { attributes: true, attributeFilter: ["data-row-image-height"] });
    return () => observer.disconnect();
  }, []);

  // Offer this picture's constraint to the row.
  useEffect(() => {
    const img = ref.current;
    const row = img?.closest("tr");
    if (!row || fitHeight === null) return;
    const key = "data-image-fit-heights";
    const next = `${row.getAttribute(key) ?? ""} ${fitHeight}`.trim();
    row.setAttribute(key, next);
    return () => {
      const current = row.getAttribute(key) ?? "";
      const remaining = current
        .split(/\s+/)
        .filter(Boolean)
        .filter((_, index, all) => index !== all.indexOf(String(fitHeight)))
        .join(" ");
      if (remaining) row.setAttribute(key, remaining);
      else row.removeAttribute(key);
    };
  }, [fitHeight]);

  const effective = asked ?? rowHeight ?? undefined;

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

  return (
    <img
      {...props}
      ref={ref}
      src={resolved}
      alt={alt ?? ""}
      decoding="async"
      loading="lazy"
      // Height lives in CSS: an HTML height attribute beats the CSS that keeps
      // the ratio, which is what squashed the wide screenshots.
      className="block max-w-full rounded-sm"
      style={{
        ...(effective === undefined
          ? {}
          : { height: `${effective}px`, width: "auto" }),
        maxWidth: "100%",
        ...style,
      }}
      onLoad={(event: SyntheticEvent<HTMLImageElement>) => {
        const img = event.currentTarget;
        if (img.naturalWidth && img.naturalHeight) {
          setNatural({ w: img.naturalWidth, h: img.naturalHeight });
        }
        props.onLoad?.(event);
      }}
      onError={(event: SyntheticEvent<HTMLImageElement>) => {
        setFailed(true);
        props.onError?.(event);
      }}
    />
  );
}