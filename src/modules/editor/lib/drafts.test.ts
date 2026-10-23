import { beforeEach, describe, expect, it, vi } from "vitest";

// The store is backed by an in-memory Map, which also lets the two racing writes below be checked.
vi.mock("@tauri-apps/plugin-store", () => {
  const files = new Map<string, Map<string, unknown>>();
  class LazyStore {
    private readonly file: Map<string, unknown>;
    constructor(name: string) {
      let file = files.get(name);
      if (!file) {
        file = new Map<string, unknown>();
        files.set(name, file);
      }
      this.file = file;
    }
    async get(key: string) {
      return this.file.get(key);
    }
    async set(key: string, value: unknown) {
      this.file.set(key, value);
    }
    async save() {}
  }
  return { LazyStore };
});

beforeEach(() => {
  vi.resetModules();
});

describe("draftKey", () => {
  it("normalizes separators and trims", async () => {
    const { draftKey } = await import("./drafts");
    expect(draftKey("  F:\\work\\a.txt ")).toBe("F:/work/a.txt");
    expect(draftKey("F:/work/a.txt")).toBe("F:/work/a.txt");
  });

  it("keeps case, so two WSL files stay two drafts", async () => {
    const { draftKey } = await import("./drafts");
    expect(draftKey("/home/me/File.txt")).not.toBe(draftKey("/home/me/file.txt"));
  });
});

describe("draftOffersRecovery", () => {
  it("is false without a draft and false when the draft matches the file", async () => {
    const { draftOffersRecovery } = await import("./drafts");
    expect(draftOffersRecovery(null, "same")).toBe(false);
    expect(draftOffersRecovery({ text: "same", at: 1 }, "same")).toBe(false);
  });

  it("is true when the draft holds text the file does not", async () => {
    const { draftOffersRecovery } = await import("./drafts");
    expect(draftOffersRecovery({ text: "typed", at: 1 }, "on disk")).toBe(true);
  });
});

describe("putDraft", () => {
  it("refuses a draft larger than the per-draft cap", async () => {
    const { putDraft, MAX_DRAFT_BYTES } = await import("./drafts");
    const big = "x".repeat(MAX_DRAFT_BYTES + 1);
    expect(putDraft({}, "k", big, 1)).toEqual({});
  });

  it("keeps the newest and drops the oldest past the count cap", async () => {
    const { putDraft, MAX_DRAFTS } = await import("./drafts");
    let map = {};
    for (let i = 0; i < MAX_DRAFTS + 3; i += 1) {
      map = putDraft(map, `k${i}`, `text ${i}`, i);
    }
    const keys = Object.keys(map);
    expect(keys.length).toBe(MAX_DRAFTS);
    expect(keys).toContain(`k${MAX_DRAFTS + 2}`);
    expect(keys).not.toContain("k0");
  });

  it("takes a later write for the same path", async () => {
    const { putDraft } = await import("./drafts");
    const map = putDraft(putDraft({}, "k", "first", 1), "k", "second", 2);
    expect(map.k).toEqual({ text: "second", at: 2 });
  });
});

describe("removeDraft", () => {
  it("returns the same map when the key is absent", async () => {
    const { removeDraft } = await import("./drafts");
    const map = { a: { text: "a", at: 1 } };
    expect(removeDraft(map, "b")).toBe(map);
    expect(removeDraft(map, "a")).toEqual({});
  });
});

describe("store level", () => {
  it("round-trips a draft and drops it again", async () => {
    const drafts = await import("./drafts");
    await drafts.storeDraft("F:/work/a.txt", "typed");
    const stored = await drafts.readDraft("F:\\work\\a.txt");
    expect(stored?.text).toBe("typed");
    expect(typeof stored?.at).toBe("number");

    await drafts.dropDraft("F:/work/a.txt");
    expect(await drafts.readDraft("F:/work/a.txt")).toBeNull();
  });

  it("keeps both entries when two writes race", async () => {
    const drafts = await import("./drafts");
    await Promise.all([
      drafts.storeDraft("F:/work/a.txt", "one"),
      drafts.storeDraft("F:/work/b.txt", "two"),
    ]);
    expect((await drafts.readDraft("F:/work/a.txt"))?.text).toBe("one");
    expect((await drafts.readDraft("F:/work/b.txt"))?.text).toBe("two");
  });

  it("ignores a broken archive instead of throwing", async () => {
    const store = await import("@tauri-apps/plugin-store");
    const raw = new store.LazyStore("verta-drafts.json");
    await raw.set("drafts", { good: { text: "ok", at: 1 }, bad: "nope", worse: { at: 2 } });
    const drafts = await import("./drafts");
    expect(await drafts.readDraft("good")).toEqual({ text: "ok", at: 1 });
    expect(await drafts.readDraft("worse")).toBeNull();
  });
});