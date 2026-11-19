/**
 * How much of its ink a `\e[2m` cell is allowed to give back to the paper.
 *
 * Ghostty draws a faint cell by mixing its colour toward the background at a fixed 50%, which is a
 * dark-paper idiom: half of a near-white ink over near-black still reads as grey text. On a light
 * paper the same 50% is half of a near-black ink over white, and everything that was already muted
 * collapses. Measured on the running app in light mode, with a terminal holding one sample per line:
 *
 *   truecolor #1f1e1d      -> #1f1e1d  16.64:1
 *   \e[2m at 50%           -> #8d8d8d   3.32:1
 *   truecolor #808080      -> #808080   3.95:1
 *   \e[2m over #808080     -> #c2c2c2   1.78:1
 *
 * The last line is what opencode's secondary text looked like: a muted grey asked for twice, and a
 * page of it was unreadable. So the fix keeps the dark paper's answer exactly and only steps the mix
 * back where the paper cannot pay for it: a faint cell is dimmed as far as it can go while the result
 * still clears `FAINT_FLOOR` against its own background. A colour that cannot clear the floor even at
 * full strength is drawn at full strength, because dimming it further only makes it worse.
 *
 * On the theme this was reported against, `#f7f7f7` on `#141414` is already 5.06:1 at 50%, so the
 * dark theme's ordinary faint text does not move at all; what moves there is a faint over an ink that
 * was muted to begin with (`#808080` on `#141414`: 2.08:1 -> 4.54:1), which is the same complaint.
 */

/** WCAG AA for body text. Faint ink is still text: it is where secondary content is drawn. */
export const FAINT_FLOOR = 4.5;

/** The dimming a dark paper has always had, and the dimmest a cell is ever drawn. */
export const DARKEST_FAINT = 0.5;

/** Steps between `DARKEST_FAINT` and 1, matching the 2% steps `readableNeutrals` uses. */
const STEPS = 25;

const cache = new Map<number, number>();

function channels(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** WCAG relative luminance of a packed `0xRRGGBB` colour. */
function luminance(color: number): number {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two luminances: `(lighter + 0.05) / (darker + 0.05)`. */
function ratio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `ink` mixed `alpha` of the way over `paper`, in the 8-bit space the renderer blends in.
 *
 * The model has to be the blend the glyph actually gets, not the arithmetic one: mixing in linear
 * light would call a mix readable that the framebuffer then draws darker.
 */
function mixed(ink: number, paper: number, alpha: number): number {
  const from = channels(ink);
  const onto = channels(paper);
  const [r, g, b] = from.map((value, i) => Math.round(onto[i] + (value - onto[i]) * alpha));
  return (r << 16) | (g << 8) | b;
}

/**
 * The alpha a faint glyph of `ink` is drawn with on `paper`, both packed `0xRRGGBB`.
 *
 * `1` means "do not dim this one": either the ink is already unreadable on this paper, or it is
 * exactly the floor and any dimming would cross it.
 */
export function faintAlpha(ink: number, paper: number): number {
  const key = ink * 0x1000000 + paper;
  const known = cache.get(key);
  if (known !== undefined) return known;

  const paperLuminance = luminance(paper);
  let answer = 1;
  for (let step = 0; step <= STEPS; step += 1) {
    const alpha = DARKEST_FAINT + ((1 - DARKEST_FAINT) * step) / STEPS;
    const drawn = ratio(luminance(mixed(ink, paper, alpha)), paperLuminance);
    if (drawn >= FAINT_FLOOR) {
      answer = alpha;
      break;
    }
  }
  // A screen holds a handful of inks; this only exists so the step search runs once per pair, and the
  // cap keeps a pathological program from growing it without bound.
  if (cache.size > 512) cache.clear();
  cache.set(key, answer);
  return answer;
}
