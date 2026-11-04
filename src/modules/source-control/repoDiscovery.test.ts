import { describe, expect, it } from "vitest";
import {
  orderByRecency,
  pickRepository,
  shouldAdoptPick,
  type DiscoveredRepo,
} from "./repoDiscovery";

const repo = (path: string, committedAtMs: number | null = null): DiscoveredRepo => ({
  path,
  committedAtMs,
});

describe("orderByRecency", () => {
  it("puts the most recent commit first", () => {
    const ordered = orderByRecency([
      repo("C:/w/old", 1_000),
      repo("C:/w/new", 9_000),
      repo("C:/w/mid", 5_000),
    ]);
    expect(ordered.map((r) => r.path)).toEqual(["C:/w/new", "C:/w/mid", "C:/w/old"]);
  });

  it("puts a repository with no commits last, whichever way it sorts", () => {
    // `null` would sort first if this were left to the default comparison, which is the opposite
    // of "most recently committed" - a checkout nobody has committed to is the least interesting.
    const ordered = orderByRecency([
      repo("C:/w/never"),
      repo("C:/w/committed", 1_000),
      repo("C:/w/also-never"),
    ]);
    expect(ordered.map((r) => r.path)).toEqual([
      "C:/w/committed",
      "C:/w/also-never",
      "C:/w/never",
    ]);
  });

  it("breaks a tie by path so the order is stable", () => {
    const ordered = orderByRecency([repo("C:/w/b", 5_000), repo("C:/w/a", 5_000)]);
    expect(ordered.map((r) => r.path)).toEqual(["C:/w/a", "C:/w/b"]);
  });

  it("does not reorder the array it was given", () => {
    const input = [repo("C:/w/a", 1_000), repo("C:/w/b", 9_000)];
    orderByRecency(input);
    expect(input.map((r) => r.path)).toEqual(["C:/w/a", "C:/w/b"]);
  });
});

describe("pickRepository", () => {
  it("shows the folder itself when it is a repository, without offering a choice", () => {
    // Nothing was ambiguous: the folder the session opened at is one checkout.
    expect(pickRepository("C:/w/app", [repo("C:/w/app", 1_000)])).toEqual({
      kind: "repository",
      path: "C:/w/app",
    });
  });

  it("shows the folder itself even when it holds repositories below it", () => {
    // A checkout's own children belong to it; the scan stops at the first `.git`.
    const pick = pickRepository("C:/w/app", [repo("C:/w/app", 1_000)]);
    expect(pick.kind).toBe("repository");
  });

  it("shows the only repository below the folder", () => {
    expect(
      pickRepository("C:/w", [repo("C:/w/site", 1_000)]),
    ).toEqual({ kind: "repository", path: "C:/w/site" });
  });

  it("chooses the most recently committed one when there are several", () => {
    const pick = pickRepository("C:/w", [
      repo("C:/w/old", 1_000),
      repo("C:/w/new", 9_000),
    ]);
    expect(pick).toMatchObject({ kind: "chosen", path: "C:/w/new" });
    if (pick.kind !== "chosen") return;
    expect(pick.options.map((r) => r.path)).toEqual(["C:/w/new", "C:/w/old"]);
  });

  it("says nothing when the folder holds no repository", () => {
    expect(pickRepository("C:/w", [])).toEqual({ kind: "none" });
  });

  it("compares the folder in the spelling the scan used", () => {
    expect(
      pickRepository("c:/w/App/".replace(/\//g, "\\"), [repo("C:/w/app", 1_000)]),
    ).toEqual({ kind: "repository", path: "C:/w/app" });
  });

  it("says nothing when it does not know the folder", () => {
    expect(pickRepository(null, [])).toEqual({ kind: "none" });
  });
});

describe("shouldAdoptPick", () => {
  it("adopts the first answer", () => {
    expect(shouldAdoptPick({ kind: "repository", path: "C:/w/app" }, false)).toBe(
      true,
    );
  });

  it("never moves a panel the user has already decided", () => {
    // The whole point: switching tabs away and back, re-scanning, or opening the session again
    // must not silently put the panel on a different repository.
    expect(shouldAdoptPick({ kind: "chosen", path: "C:/w/x", options: [] }, true)).toBe(
      false,
    );
  });

  it("does not adopt an empty answer over a loaded one", () => {
    expect(shouldAdoptPick({ kind: "none" }, false)).toBe(false);
  });
});
