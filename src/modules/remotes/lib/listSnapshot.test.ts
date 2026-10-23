import { afterEach, describe, expect, it } from "vitest";
import {
  LIST_SNAPSHOT_TTL_MS,
  readListSnapshot,
  forgetListSnapshot,
  resetListSnapshots,
  writeListSnapshot,
} from "./listSnapshot";

const T0 = 5_000_000;

afterEach(() => {
  resetListSnapshots();
});

describe("list snapshots", () => {
  it("returns what was stored under the same key", () => {
    writeListSnapshot("runs:acme/site", ["a"], T0);
    expect(readListSnapshot<string[]>("runs:acme/site", undefined, T0)).toEqual([
      "a",
    ]);
  });

  it("keeps repos apart", () => {
    writeListSnapshot("runs:acme/site", ["a"], T0);
    expect(readListSnapshot("runs:acme/other", undefined, T0)).toBeNull();
  });

  it("expires a list older than the TTL", () => {
    writeListSnapshot("issues:acme/site:open", ["a"], T0);
    expect(
      readListSnapshot(
        "issues:acme/site:open",
        undefined,
        T0 + LIST_SNAPSHOT_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  it("still serves a list inside the TTL", () => {
    writeListSnapshot("issues:acme/site:open", ["a"], T0);
    expect(
      readListSnapshot(
        "issues:acme/site:open",
        undefined,
        T0 + LIST_SNAPSHOT_TTL_MS - 1,
      ),
    ).toEqual(["a"]);
  });

  it("re-reads after a key is forgotten", () => {
    writeListSnapshot("runs:acme/site", ["a"], T0);
    forgetListSnapshot("runs:acme/site");
    expect(readListSnapshot("runs:acme/site", undefined, T0)).toBeNull();
  });

  it("holds a falsy value, which is not the same as holding nothing", () => {
    writeListSnapshot("runs:acme/site", null, T0);
    expect(readListSnapshot("runs:acme/site", undefined, T0)).toBeNull();
    writeListSnapshot("runs:acme/site", 0, T0);
    expect(readListSnapshot("runs:acme/site", undefined, T0)).toBe(0);
  });
});
