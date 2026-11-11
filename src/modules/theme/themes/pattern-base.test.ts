import { describe, expect, it } from "vitest";
import { carbonWeave, twillWeave } from "./pattern-base";

const options = (tow: number) => ({
  tow,
  sheen: "#ffffff",
  seam: "#000000",
  sheenOpacity: 0.34,
  seamOpacity: 0.3,
});

describe("the carbon fibre weave", () => {
  it("repeats at the size of its own tile", () => {
    // The tile and the size it is drawn at travel together because a size that does not match the
    // tile leaves gaps between the repeats - the honeycomb that came before this needed a comment
    // warning about exactly that.
    for (const tow of [2, 3, 4]) {
      const { image, size } = twillWeave(options(tow));
      expect(size).toBe(`${tow * 4}px ${tow * 4}px`);
      expect(decodeURIComponent(image)).toContain(
        `width="${tow * 4}" height="${tow * 4}"`,
      );
    }
  });

  it("weaves both directions over a four tow period", () => {
    const svg = decodeURIComponent(twillWeave(options(3)).image);
    // Sixteen tows to the tile, and each is painted with one of the two gradients.
    expect(svg.match(/<rect /g)).toHaveLength(16);
    expect(svg).toContain('id="warp"');
    expect(svg).toContain('id="weft"');
    expect(svg.match(/url\(#warp\)/g)).toHaveLength(8);
    expect(svg.match(/url\(#weft\)/g)).toHaveLength(8);
  });

  it("carries a crest along each tow, not a flat fill", () => {
    const svg = decodeURIComponent(twillWeave(options(3)).image);
    // Four stops per gradient: shadow, crest, the softer fall away from it, shadow.
    expect(svg.match(/<stop /g)).toHaveLength(8);
    expect(svg).toContain('offset="0.42"');
  });

  it("gives the carbon theme a twill at the scale the chrome can show", () => {
    for (const variant of Object.values(carbonWeave.variants)) {
      const surface = variant.surface;
      expect(surface?.size).toBe("12px 12px");
      expect(surface?.image).toContain("linearGradient");
      // The honeycomb this replaced was a single stroked path, never a weave.
      expect(surface?.image).not.toContain("polygon");
    }
  });
});
