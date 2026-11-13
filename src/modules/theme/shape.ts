/**
 * What the shell looks like, as one axis of its own - separate from the colours a theme brings.
 *
 * A theme answers "which colours", a shape answers "how the edges, the borders and the shadows are
 * drawn". They are independent on purpose: `Patterns/emboss with Solarized colours` and
 * `emboss with Dracula colours` are both legitimate, and before this axis existed the only way to
 * get a material was to pick a theme named after it (`acrylic`, Carbon Fiber), which threw the
 * colours away.
 *
 * The six presets follow ModelHarbor's `style.rs` (`UiStyle`; each is a combination of corner
 * radius, border width, lit edge, contact shadow and card shadow), with two departures: the radius is
 * not here at all - it is an axis of its own, see `radius.ts` - and the material is a preset rather
 * than a separate switch, because it is the one part of a shape a CSS variable cannot express.
 *
 * Everything is data. `resolveShape` answers the variables and attributes the stylesheet reads, and
 * writes nothing: the shell stays thin and this stays testable in node. An unknown id answers `soft`,
 * the way `from_key` falls back to its default preset, so a hand-edited theme file with a typo in
 * `shape` still opens.
 */

import type { MessageKey } from "@/modules/i18n";

export type ShapeId = "boundless" | "minimal" | "cloud" | "emboss" | "slab" | "glass";

/**
 * The default, and what an unknown id resolves to.
 *
 * `minimal` because decoration is opt-in: a shape the user has not chosen should not paint anything,
 * and the four that remain all add something (a shadow, a lit edge, a material).
 */
export const DEFAULT_SHAPE_ID: ShapeId = "minimal";

/**
 * "Let the theme decide" - the value the preference holds until someone chooses.
 *
 * A shape the user picked is a decision and outlives a change of theme; with nothing picked, a theme
 * is allowed to suggest one (`Theme.shape`). Storing the choice as `auto` rather than defaulting to
 * `soft` is what keeps those two apart: `soft` is a shape someone may have chosen on purpose.
 */
export const SHAPE_AUTO = "auto";

/** What the preference stores: a chosen shape, or `auto` to follow the theme. */
export type ShapePref = ShapeId | typeof SHAPE_AUTO;

type ShapeValues = {
  /** Width of the shell's border (`--pane-border-width`; `globals.css` reads it). */
  borderWidth: string;
  /**
   * Colour of that border.
   *
   * A width alone cannot carry a difference: a browser draws borders in whole device pixels and never
   * thinner than one, so at 100% scale a declared 0.5px is used as 1px and `fine` looked exactly like
   * `soft` next to it. The colour is what makes the thinner presets visible.
   */
  borderColor: string;
  /** Any other variable the shape brings along: shadows, highlights, the accent band. */
  vars?: Readonly<Record<string, string>>;
  /** Attributes beyond `data-shape`: the glass layer, for the one shape that turns it on. */
  attrs?: Readonly<Record<string, string>>;
  /**
   * Whether the shape asks for the native material (DWM acrylic on Windows).
   *
   * The one part of a shape CSS cannot draw: the blur happens behind the window, out of reach of the
   * stylesheet, so it travels as an attribute for the shell to act on rather than as a variable.
   */
  material?: boolean;
};

/**
 * The six presets, in the order they are offered.
 *
 * `minimal` is what the shell looks like when nobody has chosen anything: no border, no shadow, no
 * material. Decoration is opt-in here, which is why the default is the one preset that draws nothing.
 */
const SHAPES: Readonly<Record<ShapeId, ShapeValues>> = {
  // The three regions of the window - the sidebar, the workspace and the right panel - become one
  // surface: no border, and no gutter between them either (`globals.css` closes it, and puts the
  // radius on the merged block's outer frame rather than on each region - two rounded corners meeting
  // along a seam that no longer exists would leave the frame showing through the notch between them).
  // The window's own corners stay DWM's, which no shape may touch.
  boundless: {
    borderWidth: "0px",
    borderColor: "transparent",
  },
  minimal: { borderWidth: "0px", borderColor: "transparent" },
  cloud: {
    // A floating card. The panes step in from the frame for this shape (`globals.css`), which is what
    // the shadow needs: a pane that meets the header and the status bar flush has nowhere to cast one,
    // so the shadow used to land outside the panel box and be clipped - and the shape read as `minimal`
    // with a slightly fainter border, which is not a shape, it is a rounding error.
    borderWidth: "1px",
    borderColor: "color-mix(in oklab, var(--border) 70%, transparent)",
    vars: {
      "--pane-shadow":
        "0 10px 24px -10px oklch(0 0 0 / 0.45), 0 2px 6px -2px oklch(0 0 0 / 0.18)",
      // Cards inside the panes keep the softer lift they had.
      "--card-shadow": "0 8px 24px oklch(0 0 0 / 0.08)",
    },
  },
  emboss: {
    borderWidth: "1px",
    borderColor: "var(--border)",
    vars: {
      // A raised plate: lit along the top *and* the left, shaded along the bottom *and* the right, with
      // a 2px band under the 1px dark edge so the bottom reads as an edge with depth.
      //
      // The first version was one 1px line each way, at 10% and 18%. On a dark theme that is a hairline
      // on a hairline - measured against 极简, which draws no border at all, the two looked the same,
      // which is what "浮雕 looks like 极简" was reporting. A light has a side, and an edge has
      // thickness; both are paint, so neither costs a compositing layer (`compositingBudget.test.ts`).
      "--bevel-top":
        "inset 0 1px 0 oklch(1 0 0 / 0.18), inset 1px 0 0 oklch(1 0 0 / 0.07)",
      "--bevel-bottom":
        "inset 0 -2px 0 oklch(0 0 0 / 0.16), inset 0 -1px 0 oklch(0 0 0 / 0.34), inset -1px 0 0 oklch(0 0 0 / 0.15)",
    },
  },
  slab: {
    // No lit edge, one flat contact shadow and a heavier border: solid rather than raised.
    borderWidth: "1px",
    borderColor: "color-mix(in oklab, var(--border) 60%, var(--foreground))",
    vars: { "--pane-shadow": "0 1px 2px oklch(0 0 0 / 0.16)" },
  },
  glass: {
    borderWidth: "1px",
    borderColor: "color-mix(in oklab, var(--border) 70%, transparent)",
    material: true,
    // The acrylic recipe, which used to live in the `Acrylic` theme: a thin tint over the material
    // DWM draws behind the window, since the desktop already supplies most of the texture and a
    // heavy tint degrades acrylic into a plain translucent panel.
    //
    // The terminal's own background goes with it: a terminal painted with the theme's colour is a
    // solid rectangle in the middle of a translucent window, which is the one place acrylic looked
    // broken. Alpha zero means the terminal paints no base colour at all, so what a TUI writes stays
    // readable while everything it leaves alone shows the material - the same thing the `Acrylic`
    // theme did with `terminal.background: "rgba(21, 27, 32, 0)"`.
    vars: {
      "--theme-frame-opacity": "0.24",
      "--theme-pane-opacity": "0.28",
      "--theme-glass-edge": "0.3",
      "--theme-glass-sheen": "0.12",
      "--terminal-background": "transparent",
    },
    attrs: { "data-theme-glass": "on" },
  },
};
/** Every shape, in the order they are offered. */
export function listShapes(): readonly ShapeId[] {
  return Object.keys(SHAPES) as ShapeId[];
}

/**
 * The label each shape goes by, in one place because two pickers offer them now - the settings
 * section and the command palette - and a preset that ships without a name in either is a bug the
 * type checker can catch here.
 */
export const SHAPE_LABELS: Readonly<Record<ShapeId, MessageKey>> = {
  boundless: "settings.shape.boundless",
  minimal: "settings.shape.minimal",
  cloud: "settings.shape.cloud",
  emboss: "settings.shape.emboss",
  slab: "settings.shape.slab",
  glass: "settings.shape.glass",
};

/** Whether a value names a shape. */
export function isShapeId(value: unknown): value is ShapeId {
  return typeof value === "string" && value in SHAPES;
}

/** The shape an id names, or `soft` when it names none. */
export function shapeOf(id: unknown): ShapeId {
  return isShapeId(id) ? id : DEFAULT_SHAPE_ID;
}

/**
 * Which shape is actually in force.
 *
 * `auto` (and anything that is not a stored value at all) leaves it to the theme, which may suggest
 * one in `Theme.shape`; a chosen shape wins over the suggestion and survives a change of theme. An
 * unknown suggestion is the same as none.
 */
export function resolveShapePref(pref: unknown, themeShape: unknown): ShapeId {
  if (pref === undefined || pref === null || pref === SHAPE_AUTO) {
    return shapeOf(themeShape);
  }
  return shapeOf(pref);
}

/** Whether a stored value is one this axis understands. */
export function isShapePref(value: unknown): value is ShapePref {
  return value === SHAPE_AUTO || isShapeId(value);
}

export type ShapeOptions = {
  /**
   * The glass recipe the theme itself asks for, when it has one.
   *
   * The shape can bring its own (that is what makes acrylic a shape), but a theme that already
   * describes its glass - a custom theme file can - is not overruled by it. When this is present the
   * shape's own glass values and the `data-theme-glass` attribute are left to the theme.
   */
  themeGlass?: boolean;
  /**
   * The theme's own terminal background, so a shape that clears it can put it back.
   *
   * Only the material needs this: `glass` makes the terminal transparent, and switching away has to
   * restore the colour the theme asked for rather than leaving the terminal see-through.
   */
  themeTerminal?: string;
};

export type ResolvedShape = {
  /** CSS variables to write on the document element. */
  vars: Readonly<Record<string, string>>;
  /** Attributes to write on the document element, which the stylesheet keys off. */
  attrs: Readonly<Record<string, string>>;
  /** Whether this shape asks for the native material, which the window has to be told about. */
  material: boolean;
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
    "--pane-border-color": shape.borderColor,
  };
  if (shape.material) {
    // Already in `vars` as `transparent`; nothing to do, kept for the reader.
  } else if (options.themeTerminal) {
    vars["--terminal-background"] = options.themeTerminal;
  }
  for (const [name, value] of Object.entries(shape.vars ?? {})) vars[name] = value;
  if (options.themeGlass) {
    for (const name of Object.keys(shape.vars ?? {})) {
      if (name.startsWith("--theme-")) delete vars[name];
    }
  }
  const attrs: Record<string, string> = { "data-shape": key };
  for (const [name, value] of Object.entries(shape.attrs ?? {})) {
    if (options.themeGlass && name === "data-theme-glass") continue;
    attrs[name] = value;
  }
  if (shape.material) attrs["data-shape-material"] = "native";
  return { vars, attrs, material: Boolean(shape.material) };
}
