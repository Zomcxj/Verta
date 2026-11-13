import { describe, expect, it } from "vitest";
import {
  forgetLeafCommandState,
  leafCommandRunning,
  noteLeafCommandState,
} from "./shellCommandState";

describe("what the shell says about a command in flight", () => {
  it("starts from nothing, which is not the same as rest", () => {
    // A shell with no integration (a distribution's shell through `wsl.exe`, a `sh` that sources
    // nothing) never reports. The judge has to see that as "no opinion": read as rest, it would
    // demote every busy session on such a shell.
    expect(leafCommandRunning(101)).toBeNull();
  });

  it("reports what the shell last said, both ways round", () => {
    noteLeafCommandState(102, true);
    expect(leafCommandRunning(102)).toBe(true);
    noteLeafCommandState(102, false);
    expect(leafCommandRunning(102)).toBe(false);
  });

  it("forgets a leaf when its session ends, so a reused id starts from nothing", () => {
    noteLeafCommandState(103, true);
    forgetLeafCommandState(103);
    expect(leafCommandRunning(103)).toBeNull();
  });

  it("keeps sessions apart", () => {
    noteLeafCommandState(104, true);
    noteLeafCommandState(105, false);
    expect(leafCommandRunning(104)).toBe(true);
    expect(leafCommandRunning(105)).toBe(false);
  });
});
