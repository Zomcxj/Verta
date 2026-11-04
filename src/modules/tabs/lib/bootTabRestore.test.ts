import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../../settings/store";

/**
 * What a launch does with the tab list the last window left behind.
 *
 * Read as text, the way the motion budget test reads the stylesheet - this repository renders no
 * components, and what has to hold here is the shape of boot: the restore exists again, it is the
 * `restoreTabsOnLaunch` preference that decides, and with nothing saved the launch is the one cold
 * tab in the default environment, exactly as the fresh-boot request had it.
 */
const hook = readFileSync(new URL("./useTabRestore.ts", import.meta.url), "utf8");

describe("booting a window", () => {
  it("reads the saved list back, behind the preference", () => {
    expect(hook).toContain("restoreTabsOnLaunch");
    expect(hook).toContain("loadTabState");
    expect(hook).toContain("hydrateTabs");
    expect(hook).toContain("replaceTabs");
    // Every cwd of a restored list is authorized up front, one call per cwd.
    expect(hook).toContain("workspaceAuthorize");
  });

  it("with the switch off, nothing of the last session comes back", () => {
    // The gate sits on the load call itself: no read, no restore, not even a lookup.
    expect(hook).toMatch(/restoreOn \? await loadTabState\(\) : null/);
  });

  it("still loads the preferences, which is the only place that does", () => {
    // The trap in this change: the preferences are loaded inside the restore's boot path, because the
    // restore *was* boot. Nothing else calls it, so taking it out without keeping this leaves
    // every returning user on defaults - language, environment, everything.
    expect(hook).toContain("usePreferencesStore");
    expect(hook).toContain(".init()");
  });

  it("with nothing saved, starts in this machine's environment", () => {
    // No preference decides it any more: a new space is always local, and WSL is
    // reached from a session row or the plus menu's terminal list, which name the distro.
    expect(hook).toContain("LOCAL_WORKSPACE");
    expect(hook).toContain("adoptWorkspaceEnv");
  });

  it("a restored list follows the environment its active tab was in", () => {
    expect(hook).toContain("tabEnvironment");
  });

  it("still marks boot finished, which warming waits on", () => {
    // `useTabs` gates terminal warming on this resolving, so it has to resolve either way.
    expect(hook).toContain("markBooted()");
    expect(hook).toContain("setHydrated(true)");
  });

  it("still writes the tab list back, whichever way boot went", () => {
    expect(hook).toContain("saveTabState");
    expect(hook).toContain("useTabPersistence");
  });
});

describe("a restored session tab", () => {
  const app = readFileSync(
    new URL("../../../app/App.tsx", import.meta.url),
    "utf8",
  );

  it("asks the folder for its repositories, the way a click on the row does", () => {
    // Reported 2026-11-04: opening the restored PTZ tab left the source-control panel wherever it
    // had been, because the resume ran the command but skipped the folder scan - a folder that holds
    // repositories was never asked about. Both paths into a session have to ask; the resume effect is
    // the one that does not go through `handleOpenSession`.
    const resume = app.slice(app.indexOf("restoredResumes"));
    expect(resume).toContain(
      "discoverRepositoriesRef.current(plan.cwd, plan.workspace)",
    );
  });
});

describe("the switch that decides it", () => {
  it("starts off, so a fresh install is one terminal", () => {
    // The default moved to off on 2026-11-04: a launch that restores a session also starts the
    // agent in it, which is a thing the user asks for, not something that happens to them. What a
    // user has stored (their own click) still wins over the default.
    expect(DEFAULT_PREFERENCES.restoreTabsOnLaunch).toBe(false);
  });
});
