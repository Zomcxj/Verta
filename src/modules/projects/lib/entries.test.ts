import type { AgentSession } from "@/modules/launcher";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { describe, expect, it } from "vitest";
import { discoveredEntries, entriesFromPaths } from "./entries";

describe("entriesFromPaths", () => {
  it("reads a drive path as this machine", () => {
    expect(entriesFromPaths(["F:\\work\\Verta"])).toEqual([
      {
        path: "F:\\work\\Verta",
        workspace: { kind: "local" },
        managed: true,
      },
    ]);
  });

  it("reads a Linux path as the distro that was used last", () => {
    usePreferencesStore.setState({ lastWslDistro: "Ubuntu-22.04" });
    expect(entriesFromPaths(["/home/cxj/workspace/token-monitor"])).toEqual([
      {
        path: "/home/cxj/workspace/token-monitor",
        workspace: { kind: "wsl", distro: "Ubuntu-22.04" },
        managed: true,
      },
    ]);
    usePreferencesStore.setState({ lastWslDistro: null });
  });
});

function session(over: Partial<AgentSession>): AgentSession {
  return {
    tool: "opencode",
    id: "s1",
    title: "t",
    cwd: "/home/cxj/workspace/token-monitor",
    updatedAtMs: 1,
    parentId: null,
    distro: "Ubuntu-22.04",
    ...over,
  };
}

describe("discoveredEntries", () => {
  it("turns distro session cwds into unmanaged projects", () => {
    const found = discoveredEntries(
      [session({}), session({ id: "s2" })],
      [],
    );
    expect(found).toEqual([
      {
        path: "/home/cxj/workspace/token-monitor",
        workspace: { kind: "wsl", distro: "Ubuntu-22.04" },
        managed: false,
      },
    ]);
  });

  it("never duplicates something already on the list", () => {
    const managed = entriesFromPaths(["/home/cxj/workspace/token-monitor"]);
    expect(discoveredEntries([session({})], managed)).toEqual([]);
  });

  it("ignores local sessions, which the list itself covers", () => {
    expect(discoveredEntries([session({ distro: null })], [])).toEqual([]);
  });
});