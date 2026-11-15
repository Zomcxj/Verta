import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stored copy of the last usage read.
 *
 * Two things matter here and both are about trust: what the window is willing to paint from disk, and
 * that a store which cannot be read never stops the window from reading the machine instead.
 */
const pluginStore = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => data.get(key));
  const set = vi.fn(async (key: string, value: unknown) => {
    data.set(key, value);
  });
  class LazyStore {
    get = get;
    set = set;
    constructor(public path: string) {}
  }
  return { data, get, set, LazyStore };
});

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: pluginStore.LazyStore,
}));

import type { UsagePayload } from "./tokens";
import { loadUsageCache, saveUsageCache, usableCache } from "./usageCache";

function payload(overrides: Partial<UsagePayload> = {}): UsagePayload {
  return {
    sinceMs: null,
    offsetMinutes: 480,
    scope: { cacheRead: true, cacheWrite: true },
    parts: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    tokens: 10,
    events: 1,
    excludedCacheRead: 0,
    excludedCacheWrite: 0,
    days: [],
    failures: [],
    ...overrides,
  } as UsagePayload;
}

beforeEach(() => {
  pluginStore.data.clear();
  pluginStore.get.mockClear();
  pluginStore.set.mockClear();
});

describe("the usage cache", () => {
  it("keeps a payload and the instant it was read", async () => {
    await saveUsageCache(payload(), 1_700_000_000_000);
    expect(pluginStore.data.get("last")).toEqual({
      payload: payload(),
      at: 1_700_000_000_000,
    });
    const loaded = await loadUsageCache();
    expect(loaded?.at).toBe(1_700_000_000_000);
    expect(loaded?.payload.tokens).toBe(10);
  });

  it("drops anything that is not a payload this build understands", () => {
    // A half-shaped object is worse than nothing: the window would draw a summary over tables it
    // cannot fill, and the reader would believe it.
    for (const bad of [
      null,
      undefined,
      "payload",
      42,
      {},
      { payload: {} },
      { payload: { days: [] } },
      { payload: { days: [], offsetMinutes: 0 } },
      { payload: { days: [], offsetMinutes: 0, tokens: 1 } },
      { payload: payload(), at: "yesterday" },
      { payload: payload(), at: Number.NaN },
    ]) {
      expect(usableCache(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(usableCache({ payload: payload(), at: 5 })?.at).toBe(5);
  });

  it("reads nothing rather than failing when the store cannot be read", async () => {
    pluginStore.get.mockRejectedValueOnce(new Error("store is gone"));
    await expect(loadUsageCache()).resolves.toBeNull();
  });

  it("does not throw when the store cannot be written", async () => {
    // The window has already painted the live answer; a failed save costs the next open a few
    // seconds and nothing else.
    pluginStore.set.mockRejectedValueOnce(new Error("disk is full"));
    await expect(saveUsageCache(payload(), 1)).resolves.toBeUndefined();
  });
});
