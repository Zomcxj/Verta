import type { AgentSession } from "@/modules/launcher";
import { describe, expect, it } from "vitest";
import {
  cycleSort,
  filterRows,
  sessionBelongsToProject,
  sessionsForProject,
  sortRows,
  stateOf,
  type SortState,
} from "./rows";
import type { ProjectRow, ProjectStatus } from "./types";

const LOCAL = { kind: "local" } as const;
const WSL = { kind: "wsl", distro: "Ubuntu-22.04" } as const;

function status(over: Partial<ProjectStatus>): ProjectStatus {
  return {
    path: "F:\\work\\Verta",
    name: "Verta",
    workspace: LOCAL,
    kind: "repo",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    detached: false,
    dirty: 0,
    stashed: 0,
    error: null,
    ...over,
  };
}

function row(over: Partial<ProjectRow>): ProjectRow {
  return {
    path: "F:\\work\\Verta",
    workspace: LOCAL,
    managed: true,
    status: status({}),
    checking: false,
    ...over,
  };
}

describe("stateOf", () => {
  it("reports the errors before anything else", () => {
    expect(stateOf(status({ kind: "missing" })).key).toBe(
      "projects.state.missing",
    );
    expect(stateOf(status({ kind: "notRepo" })).key).toBe(
      "projects.state.notRepo",
    );
    expect(stateOf(status({ kind: "error", error: "boom" })).tone).toBe("error");
  });

  it("walks the git states in the order people care about", () => {
    expect(stateOf(status({ dirty: 3 }))).toEqual({
      tone: "dirty",
      key: "projects.state.dirty",
      params: { count: 3 },
    });
    expect(stateOf(status({ ahead: 2 })).key).toBe("projects.state.ahead");
    expect(stateOf(status({ behind: 1 })).key).toBe("projects.state.behind");
    expect(stateOf(status({ ahead: 2, behind: 1 })).key).toBe(
      "projects.state.diverged",
    );
    expect(stateOf(status({})).key).toBe("projects.state.clean");
  });

  it("says so when the row has not been checked yet", () => {
    expect(stateOf(null)).toEqual({
      tone: "unknown",
      key: "projects.state.unchecked",
    });
  });

  it("does not call a detached head a branch name", () => {
    expect(stateOf(status({ detached: true, branch: "abc1234" })).tone).toBe(
      "clean",
    );
  });
});

describe("cycleSort", () => {
  it("cycles ascending, descending, then off", () => {
    const first = cycleSort(null, "name");
    expect(first).toEqual({ key: "name", ascending: true });
    const second = cycleSort(first, "name");
    expect(second).toEqual({ key: "name", ascending: false });
    expect(cycleSort(second, "name")).toBeNull();
  });

  it("starts over when a different column is clicked", () => {
    const current: SortState = { key: "name", ascending: false };
    expect(cycleSort(current, "state")).toEqual({
      key: "state",
      ascending: true,
    });
  });
});

describe("sortRows", () => {
  const rows = [
    row({ path: "F:\\b", status: status({ name: "beta", dirty: 2 }) }),
    row({ path: "F:\\a", status: status({ name: "Alpha", dirty: 0 }) }),
  ];

  it("leaves the order alone when there is no sort", () => {
    expect(sortRows(rows, null).map((r) => r.path)).toEqual(["F:\\b", "F:\\a"]);
  });

  it("sorts by name and does not mutate the input", () => {
    const sorted = sortRows(rows, { key: "name", ascending: true });
    expect(sorted.map((r) => r.path)).toEqual(["F:\\a", "F:\\b"]);
    expect(rows.map((r) => r.path)).toEqual(["F:\\b", "F:\\a"]);
  });

  it("puts the more serious state first when sorting by state ascending", () => {
    const rows2 = [
      row({ path: "F:\\clean", status: status({}) }),
      row({ path: "F:\\dirty", status: status({ dirty: 1 }) }),
      row({ path: "F:\\missing", status: status({ kind: "missing" }) }),
    ];
    expect(
      sortRows(rows2, { key: "state", ascending: true }).map((r) => r.path),
    ).toEqual(["F:\\missing", "F:\\dirty", "F:\\clean"]);
  });
});

describe("filterRows", () => {
  it("matches anywhere in the path, case-insensitively", () => {
    const rows = [row({ path: "F:\\work\\Verta" }), row({ path: "F:\\work\\Other" })];
    expect(filterRows(rows, "verta").map((r) => r.path)).toEqual([
      "F:\\work\\Verta",
    ]);
    expect(filterRows(rows, "  ")).toHaveLength(2);
  });
});

function session(over: Partial<AgentSession>): AgentSession {
  return {
    tool: "opencode",
    id: "s1",
    title: "t",
    cwd: "F:\\work\\Verta",
    updatedAtMs: 1,
    parentId: null,
    distro: null,
    ...over,
  };
}

describe("session matching", () => {
  it("matches only the exact project root", () => {
    expect(sessionBelongsToProject(session({}), row({}))).toBe(true);
    expect(
      sessionBelongsToProject(session({ cwd: "F:\\work\\Verta\\src" }), row({})),
    ).toBe(false);
  });

  it("keeps the environments apart", () => {
    const wslRow = row({ workspace: WSL });
    expect(sessionBelongsToProject(session({}), wslRow)).toBe(false);
    expect(
      sessionBelongsToProject(
        session({ distro: "Ubuntu-22.04" }),
        wslRow,
      ),
    ).toBe(true);
    expect(
      sessionBelongsToProject(session({ distro: "Debian" }), wslRow),
    ).toBe(false);
  });

  it("lists the newest session first", () => {
    const sessions = [
      session({ id: "old", updatedAtMs: 10 }),
      session({ id: "new", updatedAtMs: 99 }),
    ];
    expect(
      sessionsForProject(sessions, row({})).map((s) => s.id),
    ).toEqual(["new", "old"]);
  });
});