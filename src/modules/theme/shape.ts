/**
 * What the shell looks like, as one axis of its own - separate from the colours a theme brings.
 *
 * A theme answers "which colours", a shape answers "how the edges, the borders and the shadows are
 * drawn". They are independent on purpose: `Patterns/emboss with Solarized colours` and
 * `emboss with Dracula colours` are both legitimate, and before this axis existed the only way to
 * get a material was to pick a theme named after it (`acrylic`, Carbon Fiber), which threw the
 * colours away.
 *
 * The nine presets follow ModelHarbor's `style.rs` (`UiStyle`, eight of them, each a combination of
 * corner radius, border width, lit edge, contact shadow, card shadow and a top band), with the
 * material folded in as its own preset instead of being a separate switch - here acrylic has always
 * been a theme, and it is the one shape a CSS variable cannot express on its own.
 *
 * Everything is data. `resolveShape` answers the variables and attributes the stylesheet reads, and
 * writes nothing: the shell stays thin and this stays testable in node. An unknown id answers `soft`,
 * the way `from_key` falls back to its default preset, so a hand-edited theme file with a typo in
 * `shape` still opens.
 */

export type ShapeId =
  | "soft"
  | "fine"
  | "minimal"
  | "tag"
  | "cloud"
  | "emboss"
  | "slab"
  | "band"
  | "glass";

/** The default, and what an unknown id resolves to. */
export const DEFAULT_SHAPE_ID: ShapeId = "soft";

type ShapeValues = {
  /** Corner radius for the shell and everything inside it, in CSS units. */
  radius: string;
  /** Width of the shell's border (`--pane-border-width`; `globals.css` reads it). */
  borderWidth: string;
  /** Any other variable the shape brings along: shadows, highlights, the accent band. */
  vars?: Readonly<Record<string, string>>;
  /**
   * Whether the shape asks for the native material (DWM acrylic on Windows).
   *
   * The one part of a shape CSS cannot draw: the blur happens behind the window, out of reach of the
   * stylesheet, so it travels as an attribute for the shell to act on rather than as a variable.
   */
  material?: boolean;
};

/**
 * The nine presets, in the order they are offered.
 *
 * `soft` is exactly what the shell looked like before this axis existed - `--radius` was 0.625rem,
 * `.verta-pane` drew a 1px border and `--pane-shadow` kept whatever the stylesheet gave it - so a
 * build with no shape preferences is pixel-identical to one from before the axis.
 */
const SHAPES: Readonly<Record<ShapeId, ShapeValues>> = {
  soft: { radius: "0.625rem", borderWidth: "1px" },
  fine: { radius: "0.375rem", borderWidth: "0.5px" },
  minimal: { radius: "0", borderWidth: "0px" },
  tag: { radius: "1.25rem", borderWidth: "0.5px" },
  cloud: {
    radius: "1rem",
    borderWidth: "1px",
    vars: { "--card-shadow": "0 8px 24px oklch(0 0 0 / 0.08)" },
  },
  emboss: {
    radius: "0.5rem",
    borderWidth: "1px",
    vars: {
      // A lit top edge and a dark bottom edge: the pane reads as raised without a shadow that would
      // need a compositing layer.
      "--bevel-top": "inset 0 1px 0 oklch(1 0 0 / 0.10)",
      "--bevel-bottom": "inset 0 -1px 0 oklch(0 0 0 / 0.18)",
    },
  },
  slab: {
    // No lit edge, one flat contact shadow: solid rather than raised.
    radius: "0.375rem",
    borderWidth: "1px",
    vars: { "--pane-shadow": "0 1px 2px oklch(0 0 0 / 0.16)" },
  },
  band: {
    radius: "0.5rem",
    borderWidth: "1px",
    vars: { "--accent-bar": "var(--primary)" },
  },
  glass: { radius: "0.5rem", borderWidth: "1px", material: true },
};

/** Every shape, in the order they are offered. */
export function listShapes(): readonly ShapeId[] {
  return Object.keys(SHAPES) as ShapeId[];
}

/** Whether a value names a shape. */
export function isShapeId(value: unknown): value is ShapeId {
  return typeof value === "string" && value in SHAPES;
}

/** The shape an id names, or `soft` when it names none. */
export function shapeOf(id: unknown): ShapeId {
  return isShapeId(id) ? id : DEFAULT_SHAPE_ID;
}

export type ShapeOptions = {
  /**
   * The radius the theme itself asks for, when it declares one.
   *
   * A theme that spells `colors.radius` has been saying something about its corners since before this
   * axis existed, and fifteen declarations in eight built-in themes do. The theme wins: a shape is a
   * suggestion about geometry, and a palette that deliberately squares its corners should not be
   * squared differently because a default shape was in force.
   */
  themeRadius?: string;
};

export type ResolvedShape = {
  /** CSS variables to write on the document element. */
  vars: Readonly<Record<string, string>>;
  /** Attributes to write on the document element, which the stylesheet keys off. */
  attrs: Readonly<Record<string, string>>;
};

/**
 * The variables and attributes a shape is made of.
 *
 * Pure: it writes nothing. The caller (`applyShape`) is the thin cell that touches the document, and
 * it is the only part of this that cannot be tested in node.
 */
export function resolveShape(
  id: unknown,
  options: ShapeOptions = {},
): ResolvedShape {
  const key = shapeOf(id);
  const shape = SHAPES[key];
  const vars: Record<string, string> = {
    "--pane-border-width": shape.borderWidth,
  };
  // Only when the theme is not already saying it: both write the same inline property on the same
  // element, so this is a precedence question, not a merge.
  if (!options.themeRadius) vars["--radius"] = shape.radius;
  for (const [name, value] of Object.entries(shape.vars ?? {})) vars[name] = value;
  const attrs: Record<string, string> = { "data-shape": key };
  if (shape.material) attrs["data-shape-material"] = "native";
  return { vars, attrs };
}
