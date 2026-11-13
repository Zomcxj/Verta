import { effectiveMonoFamily, resolveFontStack } from "@/lib/fonts";
import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/**
 * What the terminal will actually look like, and which family it will actually use.
 *
 * Two questions were indistinguishable from the settings row: "did my choice take effect" and "is this
 * font simply hard to tell apart from the fallback". The sample is drawn with the terminal's own stack
 * (`resolveFontStack`), its own size, weight and letter spacing, so it is the same picture the terminal
 * makes; the line under it names the family that picture is being made with, and says so plainly when
 * the answer is "not the one you picked".
 *
 * The fallback is not a hypothetical: every stack ends in the bundled JetBrains Mono, so a chosen face
 * the webview cannot use produces a perfectly ordinary monospace and no other signal at all.
 */
const SAMPLE = "0OIl1 aegr {} => *";

export function FontPreview() {
  const t = useT();
  const family = usePreferencesStore((s) => s.terminalFontFamily);
  const fontSize = usePreferencesStore((s) => s.terminalFontSize);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const weight = usePreferencesStore((s) => s.terminalFontWeight);
  const letterSpacing = usePreferencesStore((s) => s.terminalLetterSpacing);
  /**
   * Re-render when the document's faces finish arriving.
   *
   * The bundled family is `@font-face`: until its bytes are here it cannot be measured, and the row is
   * drawn in the same commit that first asks for it (`familyResolves` starts the load). Without this,
   * the answer taken before the load stays on screen - which is how the row came to say "falling back
   * to MesloLGM Nerd Font" about the font the application itself ships.
   */
  const [, setFontEpoch] = useState(0);
  useEffect(() => {
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    if (!fonts?.addEventListener) return;
    const recount = () => setFontEpoch((epoch) => epoch + 1);
    fonts.addEventListener("loadingdone", recount);
    fonts.addEventListener("loadingerror", recount);
    return () => {
      fonts.removeEventListener("loadingdone", recount);
      fonts.removeEventListener("loadingerror", recount);
    };
  }, []);
  const effective = effectiveMonoFamily(family);
  // The same arithmetic the terminal does (`useGhosttyTerminalSession`): the preview has to show the
  // size that will be drawn, not the number in the slider.
  const pixels = Math.max(4, Math.round(fontSize * zoomLevel));
  return (
    <div className="flex w-56 flex-col gap-1">
      <div
        data-font-preview
        // Readable from the DOM so a probe can ask the same question a person does, and get the same
        // answer the terminal would.
        data-font-effective={effective.family}
        data-font-fallback={effective.fallback ? "true" : "false"}
        // Exactly what the terminal's own font string is, so the sample cannot be drawn with a chain
        // the terminal does not use.
        style={{
          fontFamily: resolveFontStack(family),
          fontSize: `${pixels}px`,
          // The same token the terminal's own font string carries ("normal" / "500" / "600" / "bold"):
          // a number here would render a preview of a weight the terminal never asks for.
          fontWeight: weight as CSSProperties["fontWeight"],
          letterSpacing: `${letterSpacing}px`,
        }}
        className="overflow-hidden whitespace-nowrap rounded-md border border-border/60 bg-background px-2 py-1 text-foreground"
      >
        {SAMPLE}
      </div>
      <span
        data-font-effective-line
        className={
          effective.fallback
            ? "text-[10.5px] leading-relaxed text-amber-500"
            : "text-[10.5px] leading-relaxed text-muted-foreground"
        }
      >
        {effective.fallback
          ? t("settings.font.fellBack", { family: effective.family })
          : t("settings.font.effective", { family: effective.family })}
      </span>
    </div>
  );
}
