import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What the themes page calls the axis of presets.
 *
 * They were named after the shape of the window ("形态"), which stopped being what they are once the
 * material moved onto the same axis: `碳纤维` is a weave, `亚克力` and `玻璃` are materials the window
 * asks the system for, and `极简`/`浮雕`/`石板`/`云朵` are how the edges are drawn. "外观" is the word
 * that covers all seven.
 *
 * The light/dark switch above them used to carry that word too, so the page would have had two labels
 * reading "外观" - it has no label now, which is also what the user asked for ("直接取消外观"): the
 * three buttons say what they are.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const messages = readFileSync(
  new URL("../modules/i18n/messages.ts", import.meta.url),
  "utf8",
);
const section = readFileSync(
  new URL("./sections/ThemesSection.tsx", import.meta.url),
  "utf8",
);

/** One language's entry for a key, as it is written in `messages.ts`. */
const entry = (key: string, value: string) =>
  new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"${value}"`);

describe("the themes page's wording", () => {
  it("calls the preset axis 外观 / Appearance", () => {
    expect(messages).toMatch(entry("settings.shape.title", "外观"));
    expect(messages).toMatch(entry("settings.shape.title", "Appearance"));
    // Nothing in the interface still offers a "形态".
    expect(messages).not.toMatch(entry("settings.shape.title", "形态"));
    expect(messages).not.toMatch(entry("settings.shape.title", "Shape"));
  });

  it("leaves the light/dark switch without a label of its own", () => {
    // It had one ("外观"), which the preset axis now needs. The three buttons name themselves.
    const block = section.slice(
      section.indexOf('t("settings.themes.title")'),
      section.indexOf('t("settings.shape.title")'),
    );
    expect(block, "the light/dark switch still carries a label").not.toContain(
      't("settings.appearance")',
    );
    // Its explanation went too: "System follows Windows between light and dark; the palettes and the
    // editor theme are below" narrated a page the buttons already say. Three labelled buttons under
    // a heading do not need a sentence telling the reader to read on.
    expect(block, "the switch still carries its explanation").not.toContain(
      't("settings.appearanceHint")',
    );
  });

  it("still offers the presets under that heading", () => {
    expect(section).toContain('t("settings.shape.title")');
    expect(section).toContain("listShapes().map");
  });
});
