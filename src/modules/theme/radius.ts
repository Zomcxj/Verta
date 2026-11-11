/**
 * The corner radius, as an axis of its own.
 *
 * A theme answers "which colours", a shape answers "how the edges, the borders and the shadows are
 * drawn", and this answers "how round". It used to be part of the shape presets, which made two
 * unrelated things one decision: wanting rounder corners meant giving up the lit edge, the material
 * or the merged shell, and the shape decided the corner of every card and input in the app.
 *
 * The number is global. `globals.css` derives `--radius-sm` ... `--radius-4xl` from `--radius`, and
 * `--pane-radius` is `--radius * 1.4`, so this one value is every corner a person can see.
 *
 * The stops are discrete - a gear lever, not a dial - and the *value* is what gets stored rather
 * than its position, so a stop added or removed later still leaves a stored choice resolvable. The
 * set covers every radius the presets used to carry (0, 6, 8, 10 and 16 px), so no saved look is
 * lost, and the default is the value the stylesheet had before this axis existed.
 */
export const RADIUS_STOPS = [
  "0",
  "0.25rem",
  "0.375rem",
  "0.5rem",
  "0.625rem",
  "0.875rem",
  "1rem",
] as const;

export type RadiusStop = (typeof RADIUS_STOPS)[number];

/** Square-cornered is a stop, not an absence: `0` is a value someone can choose on purpose. */
export const DEFAULT_RADIUS: RadiusStop = "0.625rem";

/** Whether a value is one of the stops. */
export function isRadiusStop(value: unknown): value is RadiusStop {
  return (
    typeof value === "string" && (RADIUS_STOPS as readonly string[]).includes(value)
  );
}

/** The stop a value names, or the default when it names none. */
export function radiusOf(value: unknown): RadiusStop {
  return isRadiusStop(value) ? value : DEFAULT_RADIUS;
}

/** Where a stop sits on the slider, which is what the control works in. */
export function radiusStopIndex(stop: unknown): number {
  return RADIUS_STOPS.indexOf(radiusOf(stop));
}

export type ResolvedRadius = {
  /** CSS variables to write on the document element. */
  vars: Readonly<Record<string, string>>;
};

/**
 * The variables a radius is made of.
 *
 * Pure, and deliberately tiny: one variable, because the stylesheet already derives everything else
 * from it. The caller (`applyRadius`) is the thin cell that touches the document.
 */
export function resolveRadius(stop: unknown): ResolvedRadius {
  return { vars: { "--radius": radiusOf(stop) } };
}
