import type { PptxParagraph, PptxRun } from "@/lib/native";

/**
 * A slide's arithmetic, kept out of the component so it can be tested on its own.
 *
 * A slide is authored in a fixed box and drawn into whatever room the pane has, so every length on
 * it is the same scale away from where the file puts it.
 */

/** The scale a slide is drawn at: the room it has, the zoom the user asked for, or both. */
export function fitScale(slideWidth: number, available: number, zoom: number): number {
  if (slideWidth <= 0 || available <= 0) return zoom;
  return (available / slideWidth) * zoom;
}

/** How deep a paragraph sits, from its outline level. */
export function paragraphIndent(level: number): number {
  // Half an inch a level is what a deck's own outline uses.
  return Math.max(level, 0) * 48;
}

/** The alignment a paragraph asks for. */
export function paragraphAlign(align: string | undefined): "left" | "center" | "right" | "justify" {
  switch (align) {
    case "center":
      return "center";
    case "right":
      return "right";
    case "justify":
      return "justify";
    default:
      return "left";
  }
}

/** The point size a run is drawn at, in pixels, or the shape's own default. */
export function runSizePx(run: PptxRun, fallbackPt: number): number {
  const points = run.size ?? fallbackPt;
  // Points to pixels at 96 dpi.
  return (points * 96) / 72;
}

/** The styling a run declares, as the properties the pane draws with. */
export function runStyle(run: PptxRun, fallbackPt: number): React.CSSProperties {
  return {
    fontWeight: run.bold ? 600 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration: run.underline ? "underline" : undefined,
    fontSize: `${runSizePx(run, fallbackPt)}px`,
    color: run.color ?? undefined,
    fontFamily: run.font ?? undefined,
  };
}

/** Whether a paragraph has anything to draw. */
export function paragraphText(paragraph: PptxParagraph): string {
  return paragraph.runs.map((run) => run.text).join("");
}
