import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, resolveAppearance } from "./appearance";
import type { Theme, ThemeAppearance } from "./types";

/** A theme that says nothing about its appearance - every built-in one, today. */
const plain: Theme = {
  id: "plain",
  name: "Plain",
  variants: { dark: { colors: { background: "#111" } }, light: { colors: { background: "#eee" } } },
};

/** A theme with an opinion, read off the variant for the mode being asked about. */
const declared = (appearance: ThemeAppearance): Theme => ({
  id: "declared",
  name: "Declared",
  variants: {
    dark: { colors: { background: "#111" }, appearance },
    light: { colors: { background: "#eee" }, appearance },
  },
});

describe("the appearance a theme asks for", () => {
  it("is today's defaults when neither the theme nor the user says anything", () => {
    const resolved = resolveAppearance(plain, "dark");
    expect(resolved).toEqual({
      ...DEFAULT_APPEARANCE,
      source: {
        backdrop: "default",
        backgroundOpacity: "default",
        backgroundBlur: "default",
      },
    });
    // A theme that is not there at all reads the same - `clearTheme` leaves no theme, not a broken one.
    expect(resolveAppearance(null, "light")).toEqual(resolved);
    expect(resolveAppearance(undefined, "dark")).toEqual(resolved);
  });

  it("takes the theme's values when the user has not touched them", () => {
    const resolved = resolveAppearance(
      declared({ backdrop: "acrylic", backgroundOpacity: 0.8, backgroundBlur: 12 }),
      "dark",
    );
    expect(resolved).toEqual({
      backdrop: "acrylic",
      backgroundOpacity: 0.8,
      backgroundBlur: 12,
      source: { backdrop: "theme", backgroundOpacity: "theme", backgroundBlur: "theme" },
    });
  });

  it("lets a stored value win, including one that switches the material off", () => {
    // The migration this exists for: a user who turned vibrancy OFF before themes could ask for it
    // has a stored `false`. That is a decision, and it must not be overridden by an acrylic theme.
    const resolved = resolveAppearance(
      declared({ backdrop: "acrylic", backgroundOpacity: 0.8, backgroundBlur: 12 }),
      "dark",
      { backdrop: "none" },
    );
    expect(resolved.backdrop).toBe("none");
    expect(resolved.source.backdrop).toBe("user");
    // The fields nobody touched still follow the theme.
    expect(resolved.backgroundOpacity).toBe(0.8);
    expect(resolved.source.backgroundOpacity).toBe("theme");
  });

  it("decides each field on its own", () => {
    const resolved = resolveAppearance(
      declared({ backdrop: "native", backgroundOpacity: 0.2, backgroundBlur: 8 }),
      "dark",
      { backgroundBlur: 0 },
    );
    expect(resolved.backdrop).toBe("native");
    expect(resolved.backgroundOpacity).toBe(0.2);
    expect(resolved.backgroundBlur).toBe(0);
    expect(resolved.source).toEqual({
      backdrop: "theme",
      backgroundOpacity: "theme",
      backgroundBlur: "user",
    });
  });

  it("clamps what a hand-edited theme file says", () => {
    // Theme files are editable JSON, so a value out of range is clamped and a value of the wrong
    // type is refused rather than written through to a CSS variable.
    const wild = resolveAppearance(
      declared({
        backgroundOpacity: 4,
        backgroundBlur: 900,
      }),
      "dark",
    );
    expect(wild.backgroundOpacity).toBe(1);
    expect(wild.backgroundBlur).toBe(64);

    const negative = resolveAppearance(
      declared({ backgroundOpacity: -2, backgroundBlur: -8 }),
      "dark",
    );
    expect(negative.backgroundOpacity).toBe(0);
    expect(negative.backgroundBlur).toBe(0);

    const garbage = resolveAppearance(
      // biome-ignore lint/suspicious/noExplicitAny: a theme file is data, not types
      declared({ backgroundOpacity: "0.9" as any, backgroundBlur: Number.NaN }),
      "dark",
    );
    expect(garbage.backgroundOpacity).toBe(DEFAULT_APPEARANCE.backgroundOpacity);
    expect(garbage.backgroundBlur).toBe(DEFAULT_APPEARANCE.backgroundBlur);
    expect(garbage.source.backgroundOpacity).toBe("default");

    const unknownMaterial = resolveAppearance(
      // biome-ignore lint/suspicious/noExplicitAny: same
      declared({ backdrop: "mica" as any }),
      "dark",
    );
    expect(unknownMaterial.backdrop).toBe("none");
  });

  it("rounds the blur, which is a pixel count", () => {
    expect(resolveAppearance(declared({ backgroundBlur: 7.6 }), "dark").backgroundBlur).toBe(8);
    expect(resolveAppearance(plain, "dark", { backgroundBlur: 3.2 }).backgroundBlur).toBe(3);
  });

  it("reads the variant the colours would come from", () => {
    // A theme with one variant answers both modes with it, and the appearance has to come from the
    // same place the colours did.
    const darkOnly: Theme = {
      id: "dark-only",
      name: "Dark only",
      variants: { dark: { colors: {}, appearance: { backdrop: "acrylic" } } },
    };
    expect(resolveAppearance(darkOnly, "light").backdrop).toBe("acrylic");
    expect(resolveAppearance(darkOnly, "dark").backdrop).toBe("acrylic");
  });

  it("takes a material off a user value that is not a material", () => {
    // `windowVibrancy` is a boolean today; if the stored value were anything else the theme's
    // answer stands rather than becoming a variable nobody understands.
    expect(
      resolveAppearance(declared({ backdrop: "acrylic" }), "dark", {
        // biome-ignore lint/suspicious/noExplicitAny: same
        backdrop: "yes" as any,
      }).backdrop,
    ).toBe("acrylic");
  });
});
