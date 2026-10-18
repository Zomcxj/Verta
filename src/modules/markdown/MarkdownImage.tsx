import type { ComponentProps, SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestedHeight, resolveImageSrc } from "./imagePath";

type Sizing = { height: number; width: number };

export type MarkdownImageProps = ComponentProps<"img"> & {
  node?: unknown;
  /** Directory of the markdown file being rendered, so `./x.png` resolves. */
  baseDir?: string | null;
};

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
