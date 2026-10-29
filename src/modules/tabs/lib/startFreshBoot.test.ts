import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What a launch does with the tab list it finds on disk: nothing.
 *
 * Read as text, the way the motion budget test reads the stylesheet and the tray hook's test reads its
 * hook - this repository renders no components, and what has to hold here is what boot still does and
 * what it no longer does. The old behaviour was written down as a feature ("Reattach last session's
 * tab list on startup"); the user asked for the opposite: one tab, where the default environment says a
 * terminal starts.
 */
const hook = readFileSync(new URL("./useTabRestore.ts", import.meta.url), "utf8");

describe("booting a fresh window", () => {
  it("does not take last session's tabs", () => {
    expect(hook).not.toContain("loadTabState");
    expect(hook).not.toContain("loadLegacyTabState");
    expect(hook).not.toContain("hydrateTabs");
    expect(hook).not.toContain("replaceTabs");
    // Every cwd of a restored list was authorized one at a time; a fresh launch has none to authorize.
    expect(hook).not.toContain("workspaceAuthorize");
  });

  it("still loads the preferences, which is the only place that does", () => {
    // The trap in this change: the preferences are loaded inside the restore's boot path, because the
    // restore *was* boot. Nothing else calls it, so taking the restore out without keeping this leaves
    // every returning user on defaults - language, environment, everything.
    expect(hook).toContain("usePreferencesStore");
    expect(hook).toContain(".init()");
  });

  it("starts in the default environment rather than the one last session was in", () => {
    expect(hook).toContain("defaultWorkspaceEnv");
    expect(hook).toContain("adoptWorkspaceEnv");
    // Which environment the last session's active tab happened to be in has no say here any more.
    expect(hook).not.toContain("tabEnvironment");
  });

  it("still marks boot finished, which warming waits on", () => {
    // `useTabs` gates terminal warming on this resolving, so it has to resolve either way.
    expect(hook).toContain("markBooted()");
    expect(hook).toContain("setHydrated(true)");
  });

  it("still writes the tab list back, since this asked for no restore and not for no memory", () => {
    expect(hook).toContain("saveTabState");
    expect(hook).toContain("useTabPersistence");
  });
});