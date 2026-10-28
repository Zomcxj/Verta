import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The sibling of the notification hook's test, and read the same way: which question the hook asks
// before it flashes the taskbar button. The button is visible whether or not the window is in front
// of the user, so this one interrupts even when the app is on screen - which is why it asks too.
const hook = readFileSync(
  new URL("./useAgentAttentionFlash.ts", import.meta.url),
  "utf8",
);

describe("when a flash is worth flashing for", () => {
  it("asks whether the window can be seen at all", () => {
    // A flash is only noticed when the window is not in front anyway, and while the window can be
    // seen its own dots and its bell are the surface: a flashing button on top of them is noise.
    expect(hook).toContain("getWindowHidden()");
    expect(hook).toMatch(/windowSeen/);
  });
});