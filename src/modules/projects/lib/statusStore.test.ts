import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WireProjectStatus } from "@/lib/native";

// The store is backed by an in-memory Map, plus a record of what was written, so a write
// that should not happen is visible. Both live outside the factory: a module reset keeps
// them, so the tests clear them themselves.
const state = vi.hoisted(() => ({
  writes: [] as string[],
  files: new Map<string, Map<string, unknown>>(),
}));

vi.mock("@tauri-apps/plugin-store", () => {
  class LazyStore {
    private readonly name: string;
    private readonly file: Map<string, unknown>;
    constructor(name: string) {
      this.name = name;
      let file = state.files.get(name);
      if (!file) {
        file = new Map<string, unknown>();
        state.files.set(name, file);
      }
      this.file = file;
    }
    async get(key: string) {
      return this.file.get(key);
    }
    async set(key: string, value: unknown) {
      state.writes.push(`${this.name}:${key}`);
      this.file.set(key, value);
    }
    async save() {}
  }
  return { LazyStore };
});

beforeEach(() => {
  state.writes.length = 0;
  state.files.clear();
  vi.resetModules();
});

const STATUS: WireProjectStatus = {
  path: "C:/work/verta",
  name: "verta",
  workspace: { kind: "local" },
  kind: "repo",
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 2,
  detached: false,
  dirty: 1,
  stashed: 1,
  error: null,
  fetchError: null,
};

describe("parseStatusSnapshot", () => {
  it("refuses anything that is not a snapshot", async () => {
    const { parseStatusSnapshot } = await import("./statusStore");
    expect(parseStatusSnapshot(null)).toBeNull();
    expect(parseStatusSnapshot("nope")).toBeNull();
    expect(parseStatusSnapshot({})).toBeNull();
    expect(parseStatusSnapshot({ at: "1", statuses: {} })).toBeNull();
    expect(parseStatusSnapshot({ at: 1, statuses: null })).toBeNull();
    expect(parseStatusSnapshot({ at: Number.NaN, statuses: {} })).toBeNull();
  });

  it("drops entries that are not statuses and keeps the rest", async () => {
    const { parseStatusSnapshot } = await import("./statusStore");
    const parsed = parseStatusSnapshot({
      at: 7,
      statuses: {
        "C:/work/verta": STATUS,
        "C:/work/junk": 12,
        "C:/work/other": {},
      },
    });
    expect(parsed?.at).toBe(7);
    expect(Object.keys(parsed?.statuses ?? {})).toEqual(["C:/work/verta"]);
  });
});

describe("statusStore", () => {
  it("hands back what was remembered, from memory and then from disk", async () => {
    const store = await import("./statusStore");
    store.rememberStatuses({ at: 7, statuses: { "C:/work/verta": STATUS } });
    const held = store.readStatusSnapshotMemory();
    expect(held?.statuses["C:/work/verta"]).toBe(STATUS);

    // A window that starts fresh has only the file.
    store.resetStatusStore();
    expect(store.readStatusSnapshotMemory()).toBeNull();
    const loaded = await store.readStatusSnapshot();
    expect(loaded?.at).toBe(7);
    expect(loaded?.statuses["C:/work/verta"]).toEqual(STATUS);
  });

  it("does not write the same statuses and timestamp again", async () => {
    const store = await import("./statusStore");
    const statuses = { "C:/work/verta": STATUS };
    store.rememberStatuses({ at: 7, statuses });
    expect(state.writes).toEqual(["verta-projects.json:statuses"]);
    store.rememberStatuses({ at: 7, statuses });
    expect(state.writes).toEqual(["verta-projects.json:statuses"]);
    // A later check does get written.
    store.rememberStatuses({ at: 8, statuses });
    expect(state.writes.length).toBe(2);
  });

  it("forgets a project that left the list, on disk as well", async () => {
    const store = await import("./statusStore");
    store.rememberStatuses({
      at: 7,
      statuses: { "C:/work/verta": STATUS, "C:/work/gone": STATUS },
    });
    store.forgetStatuses(["C:/work/gone"]);
    const keys = Object.keys((await store.readStatusSnapshot())?.statuses ?? {});
    expect(keys).toEqual(["C:/work/verta"]);
  });

  it("says nothing when there is nothing to forget", async () => {
    const store = await import("./statusStore");
    store.forgetStatuses(["C:/work/verta"]);
    expect(state.writes).toEqual([]);
    expect(store.readStatusSnapshotMemory()).toBeNull();
  });
});