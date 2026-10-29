import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

/**
 * Where a launch starts: only ever the directory it was handed.
 *
 * The remembered workspace used to stand in for a missing argument, which made every start land where the
 * last one had been. Nothing restores now, so the argument is the whole answer; a launch without one has no
 * directory at all, and the backend picks the one the environment starts terminals in.
 */
describe("initLaunchDir", () => {
  it("takes the argument when the launch was given one", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_launch_dir" ? Promise.resolve("C:\\work\\proj") : Promise.resolve(null),
    );
    const { initLaunchDir, getLaunchDir, didLaunchWithDir } = await import("./launchDir");

    await initLaunchDir();

    expect(getLaunchDir()).toBe("C:/work/proj");
    expect(didLaunchWithDir()).toBe(true);
  });

  it("answers nothing when the launch was given none", async () => {
    invoke.mockResolvedValue(null);
    const { initLaunchDir, getLaunchDir, didLaunchWithDir } = await import("./launchDir");

    await initLaunchDir();

    expect(getLaunchDir()).toBeUndefined();
    expect(didLaunchWithDir()).toBe(false);
  });

  it("does not ask where the app's own process is, which used to stand in for an argument", async () => {
    // That command answers with the directory Verta itself was started from, or home when that is not
    // usable - a directory nobody asked to open, and one whose answer would win over the environment's own
    // default. Asking for it at all is what made a start land somewhere instead of nowhere.
    invoke.mockImplementation((cmd: string) =>
      cmd === "get_launch_dir" ? Promise.resolve(null) : Promise.resolve("C:\\last\\place"),
    );
    const { initLaunchDir, getLaunchDir } = await import("./launchDir");

    await initLaunchDir();

    const asked = invoke.mock.calls.map(([cmd]) => cmd);
    expect(asked).toContain("get_launch_dir");
    expect(asked).not.toContain("workspace_current_dir");
    expect(getLaunchDir()).toBeUndefined();
  });
});
