import { describe, expect, it } from "vitest";

import { colorFgBg } from "./terminalBackground";

/**
 * Telling a full-screen TUI which paper it is on.
 *
 * Claude Code and opencode both paint their own 24-bit colours from their own themes, so the
 * terminal's palette cannot reach them. What they *do* read is `COLORFGBG`, the old xterm convention
 * for "what colour is the background". Both were measured in their own binaries on this machine:
 *
 * - `claude` 2.1.325: `let e=process.env.COLORFGBG; let n=e.split(";").at(-1); let r=Number(n); …
 *   return r<=6||r===8?"dark":"light"`
 * - `opencode` 2.3.0: `let e=Number(process.env.COLORFGBG?.split(";").at(-1));
 *   if(Number.isFinite(e)&&e>=7) return { … light palette … }`
 *
 * Both take the *last* field, so the last field is what has to say light or dark. 15 (bright white) is
 * light and 0 (black) is dark on every one of those two rules.
 */
describe("COLORFGBG", () => {
  it("says light for a light window and dark for a dark one", () => {
    expect(colorFgBg("light")).toBe("0;15");
    expect(colorFgBg("dark")).toBe("15;0");
  });

  it("puts the answer in the field both tools read", () => {
    // The last field is the background colour index. A value they cannot parse falls back to their
    // own default, which is dark - so a malformed string is the same bug as no string.
    for (const mode of ["light", "dark"] as const) {
      const value = colorFgBg(mode);
      const fields = value.split(";");
      const last = fields[fields.length - 1];
      expect(last).toBeDefined();
      const index = Number(last);
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(15);
    }
  });

  it("agrees with claude's rule", () => {
    // `r<=6 || r===8` is dark, everything else light.
    const lastField = (value: string) => {
      const fields = value.split(";");
      return Number(fields[fields.length - 1]);
    };
    const claudeSaysLight = (value: string) => {
      const r = lastField(value);
      return !(r <= 6 || r === 8);
    };
    expect(claudeSaysLight(colorFgBg("light"))).toBe(true);
    expect(claudeSaysLight(colorFgBg("dark"))).toBe(false);
  });

  it("agrees with opencode's rule", () => {
    // `e>=7` is light.
    const opencodeSaysLight = (value: string) => {
      const fields = value.split(";");
      return Number(fields[fields.length - 1]) >= 7;
    };
    expect(opencodeSaysLight(colorFgBg("light"))).toBe(true);
    expect(opencodeSaysLight(colorFgBg("dark"))).toBe(false);
  });
});
