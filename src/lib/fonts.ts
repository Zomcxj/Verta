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

export const FALLBACK_CHAIN = `"JetBrains Mono", SFMono-Regular, Menlo, ${CJK_CHAIN}`;

/** The resolved stack (with quoting and the fallback chain); the public API stays as it was. */
let detected: string | null = null;
/** Detected family name (unquoted); measured once and then cached. */
let detectedName: string | null = null;
let detectedOnce = false;
let monoReady: Promise<void> | null = null;

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
