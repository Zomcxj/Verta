import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PptxDocument, type PptxParagraph, type PptxShape, native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import {
  fitScale,
  paragraphAlign,
  paragraphIndent,
  runSizePx,
  runStyle,
} from "./lib/pptxLayout";

/** The distance between two slides in the column. */
const SLIDE_GAP = 20;
/** The padding around the column of slides. */
const VIEW_PADDING = 16;
/** The point size a shape's text is drawn at when nothing on the slide names one. */
const DEFAULT_POINT_SIZE = 18;
/** How far one press of the zoom buttons moves. */
const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

/**
 * A `.pptx` as the slides it holds.
 *
 * Read-only. Each slide is drawn as a box the size the file states, with its shapes placed where
 * the file places them, so what the pane shows is the layout rather than a reflow of the text. The
 * slide master is not read, so a shape that inherits its place and its size from a layout is drawn
 * with what the slide itself declares.
 */
export function PptxPreview({ path }: { path: string }) {
  const t = useT();
  const scroll = useRef<HTMLDivElement | null>(null);
  const [deck, setDeck] = useState<PptxDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  /** Whether the scale should follow the pane's width rather than the zoom alone. */
  const [fit, setFit] = useState(true);
  const [available, setAvailable] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDeck(null);
    setFailed(false);
    setPage(0);
    native.readPptx(path)
      .then((read) => {
        if (!cancelled) setDeck(read);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // The room a slide has, which is what "fit width" means.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scroller only exists once a deck has been read, and that is what the effect has to wait for
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => setAvailable(element.clientWidth - VIEW_PADDING * 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [deck]);

  const slideWidth = deck?.width ?? 0;
  const slideHeight = deck?.height ?? 0;
  const scale = useMemo(() => {
    if (!fit) return zoom;
    return fitScale(slideWidth, available, zoom);
  }, [fit, zoom, slideWidth, available]);

  const drawnWidth = slideWidth * scale;
  const drawnHeight = slideHeight * scale;

  /** Which slide the top of the pane is on, so the toolbar's page number follows the scroll. */
  const onScroll = useCallback(() => {
    const element = scroll.current;
    if (!element) return;
    const step = drawnHeight + SLIDE_GAP;
    if (step <= 0) return;
    const top = element.scrollTop - VIEW_PADDING;
    setPage(Math.min(Math.max(Math.floor(top / step), 0), Math.max((deck?.slides.length ?? 1) - 1, 0)));
  }, [drawnHeight, deck]);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [onScroll]);

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        {t("editor.pptx.unreadable")}
      </div>
    );
  }
  if (!deck) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("editor.pptx.reading")}
      </div>
    );
  }
  if (deck.slides.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t("editor.pptx.empty")}
      </div>
    );
  }

  /** One shape, placed in the slide's own coordinates and scaled with it. */
  const shape = (entry: PptxShape, index: number) => (
    <div
      key={index}
      data-pptx-shape={index}
      data-pptx-kind={entry.kind}
      className="absolute overflow-hidden"
      style={{
        left: entry.x * scale,
        top: entry.y * scale,
        width: entry.width * scale,
        height: entry.height * scale,
        background: entry.fill ?? undefined,
        transform: entry.rotation ? `rotate(${entry.rotation}deg)` : undefined,
      }}
    >
      {entry.image ? (
        <img
          src={entry.image}
          alt=""
          className="h-full w-full object-contain"
          draggable={false}
        />
      ) : null}
      {entry.paragraphs.map((paragraph, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a paragraph has no id of its own; its place in the shape is its identity
        <Paragraph key={at} paragraph={paragraph} scale={scale} />
      ))}
    </div>
  );

  return (
    <div data-pptx-preview="" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-2.5 py-1 text-[10.5px] text-muted-foreground">
        <span data-pptx-page="">
          {t("editor.pptx.page", { page: page + 1, total: deck.slides.length })}
        </span>
        <span className="flex-1" />
        {deck.truncated ? <span>{t("editor.pptx.truncated")}</span> : null}
        <button
          type="button"
          onClick={() => {
            setFit(false);
            setZoom((current) => Math.max(current / ZOOM_STEP, MIN_ZOOM));
          }}
          className="rounded border border-border/60 px-1.5 hover:bg-accent hover:text-foreground"
        >
          {t("editor.pptx.zoomOut")}
        </button>
        <button
          type="button"
          onClick={() => {
            setFit(false);
            setZoom((current) => Math.min(current * ZOOM_STEP, MAX_ZOOM));
          }}
          className="rounded border border-border/60 px-1.5 hover:bg-accent hover:text-foreground"
        >
          {t("editor.pptx.zoomIn")}
        </button>
        <button
          type="button"
          aria-pressed={fit}
          onClick={() => {
            setFit(true);
            setZoom(1);
          }}
          className={[
            "rounded border border-border/60 px-1.5 hover:bg-accent hover:text-foreground",
            fit ? "text-foreground" : "",
          ].join(" ")}
        >
          {t("editor.pptx.fitWidth")}
        </button>
      </div>
      <div
        ref={scroll}
        onScroll={onScroll}
        className="verta-doc-scroll min-h-0 flex-1 overflow-auto"
        style={{ padding: VIEW_PADDING }}
      >
        <div className="flex flex-col items-center" style={{ gap: SLIDE_GAP }}>
          {deck.slides.map((slide) => (
            <div
              key={slide.index}
              data-pptx-slide={slide.index}
              className="relative shrink-0 shadow-md"
              // A slide is paper of the colour it states, or white when it states none: a run that
              // names no colour is black ink, not the pane's own foreground, which on a dark theme
              // would be near-white on white.
              style={{
                width: drawnWidth,
                height: drawnHeight,
                color: "#000000",
                // A paper that is a photograph covers the slide, the way PowerPoint draws it. The
                // picture comes first because a slide drawn on one states no colour at all.
                background: slide.backgroundImage
                  ? `center / cover no-repeat url("${slide.backgroundImage}")`
                  : (slide.background ?? "#ffffff"),
              }}
            >
              {slide.shapes.map((entry, at) => shape(entry, at))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One paragraph of a shape's text. */
function Paragraph({ paragraph, scale }: { paragraph: PptxParagraph; scale: number }) {
  return (
    <div
      className="whitespace-pre-wrap break-words"
      style={{
        textAlign: paragraphAlign(paragraph.align),
        paddingLeft: paragraphIndent(paragraph.level) * scale,
      }}
    >
      {paragraph.bullets ? <span style={{ fontSize: `${runSizePx(paragraph.runs[0] ?? { text: "", bold: false, italic: false, underline: false }, DEFAULT_POINT_SIZE) * scale}px` }}>• </span> : null}
      {paragraph.runs.map((run, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a run has no id of its own; its place in the paragraph is its identity
        <span key={at} style={{ ...runStyle(run, DEFAULT_POINT_SIZE), fontSize: `${runSizePx(run, DEFAULT_POINT_SIZE) * scale}px` }}>
          {run.text}
        </span>
      ))}
    </div>
  );
}
