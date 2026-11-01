import { describe, expect, it } from "vitest";
import { hasUpdate, upgradable, upgradedNotice } from "./useAgentVersions";

describe("hasUpdate", () => {
  it("offers an update when the published version is newer", () => {
    // The pair measured on this machine: pi-lens installed 4.4.7, published 4.4.8.
    expect(hasUpdate("4.4.7", "4.4.8")).toBe(true);
    expect(hasUpdate("1.4.0", "1.5.0")).toBe(true);
    expect(hasUpdate("1.4.0", "2.0.0")).toBe(true);
  });

  it("offers nothing when they are equal", () => {
    expect(hasUpdate("2.2.5", "2.2.5")).toBe(false);
    expect(hasUpdate("1.4.0", "1.4.0")).toBe(false);
  });

  it("offers nothing when the installed one is ahead", () => {
    // A prerelease or a local build can be ahead of the registry; that is not an update.
    expect(hasUpdate("2.3.0", "2.2.5")).toBe(false);
    expect(hasUpdate("4.4.8", "4.4.7")).toBe(false);
  });

  it("compares component by component, not as text", () => {
    // "4.4.10" is newer than "4.4.9", which a string compare gets backwards.
    expect(hasUpdate("4.4.9", "4.4.10")).toBe(true);
    expect(hasUpdate("4.4.10", "4.4.9")).toBe(false);
  });

  it("offers nothing when either side is unknown", () => {
    // A registry that could not be asked must not produce an upgrade button.
    expect(hasUpdate(null, "2.2.5")).toBe(false);
    expect(hasUpdate("2.2.5", null)).toBe(false);
    expect(hasUpdate(null, null)).toBe(false);
  });

  it("offers nothing when a version cannot be parsed", () => {
    expect(hasUpdate("not-a-version", "2.2.5")).toBe(false);
    expect(hasUpdate("2.2.5", "latest")).toBe(false);
  });
});

describe("upgradable", () => {
  it("keeps only the rows with something newer", () => {
    const rows = [
      { id: "opencode", name: "opencode", current: "2.2.5", latest: "2.2.5", error: null },
      { id: "pi", name: "pi", current: "1.4.0", latest: "1.5.0", error: null },
      { id: "x", name: "pi-lens", current: "4.4.7", latest: "4.4.8", error: null },
    ];
    expect(upgradable(rows).map((r) => r.id)).toEqual(["pi", "x"]);
  });

  it("is empty when everything is current", () => {
    const rows = [
      { id: "opencode", name: "opencode", current: "2.2.5", latest: "2.2.5", error: null },
    ];
    expect(upgradable(rows)).toEqual([]);
  });
});

describe("upgradedNotice", () => {
  it("reports the version the component landed on", () => {
    // The case that prompted this: pi-lens 4.4.7 -> 4.4.8, after which the row leaves the
    // list. The confirmation is what tells the user it worked.
    const after = [
      { id: "pi-extension:pi-lens", name: "pi-lens", current: "4.4.8", latest: "4.4.8", error: null },
    ];
    expect(upgradedNotice("pi-lens", after, "pi-extension:pi-lens")).toEqual({
      name: "pi-lens",
      version: "4.4.8",
    });
  });

  it("reports no version when the row is gone entirely", () => {
    // An extension pi dropped during the upgrade: nothing to quote, so the caller says "updated".
    expect(upgradedNotice("pi-lens", [], "pi-extension:pi-lens")).toEqual({
      name: "pi-lens",
      version: null,
    });
  });

  it("does not confuse the component with another row", () => {
    const after = [
      { id: "opencode", name: "opencode", current: "2.2.5", latest: "2.2.5", error: null },
      { id: "pi", name: "pi", current: "1.4.0", latest: "1.4.0", error: null },
    ];
    expect(upgradedNotice("pi-lens", after, "pi-extension:pi-lens")).toEqual({
      name: "pi-lens",
      version: null,
    });
  });
});
