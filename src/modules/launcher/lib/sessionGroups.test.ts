import { describe, expect, it } from "vitest";

import { groupByProject, groupBySource, groupByTool, sortByRecent } from "./sessionGroups";
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

/** A session in a distro: same shape, `distro` set instead of null. */
function inDistro(session: AgentSession, distro: string): AgentSession {
  return { ...session, distro };
}

describe("groupBySource", () => {
  it("keeps this machine first even when a distro session is the newest", () => {
    // The reported bug: a WSL session written to a second ago lifted the whole WSL block above this
    // machine's, because the groups were built by walking the time-sorted list.
    const wsl = inDistro(session("wsl-hottest", "opencode", 9_000), "Ubuntu-22.04");
    const groups = groupBySource([wsl, ...LIST], TOOLS, "all");
    expect(groups.map((g) => g.distro)).toEqual([null, "Ubuntu-22.04"]);
    // And the distro block is still newest-first inside itself.
    expect(groups[1].sections[0].sessions.map((s) => s.id)).toEqual(["wsl-hottest"]);
    // This machine's rows are untouched by the distro session's age.
    expect(groups[0].sections[0].sessions.map((s) => s.id)).toEqual([
      "pi-new",
      "oc-new",
      "oc-old",
      "pi-old",
    ]);
  });

  it("orders several distros by name, not by when they were last written", () => {
    const groups = groupBySource(
      [
        inDistro(session("b-new", "opencode", 900), "Ubuntu-24.04"),
        inDistro(session("a-old", "opencode", 100), "Debian"),
        ...LIST,
      ],
      TOOLS,
      "all",
    );
    expect(groups.map((g) => g.distro)).toEqual([null, "Debian", "Ubuntu-24.04"]);
  });

  it("keeps the agent sections' fixed order inside each source", () => {
    const wsl = inDistro(session("w-pi", "pi", 800), "Ubuntu-22.04");
    const groups = groupBySource([wsl, ...LIST], TOOLS, "tool");
    expect(groups[1].sections.map((g) => g.tool)).toEqual(["pi"]);
    expect(groups[0].sections.map((g) => g.tool)).toEqual(["opencode", "pi"]);
  });

  it("an empty list still yields one empty block for this machine", () => {
    const groups = groupBySource([], TOOLS, "all");
    expect(groups).toHaveLength(1);
    expect(groups[0].distro).toBeNull();
    expect(groups[0].sections[0].sessions).toEqual([]);
  });
});

/** A session that ran in a given folder. */
function inFolder(id: string, cwd: string, updatedAtMs = 100): AgentSession {
  return { ...session(id, "pi", updatedAtMs), cwd };
}

describe("groupByProject", () => {
  it("names a section after the folder the session ran in", () => {
    const groups = groupByProject(
      [inFolder("a", "F:/work/app")],
      [],
      null,
      "Other",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("app");
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a"]);
  });

  it("puts a session under the deepest registered project", () => {
    const groups = groupByProject(
      [
        inFolder("deep", "F:/work/app/packages/ui"),
        inFolder("top", "F:/work/app"),
      ],
      [
        { path: "F:/work", distro: null },
        { path: "F:/work/app", distro: null },
      ],
      null,
      "Other",
    );
    // `F:/work` holds no session of its own, so it draws nothing; both rows are `app`'s.
    expect(groups.map((g) => g.label)).toEqual(["app"]);
    expect(groups[0].sessions.map((s) => s.id).sort()).toEqual(["deep", "top"]);
  });

  it("keeps two folders that share a name apart, keyed by path", () => {
    const groups = groupByProject(
      [inFolder("c", "C:/a/web"), inFolder("d", "D:/b/web")],
      [],
      null,
      "Other",
    );
    expect(groups.map((g) => g.label)).toEqual(["web", "web"]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it("reads one folder written two ways as one group", () => {
    const groups = groupByProject(
      [inFolder("a", "F:/work/app"), inFolder("b", "F:\\work\\app\\")],
      [],
      null,
      "Other",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toHaveLength(2);
  });

  it("orders the project list first, then unknown folders by name, then no-cwd sessions last", () => {
    const groups = groupByProject(
      [
        inFolder("z", "F:/work/zeta"),
        inFolder("a", "F:/work/alpha"),
        inFolder("reg", "F:/reg/registered"),
        inFolder("none", ""),
      ],
      [{ path: "F:/reg/registered", distro: null }],
      null,
      "Other",
    );
    expect(groups.map((g) => g.label)).toEqual([
      "registered",
      "alpha",
      "zeta",
      "Other",
    ]);
    expect(groups[3].sessions.map((s) => s.id)).toEqual(["none"]);
  });

  it("does not match this machine's projects against a distro's sessions", () => {
    const groups = groupByProject(
      [inDistro(inFolder("w", "/home/x/app"), "Ubuntu")],
      [{ path: "C:/work/app", distro: null }],
      "Ubuntu",
      "Other",
    );
    expect(groups.map((g) => g.label)).toEqual(["app"]);
    expect(groups[0].key).toBe("/home/x/app");
  });

  it("still yields one empty section, so the empty state has somewhere to draw", () => {
    const groups = groupByProject(
      [],
      [{ path: "F:/work", distro: null }],
      null,
      "Other",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toEqual([]);
  });
});

describe("groupBySource by project", () => {
  it("groups by project inside each source, with a heading for each", () => {
    const groups = groupBySource(
      [inFolder("local", "F:/work/app"), inDistro(inFolder("wsl", "/home/x/other"), "Ubuntu")],
      TOOLS,
      "project",
      [{ path: "F:/work/app", distro: null }],
      "Other",
    );
    expect(groups.map((g) => g.distro)).toEqual([null, "Ubuntu"]);
    expect(groups[0].sections.map((s) => s.label)).toEqual(["app"]);
    expect(groups[1].sections.map((s) => s.label)).toEqual(["other"]);
  });
});
