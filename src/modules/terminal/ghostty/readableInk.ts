/**
 * Ink that is so close to its own background that it stops being text.
 *
 * A terminal draws what a program asks for, and a program that assumes a dark page writes ink for a
 * dark page. opencode is one: its default theme is built dark (`background.base = neutral.800`,
 * `text.base = neutral.200`), so on Verta's white paper its secondary lines came out `#eeeeee` -
 * measured on the running app, 1.16:1, which is a smudge rather than a sentence. Nothing else is
 * wrong with it there: its body text is `#808080` (3.95:1) and its accents are coloured.
 *
 * A cell whose ink cannot be told apart from the paper behind it is pulled toward the page's own
 * extreme - black on a light page, white on a dark one - until it clears `INK_FLOOR`. Nothing else
 * moves: the threshold is 1.5:1, so a colour that was *meant* to be quiet (a 1.6:1 shade, a subtle
 * border) keeps its value, and any ink above the threshold keeps its hue exactly.
 *
 * The cell's own background is the reference, not the theme's page, so a light ink on a dark chip, or
 * dark ink on a selection, is judged against what it actually sits on and left alone.
 */

/**
 * Below this, a colour is not drawing text. 1.5:1 is roughly the point where a mark on a screen stops
 * being recognisable as a glyph; anything above it is a design decision and is left to the program.
 */
export const INVISIBLE_INK = 1.5;

/** The same AA floor a faint cell is held to: rescued ink is still text. */
export const INK_FLOOR = 4.5;

/** A paper above this luminance is light, and its rescues go darker. */
const LIGHT_PAPER = 0.4;

const rescues = new Map<number, number>();
const luminances = new Map<number, number>();

function channels(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** WCAG relative luminance of a packed `0xRRGGBB` colour, cached: a screen reuses few colours. */
function luminance(color: number): number {
  const known = luminances.get(color);
  if (known !== undefined) return known;
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (luminances.size > 4096) luminances.clear();
  luminances.set(color, value);
  return value;
}

function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function mixed(ink: number, towards: number, amount: number): number {
  const from = channels(ink);
  const onto = channels(towards);
  const [r, g, b] = from.map((value, i) =>
    Math.round(onto[i] + (value - onto[i]) * (1 - amount)),
  );
  return (r << 16) | (g << 8) | b;
}

/**
 * `ink` made readable on `paper`, both packed `0xRRGGBB`.
 *
 * Returns `ink` itself whenever it is already distinguishable, which is almost every cell on a
 * screen; the returned value is the same number in that case, so callers can compare cheaply.
 */
export function readableInk(ink: number, paper: number): number {
  const key = ink * 0x1000000 + paper;
  const known = rescues.get(key);
  if (known !== undefined) return known;

  const paperLuminance = luminance(paper);
  let answer = ink;
  if (ratio(luminance(ink), paperLuminance) < INVISIBLE_INK) {
    const towards = paperLuminance > LIGHT_PAPER ? 0x000000 : 0xffffff;
    answer = towards;
    // 2% steps, the same grain `readableNeutrals` uses: the first colour that clears the floor is the
    // one that keeps as much of the program's own ink as the page allows.
    for (let step = 2; step <= 100; step += 2) {
      const candidate = mixed(ink, towards, step / 100);
      if (ratio(luminance(candidate), paperLuminance) >= INK_FLOOR) {
        answer = candidate;
        break;
      }
    }
  }
  if (rescues.size > 512) rescues.clear();
  rescues.set(key, answer);
  return answer;
}
