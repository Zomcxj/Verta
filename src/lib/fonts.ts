const NERD_FONT_CANDIDATES = [
  "JetBrainsMono Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMonoNL Nerd Font",
  "FiraCode Nerd Font",
  "FiraCode Nerd Font Mono",
  "MesloLGS NF",
  "MesloLGM Nerd Font",
  "Hack Nerd Font",
  "Hack Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "Iosevka Nerd Font",
  "Iosevka Term Nerd Font",
  "SauceCodePro Nerd Font",
  "Hasklug Nerd Font",
];

/**
 * The CJK tail of every stack.
 *
 * The fonts people pick for code (Cascadia Mono, JetBrains Mono, Fira Code) carry
 * Latin, Greek and Cyrillic only, not one Han glyph. Without an explicit CJK
 * entry the browser falls through to whatever the system offers for those
 * characters, which is usually a proportional UI face: the Latin text changes
 * when the font changes and the Chinese does not, and mixed lines stop lining
 * up. Naming the CJK faces in order keeps the Chinese stable and stays
 * monospaced, whichever Latin font is chosen above.
 *
 * Order: Windows first (YaHei is on every install, DengXian is the newer, more
 * even one), then macOS, then the common Linux packages.
 */
export const CJK_CHAIN = [
  // Windows
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"DengXian"',
  '"Sarasa Mono SC"', // monospaced CJK, when the user has installed it
  // macOS
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  // Linux
  '"Noto Sans CJK SC"',
  '"Noto Sans Mono CJK SC"',
  '"Source Han Sans SC"',
  '"WenQuanYi Micro Hei"',
  // Last resort for Han and for everything else the above miss
  "monospace",
].join(", ");

/**
 * The monospace family the application ships (`@font-face` in `styles/fonts.css`).
 *
 * It is the end of every stack for a reason, and that reason is also a trap: a chosen face that the
 * webview cannot use falls through to this one, which looks like a normal monospace rather than like a
 * broken font - so "the font I picked has no effect" is indistinguishable from "the font I picked is
 * very similar to this one". `effectiveMonoFamily` exists to make that case sayable.
 */
export const BUNDLED_MONO_FAMILY = "JetBrains Mono";

export const FALLBACK_CHAIN = `"${BUNDLED_MONO_FAMILY}", SFMono-Regular, Menlo, ${CJK_CHAIN}`;

/** The resolved stack (with quoting and the fallback chain); the public API stays as it was. */
let detected: string | null = null;
/** Detected family name (unquoted); measured once and then cached. */
let detectedName: string | null = null;
let detectedOnce = false;
let monoReady: Promise<void> | null = null;
/** Answers already measured for `familyResolves`, keyed by the lowercased family name. */
const availability = new Map<string, boolean>();
/** One canvas for the availability probe: measuring is the only way to ask, and it is cached anyway. */
let probeCanvas: HTMLCanvasElement | null = null;

export function ensureMonoFontsLoaded(): Promise<void> {
  if (monoReady) return monoReady;
  if (typeof document === "undefined" || !document.fonts?.load) {
    monoReady = Promise.resolve();
    return monoReady;
  }
  // Both weights in both styles: the terminal rasterises its glyph atlas as soon as a session
  // starts, and a face that has not arrived by then bakes the browser's sheared stand-in into the
  // atlas - which stays there, because the atlas is keyed per cell and only rebuilt on demand.
  monoReady = Promise.allSettled([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('700 14px "JetBrains Mono"'),
    document.fonts.load('italic 400 14px "JetBrains Mono"'),
    document.fonts.load('italic 700 14px "JetBrains Mono"'),
  ]).then(() => undefined);
  return monoReady;
}

export function resolveFontFamily(userInput: string): string {
  const name = userInput.trim();
  if (!name) return detectMonoFontFamily();
  // A comma means the user gave a full stack; otherwise quote the single family.
  // Strip any quotes first so a stray quote can't produce a malformed token.
  const head = name.includes(",") ? name : `"${name.replace(/['"]/g, "")}"`;
  return `${head}, ${FALLBACK_CHAIN}`;
}

/**
 * Terminal font stack: the chosen font → the auto-detected Nerd Font (for icon glyphs)
 * → the fallback chain.
 *
 * The icon slot has no setting of its own: a font that draws Nerd Font icons is
 * usually not the one you want to read text in, so text uses the user's pick and
 * icons are left to auto-detection. When both are empty this is the old behavior
 * (the detected font does everything).
 */
export function resolveFontStack(family: string): string {
  const detected = detectedFamilyName();
  const detectedToken = detected ? familyToken(detected) : null;
  const head = familyToken(family) ?? detectedToken;
  const names: string[] = [];
  if (head) names.push(head);
  if (detectedToken && !names.some((name) => sameName(name, detectedToken))) {
    names.push(detectedToken);
  }
  return [...names, FALLBACK_CHAIN].join(", ");
}

/**
 * Whether this webview can actually draw with a family.
 *
 * Three oracles were available and only the third answers the question. `document.fonts.check` says
 * yes for a name it has never heard of; the installed-font list is the *system's* view, and a face can
 * be listed there and still be unusable inside the webview (and the reverse). What the terminal itself
 * does is measure: a name the browser cannot resolve measures exactly like the generic family it falls
 * back to, so the width is compared against both generic baselines - one is enough to be fooled by a
 * design whose advance happens to match.
 *
 * `true` when the measurement cannot be taken: not having a canvas is not evidence that the font is
 * missing, and a warning that cannot be trusted is worse than no warning.
 */
export function familyResolves(family: string): boolean {
  const name = family.trim();
  if (!name) return false;
  // A face the document has not fetched measures exactly like the generic family under it (see
  // `measureDiffersFromGeneric`), and that measurement is not wrong - it is early. Answering "unusable"
  // there was wrong twice over: it said so about a font this application ships, and it cached the
  // answer, so the settings row kept reporting a fallback long after the face had arrived. Until the
  // bytes are here the honest answer is "no evidence", which is the answer for a missing canvas too -
  // and nothing is remembered, so the real measurement still gets to decide.
  if (facePending(name)) {
    void document.fonts?.load?.(`16px ${quotedFamily(name)}`)?.catch?.(() => undefined);
    return true;
  }
  const key = name.toLowerCase();
  const cached = availability.get(key);
  if (cached !== undefined) return cached;
  const measured = measureDiffersFromGeneric(name);
  availability.set(key, measured);
  return measured;
}

/**
 * Whether this family has a face the document has declared but not fetched.
 *
 * That is the bundled JetBrains Mono in every window that has not drawn a terminal yet: the settings
 * window has the `@font-face` rule and none of the bytes. Only a face that is still `unloaded` or
 * `loading` counts - one that finished (`loaded`) can be measured, and one that failed (`error`) is
 * missing for real and must be reported as such.
 */
function facePending(name: string): boolean {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return false;
  const wanted = name.replace(/['"]/g, "").trim().toLowerCase();
  for (const face of [...fonts]) {
    if (face.family.replace(/['"]/g, "").trim().toLowerCase() !== wanted) continue;
    if (face.status === "unloaded" || face.status === "loading") return true;
  }
  return false;
}

/** One family, quoted the way a CSS font shorthand wants it. */
function quotedFamily(name: string): string {
  return `"${name.replace(/['"]/g, "")}"`;
}

function measureDiffersFromGeneric(name: string): boolean {
  if (typeof document === "undefined") return true;
  probeCanvas ??= document.createElement("canvas");
  const context = probeCanvas.getContext?.("2d");
  if (!context) return true;
  const sample = "Wim0123";
  const quoted = quotedFamily(name);
  for (const generic of ["monospace", "serif"]) {
    context.font = `16px ${generic}`;
    const baseline = context.measureText(sample).width;
    context.font = `16px ${quoted}, ${generic}`;
    if (context.measureText(sample).width !== baseline) return true;
  }
  return false;
}

/**
 * The family the terminal will really draw with, and whether that is not the one asked for.
 *
 * `fallback` is only true when the asked-for face was *measured* as unusable - the setting being empty
 * is not a fallback, it is the documented "auto-detect". What is reported here is the same answer the
 * settings row shows, so the row cannot quietly disagree with the terminal.
 */
export function effectiveMonoFamily(family: string): {
  /** The family name that will be used, unquoted. */
  family: string;
  /** The asked-for face cannot be used here; something else is being drawn instead. */
  fallback: boolean;
} {
  const asked = family.trim();
  if (asked && familyResolves(asked)) return { family: asked, fallback: false };
  const detected = detectedFamilyName();
  return {
    family: detected ?? BUNDLED_MONO_FAMILY,
    fallback: asked !== "",
  };
}

/** Fold one input into a font token: with a comma it is used as-is as the stack head,
 * otherwise it gets quoted. */
function familyToken(input: string): string | null {
  const name = input.trim();
  if (!name) return null;
  return name.includes(",") ? name : `"${name.replace(/['"]/g, "")}"`;
}

function sameName(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/['"]/g, "").trim().toLowerCase();
  return strip(a) === strip(b);
}

/** Detected family name (unquoted); null when no candidate is installed. Measured once
 * and then cached. */
function detectedFamilyName(): string | null {
  if (detectedOnce) return detectedName;
  detectedOnce = true;
  if (typeof document === "undefined") {
    detectedName = null;
    return detectedName;
  }
  const context = document.createElement("canvas").getContext("2d");
  if (context) {
    const sample = "Wim0123\ue0a0\ue718";
    const fallbacks = ["monospace", "serif"];
    const widths = fallbacks.map((fallback) => {
      context.font = `16px ${fallback}`;
      return context.measureText(sample).width;
    });
    for (const font of NERD_FONT_CANDIDATES) {
      if (
        fallbacks.some((fallback, index) => {
          context.font = `16px "${font}", ${fallback}`;
          return context.measureText(sample).width !== widths[index];
        })
      ) {
        detectedName = font;
        return detectedName;
      }
    }
  }
  detectedName = null;
  return detectedName;
}

export function detectMonoFontFamily(): string {
  if (detected) return detected;
  const name = detectedFamilyName();
  detected = name ? `"${name}", ${FALLBACK_CHAIN}` : FALLBACK_CHAIN;
  return detected;
}
