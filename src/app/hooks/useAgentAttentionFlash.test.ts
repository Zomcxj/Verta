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

  it("records a wait it deliberately did not flash for", () => {
    // Which it did not do at first, while the notification hook did. A question standing on another
    // tab while the window was in front was recorded there and not here, so the first store write
    // after the window went out of the way flashed the button for a question the user had been able
    // to see all along - hiding the window writes the store itself, so that write always happens.
    // The surfaces that interrupt tell one story, or none of them does.
    //
    // Pinned inside the branch, not by the line existing: this hook already carried that line for
    // the case where it really does flash, so matching it anywhere proved nothing.
    const branch = hook.indexOf("if (windowSeen)");
    expect(branch).toBeGreaterThan(-1);
    const rest = hook.slice(branch);
    const upToTheNextCheck = rest.slice(0, rest.indexOf("if (!announce"));
    expect(upToTheNextCheck).toContain("announced.set(ptyId, sinceMs)");
  });
});