import { describe, expect, it } from "vitest";
import {
  addPull,
  canStartPull,
  MAX_CONCURRENT_PULLS,
  type PullGate,
  removePull,
} from "./pullGate";

const idle: PullGate = { checking: false, pulling: new Set<string>() };

describe("pullGate", () => {
  it("lets one row be pulled while nothing else is happening", () => {
    expect(canStartPull(idle, "C:/work/verta")).toBe(true);
  });

  it("refuses while the status check is running", () => {
    // The check fetches every project; a pull started on top of it fights it for the same
    // remote and the same disk, and the status that comes back describes the tree from before
    // the pull landed.
    expect(canStartPull({ ...idle, checking: true }, "C:/work/verta")).toBe(false);
  });

  it("refuses the row that is already being pulled", () => {
    const gate = addPull(idle, "C:/work/verta");
    expect(canStartPull(gate, "C:/work/verta")).toBe(false);
    expect(canStartPull(gate, "C:/work/other")).toBe(true);
  });

  it("lets two different rows run at once and no more", () => {
    let gate = idle;
    gate = addPull(gate, "C:/a");
    expect(canStartPull(gate, "C:/b")).toBe(true);
    gate = addPull(gate, "C:/b");
    expect(gate.pulling.size).toBe(MAX_CONCURRENT_PULLS);
    expect(canStartPull(gate, "C:/c")).toBe(false);
  });

  it("frees the slot when a pull ends, whatever it did", () => {
    let gate = idle;
    gate = addPull(gate, "C:/a");
    gate = addPull(gate, "C:/b");
    gate = removePull(gate, "C:/a");
    expect(canStartPull(gate, "C:/c")).toBe(true);
  });

  it("leaves the gate alone when a path it does not hold is removed", () => {
    const gate = addPull(idle, "C:/a");
    expect(removePull(gate, "C:/nope")).toBe(gate);
  });

  it("does not mutate the gate it is given", () => {
    // The panel keeps its state in React; a helper that edited the set in place would change
    // what is on screen without a re-render.
    const before = addPull(idle, "C:/a");
    const snapshot = new Set(before.pulling);
    addPull(before, "C:/b");
    removePull(before, "C:/a");
    expect([...before.pulling]).toEqual([...snapshot]);
  });
});