import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The window opens on the last read, not on an empty page.
 *
 * Reading every agent store takes seconds, and the window used to spend them saying "读取中…" over
 * numbers it had already read a minute earlier. The stored copy is painted first and then replaced;
 * the two things this file guards are that the paint happens before the read can land, and that the
 * window says which of the two it is showing.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const app = readFileSync(new URL("./UsageApp.tsx", import.meta.url), "utf8");

describe("the usage window's first paint", () => {
  it("paints the stored answer before the live read lands", () => {
    expect(app).toContain("loadUsageCache()");
    expect(app).toContain("setPayload(cached.payload)");
    expect(app).toContain("setUpdatedAt(cached.at)");
    // A live answer that arrives first wins, and the cache must not overwrite it afterwards.
    expect(app).toContain("if (!alive || !cached || liveLanded.current) return;");
  });

  it("keeps what it read, for the next open", () => {
    expect(app).toContain("void saveUsageCache(answer, at)");
    // Stamped with the moment the answer arrived, not with the moment it was painted.
    expect(app).toContain("const at = Date.now();");
    expect(app).toContain("setUpdatedAt(at)");
  });

  it("says whether the numbers came from the cache or from this run", () => {
    expect(app).toContain('data-usage-updated-at={fromCache ? "cache" : "live"}');
    expect(app).toContain("setFromCache(true)");
    expect(app).toContain("setFromCache(false)");
    // The time stays visible while a read is in flight: it belongs to the numbers under it.
    expect(app).not.toContain("updatedAt && !loading");
  });

  it("only covers the window when there is nothing to show", () => {
    // The reading state is what a first open gets; a second open has numbers and only the line above
    // them says a read is running.
    expect(app).toMatch(/\{!payload \|\| !view \|\| !trend \|\| !heatmap \? \(/);
  });
});
