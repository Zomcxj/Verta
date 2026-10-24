import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WireRemoteRepo,
  WireRemoteReposPayload,
} from "@/lib/native";

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

const REPO: WireRemoteRepo = {
  fullName: "me/verta",
  owner: "me",
  name: "verta",
  isPrivate: true,
  isFork: false,
  isArchived: false,
  language: "TypeScript",
  pushedAt: "2026-10-24T00:00:00Z",
  description: "a workbench",
  webUrl: "https://github.com/me/verta",
};

const READY: WireRemoteReposPayload = {
  kind: "ready",
  login: "me",
  accountName: "Me",
  repos: [REPO],
  truncated: false,
  error: null,
};

const LOGGED_OUT: WireRemoteReposPayload = {
  kind: "notLoggedIn",
  login: null,
  accountName: null,
  repos: [],
  truncated: false,
  error: null,
};

describe("parseRepoSnapshot", () => {
  it("refuses a file that could not be reopened on", async () => {
    const { parseRepoSnapshot } = await import("./listStore");
    expect(parseRepoSnapshot(null)).toBeNull();
    expect(parseRepoSnapshot({ at: 1 })).toBeNull();
    expect(parseRepoSnapshot({ at: "1", payload: READY })).toBeNull();
    // A state that describes this machine right now is not worth restoring.
    expect(parseRepoSnapshot({ at: 1, payload: LOGGED_OUT })).toBeNull();
    // A ready list without its rows would draw an empty panel.
    expect(
      parseRepoSnapshot({ at: 1, payload: { ...READY, repos: null } }),
    ).toBeNull();
  });

  it("takes a ready list", async () => {
    const { parseRepoSnapshot } = await import("./listStore");
    const parsed = parseRepoSnapshot({ at: 3, payload: READY });
    expect(parsed?.at).toBe(3);
    expect(parsed?.payload.repos.length).toBe(1);
  });
});

describe("listStore", () => {
  it("keeps a ready list for the next window", async () => {
    const store = await import("./listStore");
    store.rememberRepoSnapshot({ at: 3, payload: READY });
    const loaded = await store.readRepoSnapshot();
    expect(loaded?.at).toBe(3);
    expect(loaded?.payload.login).toBe("me");
    expect(loaded?.payload.repos.length).toBe(1);
  });

  it("never writes a state of this machine", async () => {
    const store = await import("./listStore");
    store.rememberRepoSnapshot({ at: 4, payload: LOGGED_OUT });
    expect(state.writes).toEqual([]);
    // The next window still opens on the last real list.
    expect(await store.readRepoSnapshot()).toBeNull();
  });
});