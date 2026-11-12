"use client";

import { cn } from "@/lib/utils";
import { PanZoomSurface } from "@/components/pan-zoom";
import {
  mermaidThemeVariables,
  readDiagramPalette,
} from "@/modules/editor/lib/diagramTheme";
import {
  applyDiagramZoom,
  steppedZoom,
  zoomLabel,
} from "@/modules/editor/lib/diagramZoom";
import { useT } from "@/modules/i18n";
import { toggleStopClass } from "@/modules/markdown";
import { useTheme } from "@/modules/theme";
import { useEffect, useId, useRef, useState } from "react";

/**
 * A mermaid diagram, drawn from source the caller already has.
 *
 * The same component for both places a diagram appears - a `.mmd`/`.mermaid` file and a ```mermaid
 * fence in markdown or a chat answer - because the two differences between them (where the space
 * comes from, and where the zoom control sits) belong to the callers: this one takes a string, the
 * magnification, and a class name.
 *
 * The library is imported here rather than at the top of the file. Nothing on the startup path
 * needs it, it is the largest single package the app can reach, and `dist-budget` holds the launch
 * graph to that: the diagram arrives with the first diagram, not with the window.
 */
export type MermaidDiagramProps = {
  /** The diagram source, exactly as it was in the file or the fence. */
  code: string;
  /** Sizing and centring for the drawing. The caller owns the space it is given. */
  className?: string;
  /** 1 is "as wide as the pane, up to the drawing's own width"; see `applyDiagramZoom`. */
  zoom?: number;
  /** Called by ctrl/⌘ + wheel. Without it the wheel is left to the pane. */
  onZoomChange?: (zoom: number) => void;
};

export function MermaidDiagram({
  code,
  className,
  zoom = 1,
  onZoomChange,
}: MermaidDiagramProps) {
  const t = useT();
  const { resolvedMode, activeTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumped after every draw.
   *
   * The svg is mermaid's element, not React's, so it is sized here rather than through the render:
   * a press has to reach the drawing that is already on screen, and a redraw produces a new one that
   * starts at the size mermaid wrote. This counter is how the sizing effect hears about the second.
   */
  const [drawn, setDrawn] = useState(0);
  /**
   * Whether the drawing is currently bigger than the room it is in, in either axis.
   *
   * A drag only makes sense then, and so does the grab cursor - offering either on a drawing that
   * already fits would promise movement that cannot happen. Watched rather than computed: the room
   * changes when a divider is dragged or the window resized, and neither of those passes through
   * this component.
   */
  const [overflows, setOverflows] = useState(false);
  // Mermaid builds element ids, `url(#...)` references and style rules out of this one, so it has to
  // be unique per diagram on the page and stable across re-renders.
  const id = `verta-diagram-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const source = code.trim();

  // The palette is read from the document inside this effect, which is why the theme is a
  // dependency even though the body never names it: `applyTheme` writes the variables and React
  // hears about it as `activeTheme`, so a different theme means a different answer to the same call.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the theme variables are read from the document, not passed in
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!source) {
      host.replaceChildren();
      setError(null);
      return;
    }
    let cancelled = false;
    const draw = async () => {
      const mermaid = (await import("mermaid")).default;
      if (cancelled) return;
      const pane = getComputedStyle(host);
      mermaid.initialize({
        startOnLoad: false,
        // A diagram is content, not a document: no HTML in labels, no script, no links that reach
        // the webview.
        securityLevel: "strict",
        theme: "base",
        themeVariables: mermaidThemeVariables(readDiagramPalette(resolvedMode), {
          dark: resolvedMode === "dark",
          fontFamily: pane.fontFamily,
          fontSize: pane.fontSize,
        }),
      });
      // The library hands the drawing back as markup, and takes its own scratch element away with it:
      // `render(id, text, container)` draws inside that container and then removes it again on the
      // way out (`removeTempElements`), so a host filled that way is empty by the time the promise
      // resolves - measured here as "opening a .mmd shows nothing", with the svg present during the
      // await and gone after it. So the returned markup is what gets inserted.
      const { svg } = await mermaid.render(id, source);
      if (cancelled) return;
      // Parsed rather than assigned, which keeps this component from writing a string into the page;
      // `text/html` because that is the parser that keeps `<foreignObject>` labels as HTML.
      const drawing = new DOMParser().parseFromString(svg, "text/html").body
        .firstElementChild;
      if (!drawing) throw new Error("mermaid returned no drawing");
      host.replaceChildren(document.importNode(drawing, true));
    };
    void draw().then(
      () => {
        if (cancelled) return;
        setError(null);
        setDrawn((count) => count + 1);
      },
      (cause: unknown) => {
        if (cancelled) return;
        // Whatever it managed to insert before failing would read as a drawing bug rather than as a
        // parse error, and the source below is what the reader can act on.
        host.replaceChildren();
        setError(cause instanceof Error ? cause.message : String(cause));
        setDrawn((count) => count + 1);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, source, resolvedMode, activeTheme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` is what says the svg is new
  useEffect(() => {
    const svg = hostRef.current?.querySelector("svg");
    if (svg) applyDiagramZoom(svg, zoom);
  }, [zoom, drawn]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `drawn` and `zoom` both change the size being measured
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const svg = host.querySelector("svg");
      if (!svg) {
        setOverflows(false);
        return;
      }
      const drawing = svg.getBoundingClientRect();
      const room = host.getBoundingClientRect();
      setOverflows(drawing.width > room.width + 1 || drawing.height > room.height + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    const svg = host.querySelector("svg");
    if (svg) observer.observe(svg);
    return () => observer.disconnect();
  }, [drawn, zoom]);

  return (
    <>
      <PanZoomSurface
        zoom={zoom}
        onZoomChange={onZoomChange}
        draggable={overflows}
        className={cn("min-w-0", className)}
      >
        <div
          ref={hostRef}
          data-slot="mermaid-diagram"
          data-zoom={zoom}
          className="min-w-0 [&_svg]:max-w-full"
        />
      </PanZoomSurface>
      {error ? (
        <div data-slot="mermaid-error" className="min-w-0 px-3 py-2">
          <p className="text-[11.5px] text-destructive">
            {t("editor.mermaid.failed")}
          </p>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-destructive/80">
            {error}
          </pre>
          <pre className="mt-2 overflow-x-auto font-mono text-[11.5px] leading-relaxed text-foreground">
            {source}
          </pre>
        </div>
      ) : null}
    </>
  );
}

/**
 * The zoom control that goes with a diagram or a picture.
 *
 * A component of its own rather than part of either, because the control belongs beside the other
 * controls of whatever is showing the thing: the file's view switch, a fence's header, a picture's
 * own toolbar. The percentage is the reset - one place that says where the content is and takes it
 * back to fit.
 */
export function ZoomControls({
  zoom,
  onChange,
  className,
}: {
  zoom: number;
  onChange: (zoom: number) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      <button
        type="button"
        onClick={() => onChange(steppedZoom(zoom, -1))}
        data-slot="diagram-zoom-out"
        title={t("editor.diagram.zoomOut")}
        aria-label={t("editor.diagram.zoomOut")}
        className={toggleStopClass(false)}
      >
        −
      </button>
      <button
        type="button"
        onClick={() => onChange(1)}
        title={t("editor.diagram.fit")}
        aria-label={t("editor.diagram.fit")}
        aria-pressed={zoom === 1}
        data-slot="diagram-zoom-level"
        className={toggleStopClass(zoom === 1)}
      >
        {zoomLabel(zoom)}
      </button>
      <button
        type="button"
        onClick={() => onChange(steppedZoom(zoom, 1))}
        data-slot="diagram-zoom-in"
        title={t("editor.diagram.zoomIn")}
        aria-label={t("editor.diagram.zoomIn")}
        className={toggleStopClass(false)}
      >
        +
      </button>
    </span>
  );
}
