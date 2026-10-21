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

const FALLBACK_CHAIN = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';

/** 折好的整串（带引号与兜底链）；保持原有 API 不变。 */
let detected: string | null = null;
/** 检测到的家族名（不带引号）；测过一次就不再测。 */
let detectedName: string | null = null;
let detectedOnce = false;
let monoReady: Promise<void> | null = null;

export function ensureMonoFontsLoaded(): Promise<void> {
  if (monoReady) return monoReady;
  if (typeof document === "undefined" || !document.fonts?.load) {
    monoReady = Promise.resolve();
    return monoReady;
  }
  monoReady = Promise.allSettled([
    document.fonts.load('400 14px "JetBrains Mono"'),
    document.fonts.load('700 14px "JetBrains Mono"'),
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
 * 终端字体栈：选的字体 → 自动检测到的 Nerd Font（画图标字形用）→ 兜底链。
 *
 * 图标那一档不留设置项：能画出 Nerd Font 图标的字体通常不是你想读正文的那个字体，所以
 * 正文用用户选的、图标交给自动检测，两边都空时就是老行为（检测到的那个字体一把抓）。
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

/** 一个输入折成一个字体 token：带逗号的原样当栈头，否则加引号。 */
function familyToken(input: string): string | null {
  const name = input.trim();
  if (!name) return null;
  return name.includes(",") ? name : `"${name.replace(/['"]/g, "")}"`;
}

function sameName(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/['"]/g, "").trim().toLowerCase();
  return strip(a) === strip(b);
}

/** 检测到的家族名（不带引号）；没装任何候选时是 null。测过一次就不再测。 */
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
