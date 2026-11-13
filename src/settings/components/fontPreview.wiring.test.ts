import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The font row has to answer two questions it could not answer before: "did my choice take effect",
 * and "is this font simply hard to tell apart from the fallback". Both are answered by drawing a
 * sample with the terminal's own font string and naming the family that string resolves to.
 *
 * Read as text, the way the other wiring tests here do - this repository renders no components. What
 * has to hold is that the sample and the terminal cannot drift apart: two font chains would reproduce
 * exactly the confusion the row exists to end.
 */
const preview = readFileSync(new URL("./FontPreview.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("./FontPicker.tsx", import.meta.url), "utf8");
const general = readFileSync(
  new URL("../sections/GeneralSection.tsx", import.meta.url),
  "utf8",
);
const terminal = readFileSync(
  new URL("../../modules/terminal/ghostty/useGhosttyTerminalSession.ts", import.meta.url),
  "utf8",
);

describe("the font preview", () => {
  it("draws with the same font chain the terminal draws with", () => {
    expect(terminal).toMatch(/family: resolveFontStack\(fontFamily\)/);
    expect(preview).toMatch(/fontFamily: resolveFontStack\(family\)/);
  });

  it("is drawn at the size the terminal will actually use", () => {
    // The zoom level is part of the terminal's size, so leaving it out would preview a size that is
    // never drawn.
    expect(terminal).toMatch(/Math\.max\(4, Math\.round\(fontSize \* zoomLevel\)\)/);
    expect(preview).toMatch(/Math\.max\(4, Math\.round\(fontSize \* zoomLevel\)\)/);
  });

  it("names the family in use, and says so plainly when it is not the chosen one", () => {
    expect(preview).toMatch(/effectiveMonoFamily\(family\)/);
    expect(preview).toContain('t("settings.font.effective"');
    expect(preview).toContain('t("settings.font.fellBack"');
    // Readable from the DOM, so a probe can ask the same question a person does and get the answer
    // the terminal would give.
    expect(preview).toMatch(/data-font-effective=\{effective\.family\}/);
    expect(preview).toMatch(
      /data-font-fallback=\{effective\.fallback \? "true" : "false"\}/,
    );
  });

  it("sits under the picker in the same row", () => {
    expect(general).toMatch(/<FontPicker[\s\S]{0,240}<FontPreview \/>/);
  });
});

describe("the picker", () => {
  it("marks the families the application ships", () => {
    expect(picker).toMatch(/option\.bundled/);
    expect(picker).toContain('t("settings.font.bundled")');
    // And gets them from the one list, not from a copy.
    expect(picker).toMatch(/fontOptions\(families, value, t\("settings\.font\.auto"\)\)/);
  });
});
