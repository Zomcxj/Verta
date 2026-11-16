import { cn } from "@/lib/utils";
import { resolveShape, type ShapeId } from "./shape";
import type { RadiusStop } from "./radius";

/**
 * The picture next to a shape's name: the shell in miniature.
 *
 * It draws the three regions - sidebar, workspace, right panel - rather than one box, because the
 * shapes differ in what happens *between* them: 无界 closes the gutters and merges them, 极简 keeps a
 * gap of frame showing, and the rest round, border and shadow each region on its own. A single square
 * cannot say any of that, and it stopped being able to say anything at all once the radius left the
 * shapes - 无界 and 极简 would have drawn the same square.
 *
 * Three decisions keep it legible at 30x24, where a literal miniature is not:
 *
 * 1. The panes are not `--background`. In a light theme the pane and the card it sits on are two
 *    near-whites, and five of the six choices drew as one pale plate. Every tone here is a mix of
 *    `--foreground` instead, which is dark in a light theme and light in a dark one, so the drawing
 *    has contrast whichever way the palette goes.
 * 2. The panes are not equal. Three equal thirds read as a column grid, not as a window: the sidebar
 *    is the narrow one, the workspace is twice its width, and the right panel is narrower still.
 * 3. The corner radius is capped per pane (`cornerOf`). The window's panes are hundreds of pixels
 *    wide, so a 16px corner on them is a detail; the same corner on an 8px-wide drawing turns the pane
 *    into a pill and the icon into an hourglass. The cap keeps the top of the slider visible without
 *    that, and the block's own corners carry the rest of the range.
 *
 * The gutters are the frame's share of the width, drawn as a stronger mix than the panes - which is
 * also what the shell does with `--frame`, only at a contrast this drawing can be read at. The
 * shadow, the two lit edges and the sheen stay at icon scale: they are the same ideas as the real
 * ones, sized to the box (a real `0 8px 24px` card shadow on a 24px drawing is a smudge).
 */
const ICON = {
  width: 30,
  height: 24,
  /** Pixels per `rem` of radius, so a 16px radius is legible on a 24px drawing. */
  radiusScale: 0.45,
  /**
   * The block's corners are rounder than the panes' at the low end and the panes' are capped, so the
   * two together cover the whole slider instead of both saturating at the top of it.
   */
  blockScale: 1.15,
  /** A pane may not be rounder than this share of its own width, or it reads as a pill. */
  cornerCap: 0.45,
  /** The three regions left to right: sidebar, workspace, right panel. */
  panes: [8, 12, 6],
  /** The frame showing between two panes. */
  gutter: 2,
  /** How far a floating card steps in from the block's edge. */
  cloudInset: 1.5,
} as const;

/** What the drawing adds on top of three regions, one line per shape that adds anything. */
const EXTRAS: Partial<
  Record<
    ShapeId,
    {
      card?: boolean;
      contact?: boolean;
      bevel?: boolean;
      sheen?: boolean;
      /** Floating: the panes step in from the block's edge so the shadow has somewhere to fall. */
      inset?: boolean;
      /** A woven surface over the block: the one shape whose material is a pattern. */
      weave?: boolean;
    }
  >
> = {
  cloud: { card: true, inset: true },
  emboss: { bevel: true },
  slab: { contact: true },
  carbon: { weave: true },
  acrylic: { sheen: true },
  glass: { sheen: true },
};

/** The pane's fill: the pane colour, pulled towards the foreground far enough to be seen on a card. */
const PANE_FILL = "color-mix(in oklab, var(--foreground) 12%, var(--background))";
/** The glass shape's panes are translucent: what they leave alone is the material behind them. */
const GLASS_FILL = "color-mix(in oklab, var(--foreground) 7%, transparent)";
/** The frame between two panes, and the block's own outline: the drawing's two greys. */
const FRAME_FILL = "color-mix(in oklab, var(--foreground) 16%, transparent)";
const RING = "inset 0 0 0 1px color-mix(in oklab, var(--foreground) 24%, transparent)";

/**
 * 碳纤维's weave at icon scale.
 *
 * The same crossing the surface draws - 135deg and 45deg, one pass brighter than the other - with both
 * the pitch and the contrast raised for a 30x24 drawing: the real surface is looked at through an 8px
 * frame, which an icon does not have.
 */
const WEAVE =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--foreground) 22%, transparent) 0 1px, transparent 1px 3px), repeating-linear-gradient(45deg, color-mix(in oklab, var(--foreground) 12%, transparent) 0 1px, transparent 1px 3px)";

/**
 * The border each shape gives a pane, as a colour a 24px drawing can show.
 *
 * Not the shape's own `--pane-border-color`: `slab` and `emboss` carry `var(--border)`, which is a
 * 9%-alpha hairline meant to sit on a pane of hundreds of pixels. At icon scale that is nothing, and
 * the three bordered shapes would draw alike. The width still comes from the shape, so `极简` and
 * `无界` are borderless here exactly as they are in the shell.
 */
const BORDER_COLOR: Partial<Record<ShapeId, string>> = {
  emboss: "color-mix(in oklab, var(--foreground) 32%, transparent)",
  slab: "color-mix(in oklab, var(--foreground) 60%, transparent)",
};

export function ShapeIcon({
  shape,
  radius,
  className,
}: {
  shape: ShapeId;
  radius: RadiusStop;
  className?: string;
}) {
  const { vars } = resolveShape(shape);
  const extras = EXTRAS[shape] ?? {};
  // Icon scale, not window scale: the drawing has to stay legible, and the point is that the stops are
  // told apart, not that the numbers match the window's.
  const scaled =
    Number.parseFloat(radius) * 16 * ICON.radiusScale;
  const cornerOf = (paneWidth: number) =>
    Math.round(Math.min(scaled, paneWidth * ICON.cornerCap) * 10) / 10;
  const blockCorner = Math.round(scaled * ICON.blockScale * 10) / 10;
  const borderWidth = vars["--pane-border-width"] ?? "0px";
  const bordered = borderWidth !== "0px";
  const borderColor =
    BORDER_COLOR[shape] ??
    "color-mix(in oklab, var(--foreground) 36%, transparent)";

  return (
    <span
      data-shape-icon={shape}
      // The hairline of frame between two panes: what a bordered shape draws its border on.
      data-gap={String(ICON.gutter)}
      className={cn("flex items-stretch overflow-hidden", className)}
      style={{
        width: ICON.width,
        height: ICON.height,
        gap: ICON.gutter,
        padding: extras.inset ? ICON.cloudInset : 0,
        // The window's own corners are DWM's, and every shape keeps them.
        borderRadius: blockCorner,
        background: FRAME_FILL,
        boxShadow: [
          RING,
          extras.card
            ? "0 2px 5px -1px oklch(0 0 0 / 0.4)"
            : extras.contact
              ? "0 1px 2px oklch(0 0 0 / 0.35)"
              : null,
        ]
          .filter(Boolean)
          .join(", "),
        // The lit top edge and the dark bottom one, one device pixel each: the whole of `emboss`.
        borderTop: extras.bevel ? "1px solid oklch(1 0 0 / 0.4)" : undefined,
        borderBottom: extras.bevel ? "1px solid oklch(0 0 0 / 0.4)" : undefined,
        opacity: extras.sheen ? 0.9 : 1,
        position: "relative",
      }}
    >
      {ICON.panes.map((width) => (
        <span
          key={width}
          data-region=""
          style={{
            width,
            // Border inside the declared width: three panes of 8, 12 and 6 have to add up to the box
            // with their gutters, or the row overflows and the last pane is clipped off.
            boxSizing: "border-box",
            borderRadius: cornerOf(width),
            background: extras.sheen ? GLASS_FILL : PANE_FILL,
            // `solid` with a width the shape supplies: 无界 sizes zero and 极简 is borderless, which is
            // exactly the difference the picker has to show.
            borderStyle: "solid",
            borderWidth: bordered ? borderWidth : 0,
            borderColor,
          }}
        />
      ))}
      {extras.weave ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ borderRadius: "inherit", backgroundImage: WEAVE, backgroundSize: "3px 3px" }}
        />
      ) : null}
      {extras.sheen ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-y-2 left-1 w-2 rotate-[24deg] bg-white/30"
        />
      ) : null}
    </span>
  );
}
