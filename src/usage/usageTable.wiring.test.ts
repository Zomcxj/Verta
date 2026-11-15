import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The request count column, in both tables.
 *
 * A total answers "how much did this cost"; it does not answer "how many times was it asked". A model
 * that is expensive per call and one that is called a thousand times a day read the same in a column
 * of tokens, and telling them apart is what decides whether the spend is a price to negotiate or a
 * loop to fix. The count is already on every row - one usage event is one answer the agent paid for -
 * so the column is a display of a number the data already has, not a new measurement.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const table = readFileSync(
  new URL("./UsageTable.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("./UsageApp.tsx", import.meta.url), "utf8");
const tokens = readFileSync(new URL("./tokens.ts", import.meta.url), "utf8");

describe("the request count column", () => {
  it("is a column of the table, not a line under the name", () => {
    expect(table).toContain("requests: string");
    expect(table).toMatch(/header\(labels\.requests, "requests", "text-right"\)/);
    // A cell of its own, so it lines up with the numbers above and below it.
    expect(table).toContain("data-usage-row-requests");
  });

  it("reads the row's own event count", () => {
    // The count is the events the row was built from, so it cannot disagree with the summary.
    expect(tokens).toMatch(/events: number;\n\s+\/\*\* This row's share/);
    expect(table).toMatch(/case "requests":\n\s+return row\.events;/);
    expect(table).toContain("data-usage-row-events={row.events}");
  });

  it("is offered by both tables, agents and models", () => {
    // Two call sites, one per table; a column that only one of them had would read as a property of
    // agents rather than of requests.
    expect(app.match(/requests: t\("usage\.colRequests"\)/g)?.length).toBe(2);
  });

  it("sorts like the other numbers, largest first on the first press", () => {
    // `defaultDescending` answers by key: every column but the name starts on the big end.
    expect(table).toMatch(/return key !== "name";/);
  });

  it("prints the count in the interface's own number format", () => {
    // 22,600 requests, not 22600: the row's neighbours are formatted the same way by the summary.
    expect(table).toContain("row.events.toLocaleString(language)");
  });
});
