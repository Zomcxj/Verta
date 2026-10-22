import { describe, expect, it } from "vitest";

import { groupByTool, sortByRecent } from "./sessionGroups";
import type { AgentSession } from "./types";

function session(
  id: string,
  tool: AgentSession["tool"],
  updatedAtMs: number,
): AgentSession {
  return {
    tool,
    id,
    title: id,
    cwd: `/work/${id}`,
    updatedAtMs,
    parentId: null,
    distro: null,
  };
}

const LIST = [
  session("pi-old", "pi", 100),
  session("oc-new", "opencode", 300),
  session("pi-new", "pi", 500),
  session("oc-old", "opencode", 200),
];
const TOOLS: AgentSession["tool"][] = ["opencode", "pi"];

describe("sortByRecent", () => {
  it("newest first", () => {
    expect(sortByRecent(LIST).map((s) => s.id)).toEqual([
      "pi-new",
      "oc-new",
      "oc-old",
      "pi-old",
    ]);
  });

  it("leaves the input untouched", () => {
    const input = [...LIST];
    sortByRecent(input);
    expect(input.map((s) => s.id)).toEqual(LIST.map((s) => s.id));
  });
});

describe("groupByTool", () => {
  it("keeps everything in one list by default", () => {
    const groups = groupByTool(LIST, TOOLS, "all");
    expect(groups).toHaveLength(1);
    expect(groups[0].tool).toBeNull();
    expect(groups[0].sessions.map((s) => s.id)).toEqual([
      "pi-new",
      "oc-new",
      "oc-old",
      "pi-old",
    ]);
  });

  it("splits by agent in the configured tool order", () => {
    const groups = groupByTool(LIST, TOOLS, "tool");
    expect(groups.map((g) => g.tool)).toEqual(["opencode", "pi"]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["oc-new", "oc-old"]);
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["pi-new", "pi-old"]);
  });

  it("drops an agent that has no sessions", () => {
    const onlyPi = LIST.filter((s) => s.tool === "pi");
    expect(groupByTool(onlyPi, TOOLS, "tool").map((g) => g.tool)).toEqual(["pi"]);
  });

  it("still lists sessions whose tool is not in the known list", () => {
    const odd = [...LIST, session("mystery", "opencode", 50)];
    odd[odd.length - 1].tool = "ghost" as AgentSession["tool"];
    const groups = groupByTool(odd, TOOLS, "tool");
    const last = groups[groups.length - 1];
    expect(last.tool).toBeNull();
    expect(last.sessions.map((s) => s.id)).toEqual(["mystery"]);
  });

  it("an empty list still yields one empty group", () => {
    const groups = groupByTool([], TOOLS, "tool");
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toEqual([]);
  });
});
