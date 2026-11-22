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

export type ShapeId =
  | "minimal"
  | "cloud"
  | "emboss"
  | "slab"
  | "carbon"
  | "acrylic"
  | "glass";

/**
 * What a shape asks the window for.
 *
 * `acrylic` is a material the system draws: the desktop really shows through, blurred and lightly
 * tinted, so the pane keeps a frost of its own. `clear` asks for no material at all - the window is
 * left see-through and the desktop is read as it is, sharp, which is what a pane of glass does.
 */
export type ShapeMaterial = "acrylic" | "clear";

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
   * The material the shape asks for, or nothing.
   *
   * The one part of a shape CSS cannot draw: the blur behind an acrylic window happens out of reach
   * of the stylesheet, so it travels as an attribute for the shell to act on rather than as a
   * variable. `clear` is the other half of the same switch - still see-through, but with nothing
   * drawn behind the pane.
   */
  material?: ShapeMaterial;
};

/**
 * The values the `acrylic` preset ships with.
 *
 * A thin tint over a material the system draws: the desktop already supplies most of the texture, and
 * a heavy tint degrades acrylic into a plain translucent panel.
 */
export const ACRYLIC_DEFAULT_PARAMS: Readonly<GlassParams> = {
  paneOpacity: 0.2,
  edge: 0,
  sheen: 0.15,
};

/**
 * The values the `glass` preset ships with.
 *
 * Tuned on a real desktop rather than derived: with nothing blurred behind the pane, a very low
 * opacity reads as an unreadable sheet over a busy wallpaper, and the numbers the eye settled on are
 * close to the acrylic recipe's (30% of the pane's own colour, a 0.3 edge, a 0.15 sheen).
 */
export const GLASS_DEFAULT_PARAMS: Readonly<GlassParams> = {
  paneOpacity: 0.3,
  edge: 0.3,
  sheen: 0.15,
};

/**
 * The numbers a material shape draws with, which are also what "restore defaults" writes back.
 *
 * They live beside the presets rather than in the settings store so the two cannot drift: the sliders
 * reset to what the shape in force actually draws with, not to a second copy of the numbers.
 */
export function defaultGlassParamsFor(id: unknown): GlassParams {
  return shapeOf(id) === "acrylic"
    ? { ...ACRYLIC_DEFAULT_PARAMS }
    : { ...GLASS_DEFAULT_PARAMS };
}

/**
 * The six presets, in the order they are offered.
 *
 * `minimal` is what the shell looks like when nobody has chosen anything: no border, no shadow, no
 * material. Decoration is opt-in here, which is why the default is the one preset that draws nothing.
 */
const SHAPES: Readonly<Record<ShapeId, ShapeValues>> = {
  minimal: { borderWidth: "0px", borderColor: "transparent" },
  cloud: {
    // A floating card, and the one preset whose shadow leaves its own box.
    //
    // Two wrong turns are recorded here. The panes used to step in from the frame (6px, then 12px) so the
    // shadow had somewhere to fall - which took display area for a shape whose point is that the card sits
    // *on* the window ("显示区域为了悬浮怎么越来越小了"). And the shadow was then tuned tight to fit the
    // 6px it had, which is not a float either. Now the area is the one 极简 has - the same pane box,
    // measured - and the wrappers between the pane and the shell stop clipping it (`globals.css`), so the
    // shadow spills out over the frame instead of being fed from the content.
    borderWidth: "1px",
    borderColor: "color-mix(in oklab, var(--border) 70%, transparent)",
    vars: {
      // One geometry, mirrored onto all four sides - the same numbers the 无界 sheet uses, so the preset
      // reads the same whether the panes are separate cards or one sheet. A downward-only shadow was the
      // first version and it read as a card lying on the frame: the edges with no shadow are the edges the
      // eye stops at, and a float with three flat sides is a table. The top hairline comes along because
      // this shape replaces `--pane-shadow`, so it has to bring it.
      //
      // The spread is **positive**, and that is the fix for "云朵形态在圆角阴影上还是不行". It used to be
      // `-8px`, which shrinks the shadow's own shape: a shadow is the element's box inflated by `spread`
      // and rounded by the same radius, so a negative spread took 8px off the radius too - on the default
      // 14px pane radius the shadow was drawn with a 6px corner, and the four corners of a 14px card came
      // out with a shadow that stopped short of the arc. That is exactly what was reported, and it showed
      // at the corners only, because the straight edges still had a shadow beside them.
      //
      // The rule the preset is held to: the shadow's corner must be at least as round as the pane's. A
      // positive spread can only make it rounder, so it holds at every radius the axis offers, including
      // `0` (where a square shadow is right). The blur is what keeps it from reading as a hard rim.
      //
      // The ink and the weight are the stylesheet's, not the preset's: one alpha cannot serve both modes
      // ("阴影过重，亮色下或许突兀" - `oklch(0 0 0 / 0.5)` measured 19/255 next to the card on this dark
      // theme and 65 on its light variant, where the frame is 225). `--float-shadow-ink` is defined per
      // mode in `globals.css`, and the sheet under 无界 reads the same variable, so the two cannot drift.
      "--pane-shadow":
        "inset 0 1px 0 oklch(1 0 0 / 0.1), 0 10px 22px 1px var(--float-shadow-ink), 0 -10px 22px 1px var(--float-shadow-ink), 10px 0 22px 1px var(--float-shadow-ink), -10px 0 22px 1px var(--float-shadow-ink)",
      // Cards inside the panes keep the softer lift they had.
      "--card-shadow":
        "0 12px 28px -10px oklch(0 0 0 / 0.3), 0 3px 8px -4px oklch(0 0 0 / 0.16)",
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
      // Stronger than the first pass: at 18% and 16% the plate read as `slab` with a slightly
      // different shadow, which is what "浮雕和石板还是差不多" was reporting. A lit edge has to be
      // visibly brighter than the surface and a dark one visibly darker, so both went up, and the
      // bottom band got a third line so the edge has thickness rather than a single hairline.
      // Four pieces, not two. The horizontal pair is what every pane paints; the vertical pair is what
      // 无界 has to drop, because a vertical line at each pane's edge is a divider inside a sheet that has
      // none (see the boundless rules in `globals.css`).
      //
      // They used to be two lists with the verticals appended, and the sheet carried a hand-written copy
      // of the whole recipe - which is what "浮雕和极简差不多" was looking at: under 无界 the copy was the
      // older, weaker pass (1px at 18%) and had drifted a full revision behind the preset it was supposed
      // to be showing. Split, the sheet reads the same numbers as the bordered shapes.
      // Three steps of light and three of shade, because one step of each is a hairline: at 100% zoom a
      // 1px bright line and a 2px dark band are the same weight as the border they sit inside, which is
      // what made 浮雕 and 极简 hard to tell apart. The bands are what give the plate a lit face and a
      // shaded one at a glance; the 1px pair at the very edge is the sharpest of the three.
      "--bevel-top":
        "inset 0 1px 0 oklch(1 0 0 / 0.5), inset 0 3px 0 oklch(1 0 0 / 0.24), inset 0 6px 0 oklch(1 0 0 / 0.1)",
      "--bevel-bottom":
        "inset 0 -6px 0 oklch(0 0 0 / 0.16), inset 0 -3px 0 oklch(0 0 0 / 0.34), inset 0 -2px 0 oklch(0 0 0 / 0.5), inset 0 -1px 0 oklch(0 0 0 / 0.68)",
      "--bevel-left": "inset 1px 0 0 oklch(1 0 0 / 0.18)",
      "--bevel-right": "inset -1px 0 0 oklch(0 0 0 / 0.3)",
      // The lip: a dark line *outside* the bottom edge, under the bands that are inside it. Without it
      // the plate is a lit rectangle - the light says where the surface starts, the lip says it is
      // standing on something. It is the one part of the recipe that is not inset, so it is its own
      // variable: 无界 keeps it (the sheet's bottom is the plate's bottom too) while the sides stay put.
      "--bevel-lip": "0 2px 0 oklch(0 0 0 / 0.34)",
    },
  },
  slab: {
    // A plate lying on the surface: no lit edge, a heavy border, and the contact shadow ModelHarbor
    // gives this preset (`has_contact_shadow`) - a dark edge offset toward the bottom-right rather
    // than a soft blur. A 1px blur at 16% was invisible next to `minimal`, which is what "石板和极简
    // 变成一样了" was reporting; the offset edge is what says "this is a solid slab sitting on the
    // window".
    //
    // How it stays apart from 浮雕, which is the other "plate" preset: the two are opposites, not
    // degrees. 浮雕 is the surface itself raised - the light is *inside* the pane (inset bands) and
    // nothing is cast outside it; 石板 is a separate block *on* the surface - nothing inside it is lit,
    // and the only thing it paints is outside: the outline and the step. So the border got thicker
    // (2px, a cut edge rather than a drawn line), the step got its own floor, and the faint blur that
    // used to sit under the offsets is gone - a slab's shadow is the block, not fog under it.
    borderWidth: "2px",
    borderColor: "color-mix(in oklab, var(--border) 45%, var(--foreground))",
    vars: {
      // The offsets are the shape's *thickness*, and thickness is what a radius implies: a block whose
      // corners are cut 16px deep is a thicker block than one cut 4px, so `1px 1px` for both made the
      // preset look like the same slab at every radius. They are read off `--radius` instead (the
      // user's own corner stop, see `radius.ts`), with a floor: at the default 10px radius the old
      // numbers were a 2px step, which is a line rather than a thickness.
      "--slab-offset": "max(4px, calc(var(--radius) * 0.4))",
      "--slab-lift": "max(6px, calc(var(--radius) * 0.6))",
      // The step is cast outside the pane and needs a gutter to fall in; the *cut faces* are inside it,
      // where they cost no display area. They are the two edges the light is not on - the mirror of 浮雕,
      // which lights its top and shades its bottom: this one has no light anywhere and shades the pair it
      // is standing on. (A border could not carry them: the sheet paints the pane's borders over in 无界,
      // and a per-side colour copied into the sheet's rules is the drift this file already warns about.)
      "--pane-shadow":
        "var(--slab-offset) var(--slab-offset) 0 oklch(0 0 0 / 0.4), var(--slab-lift) var(--slab-lift) 0 oklch(0 0 0 / 0.2), 0 2px 0 oklch(0 0 0 / 0.28)",
      // Their own variable because 无界 has to drop them from the regions that are not the sheet's right
      // edge: a cut face on every region is a line between two of them ("石板…会话和终端组件之间有间隔线").
      "--slab-cut": "inset -3px 0 0 oklch(0 0 0 / 0.3), inset 0 -3px 0 oklch(0 0 0 / 0.42)",
    },
  },
  carbon: {
    // The weave, which used to be the `Carbon Fiber` theme's own surface and was taken away with it
    // when "the shape owns the material, the theme owns the colours" split the two axes. It is paint,
    // not a bitmap: a pair of crossed repeating gradients, so it costs no resource to ship and no
    // compositing layer to draw (`compositingBudget.test.ts`).
    //
    // Two directions at 135deg and 45deg, one brighter than the other: a single gradient is a set of
    // parallel lines, which is corduroy, not woven cloth - the crossing is what the eye reads as a
    // fibre. The colour is mixed from `--foreground` so it follows a light theme as well as a dark one.
    //
    // The strength is set by where the fabric is seen, not by what looks right in a swatch: the frame
    // paints `--frame` over it at 55% while vibrancy is on, so a 7% line arrives at about 3% - measured
    // on the running app, 8x crops of the window margin were flat black at 7% and at 20%. 35% and 18%
    // at a 6px pitch read as cloth through that tint, and 50% overshoots into a visible pattern on the
    // header.
    //
    // Its variables are `--shape-surface-*`, not the theme's: a theme that draws a surface of its own
    // and this shape must not clear one another, and the stylesheet keeps them apart for that reason.
    borderWidth: "0px",
    borderColor: "transparent",
    vars: {
      // The window still has a floor: the weave is a pattern over the theme's own background, not a
      // see-through material (that is `亚克力` / `玻璃`).
      "--shape-surface-background": "var(--background)",
      "--shape-surface-image":
        "repeating-linear-gradient(135deg, color-mix(in oklab, var(--foreground) 35%, transparent) 0 1px, transparent 1px 6px), repeating-linear-gradient(45deg, color-mix(in oklab, var(--foreground) 18%, transparent) 0 1px, transparent 1px 6px)",
      "--shape-surface-size": "6px 6px",
      "--shape-surface-repeat": "repeat",
    },
    // The switch the stylesheet keys the drawing off. An attribute rather than a variable, because a
    // drawing that is not asked for must not leave a `background-image` behind to be applied by
    // accident - the same reason the material travels as `data-shape-material`.
    attrs: { "data-shape-surface": "weave" },
  },
  acrylic: {
    borderWidth: "1px",
    borderColor: "color-mix(in oklab, var(--border) 70%, transparent)",
    material: "acrylic",
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
      "--theme-pane-opacity": `${ACRYLIC_DEFAULT_PARAMS.paneOpacity}`,
      "--theme-glass-edge": `${ACRYLIC_DEFAULT_PARAMS.edge}`,
      "--theme-glass-sheen": `${ACRYLIC_DEFAULT_PARAMS.sheen}`,
      "--terminal-background": "transparent",
    },
    attrs: { "data-theme-glass": "on" },
  },
  glass: {
    // The same layer as `acrylic` with nothing drawn behind it: the window is left see-through and
    // the desktop is read sharp, which is the difference between a pane of glass and a sheet of
    // frosted plastic. Both numbers that carry the pane's own colour sit near zero, and the edge and
    // sheen are stronger, because with no frost to catch the light they are all that says a surface
    // is there.
    borderWidth: "1px",
    borderColor: "color-mix(in oklab, var(--border) 55%, transparent)",
    material: "clear",
    vars: {
      "--theme-frame-opacity": "0.06",
      "--theme-pane-opacity": `${GLASS_DEFAULT_PARAMS.paneOpacity}`,
      "--theme-glass-edge": `${GLASS_DEFAULT_PARAMS.edge}`,
      "--theme-glass-sheen": `${GLASS_DEFAULT_PARAMS.sheen}`,
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
  minimal: "settings.shape.minimal",
  cloud: "settings.shape.cloud",
  emboss: "settings.shape.emboss",
  slab: "settings.shape.slab",
  carbon: "settings.shape.carbon",
  acrylic: "settings.shape.acrylic",
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
  /**
   * The user's own numbers for the glass layer.
   *
   * The two material shapes ship a recipe each, but the recipe is the one part of a shape that people
   * want to tune: how much colour the pane keeps, how bright the edge is, how strong the sheen. Left
   * out, the shape's own values stand (a probe or an icon asks for none); given, they win, except when
   * the theme carries its own glass.
   */
  glass?: GlassParams;
};

/** The three numbers the glass layer is tuned with. */
export type GlassParams = {
  paneOpacity: number;
  edge: number;
  sheen: number;
};

/** Which shapes draw the glass layer, so a settings screen knows when to offer the sliders. */
export function shapeUsesGlass(id: unknown): boolean {
  return Boolean(SHAPES[shapeOf(id)].material);
}

export type ResolvedShape = {
  /** CSS variables to write on the document element. */
  vars: Readonly<Record<string, string>>;
  /** Attributes to write on the document element, which the stylesheet keys off. */
  attrs: Readonly<Record<string, string>>;
  /** Whether this shape draws the glass layer, which the window has to be told about. */
  material: ShapeMaterial | null;
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
  // The theme's own glass wins over the sliders, for the same reason it wins over the shape's recipe:
  // a theme file that describes its glass is a more specific statement than a global preference.
  if (options.glass && shape.material && !options.themeGlass) {
    vars["--theme-pane-opacity"] = `${options.glass.paneOpacity}`;
    vars["--theme-glass-edge"] = `${options.glass.edge}`;
    vars["--theme-glass-sheen"] = `${options.glass.sheen}`;
  }
  if (shape.material) attrs["data-shape-material"] = shape.material;
  return { vars, attrs, material: shape.material ?? null };
}
