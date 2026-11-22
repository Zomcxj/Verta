import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Which day the window thinks it is.
 *
 * Reported as "软件跨凌晨0点 用量没刷新 还把增量归到昨天". Two things were wrong and only one of them was
 * the read: the aggregation is right by construction, because every event carries its own timestamp and
 * the day is derived from that (`day_of` on the Rust side, `dayOf` here). What was stale was the view's
 * idea of "today" - it was `dayOf(Date.now(), offset)` computed in the render body, so it only changed
 * when something else re-rendered the window, and nothing does at midnight. The 今日 range therefore kept
 * filtering to yesterday's day index, and everything written after 00:00 was drawn inside yesterday's row.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const app = readFileSync(new URL("./UsageApp.tsx", import.meta.url), "utf8");

describe("the usage window's idea of today", () => {
  it("is state that a timer keeps in step, not a value read once per render", () => {
    // A `const today = dayOf(Date.now(), ...)` in the body is the bug: it is re-evaluated only when
    // something else re-renders, and across midnight nothing does.
    expect(app).not.toMatch(/const today = dayOf\(Date\.now\(\), offset\);/);
    expect(app).toContain("const [today, setToday] = useState(");
  });

  it("re-checks the day on a timer, and does nothing when it has not changed", () => {
    // Cheap on purpose: a window left open all night must not re-read or re-render every tick.
    expect(app).toMatch(/setInterval\(sync, [\d_]+\)/);
    expect(app).toContain("if (next === seenDay.current) return;");
  });

  it("asks for a fresh read the moment the day turns", () => {
    // The tick that brings the new day's events is up to a minute away; until it lands 今日 is empty
    // for no reason the reader can see. The day change is the one thing that costs a read.
    expect(app).toMatch(/seenDay\.current = next;[\s\S]{0,400}load\(\);/);
  });

  it("re-checks when the offset changes, so a time zone change is not left behind", () => {
    // The offset comes from the payload, which can arrive later than the first render.
    expect(app).toMatch(/\}, \[offset, load\]\);/);
  });

  it("asks the aggregation for a day index the readers use", () => {
    // The other half of the contract: both sides derive a day the same way, so a fix here cannot drift
    // from `day_of` in Rust.
    expect(app).toContain("dayOf(Date.now(), offset)");
  });
});
