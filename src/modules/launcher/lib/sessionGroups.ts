import {
  folderAtOrUnder,
  folderName,
  normalizeFolderPath,
} from "@/lib/pathContainment";
import type { AgentSession, AgentTool } from "./types";

/**
 * How the session list is laid out: `all` keeps one block sorted by time, `tool` splits
 * it into one section per agent, `project` into one section per folder the sessions ran
 * in.
 *
 * `all` is the default: most of the time people just want "what did I talk about
 * recently", and splitting by anything only means more scanning. Switch when actually
 * looking for a specific tool, or for what was done in a project.
 */
export type SessionGroupBy = "all" | "tool" | "project";

/** Newest first: both groupings honor it, so switching between them never reorders. */
export function sortByRecent(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export type SessionGroup = {
  /** `null` is a block with no agent heading: the single block, a project, "others". */
  tool: AgentTool | null;
  /** The heading above the section. Absent for the single `all` block. */
  label?: string;
  /**
   * Stable key for the section. Not the label: two projects on this machine can share a
   * folder name, and the project bar keys sections by it.
   */
  key: string;
  sessions: AgentSession[];
};

/**
 * Split into per-agent sections.
 *
 * Section order follows `tools` (the tool order fixed in settings), not session
 * counts or timestamps, otherwise one new message would reshuffle the whole list.
 * Tools with no sessions **do not appear**, and an empty list yields one empty
 * section so the list's own empty-state copy still shows.
 */
export function groupByTool(
  sessions: readonly AgentSession[],
  tools: readonly AgentTool[],
  groupBy: SessionGroupBy,
): SessionGroup[] {
  if (groupBy === "all") {
    return [{ tool: null, key: "all", sessions: sortByRecent(sessions) }];
  }
  const known = new Set<string>(tools);
  const groups: SessionGroup[] = tools.map((tool) => ({
    tool,
    key: `tool:${tool}`,
    sessions: sortByRecent(sessions.filter((session) => session.tool === tool)),
  }));
  // An unknown tool name turned up in storage: list it anyway rather than silently
  // swallowing it.
  const others = sessions.filter((session) => !known.has(session.tool));
  if (others.length > 0) {
    groups.push({
      tool: null,
      key: "tool:other",
      sessions: sortByRecent(others),
    });
  }
  const nonEmpty = groups.filter((group) => group.sessions.length > 0);
  if (nonEmpty.length === 0) {
    return [{ tool: tools[0] ?? null, key: "tool:none", sessions: [] }];
  }
  return nonEmpty;
}

/** One registered project: the folder, and the environment it lives in. */
export type ProjectRef = {
  path: string;
  /** `null` is this machine; a distro name is that distro. */
  distro: string | null;
};

/**
 * Split into per-folder sections, named after the folder.
 *
 * A session belongs to the **deepest registered project** its cwd sits in - registered
 * `F:/work/app` puts a session running in `F:/work/app/packages/ui` under `app`. A cwd
 * the project list does not know is its own section, named after its last segment; two
 * folders that share a name stay two sections, because the key is the path.
 *
 * Section order is fixed the way the project list is ordered, then the unknown folders by
 * name, then the sessions with no cwd at all. Sorting by recency here would make the
 * whole list jump on every message written, which is exactly what the source order
 * comment above `groupBySource` is about.
 */
export function groupByProject(
  sessions: readonly AgentSession[],
  projects: readonly ProjectRef[],
  /** The source being grouped: `null` for this machine, otherwise a distro. */
  distro: string | null,
  /** What to call the section holding sessions with no cwd. */
  otherLabel: string,
): SessionGroup[] {
  // Only this source's projects: a WSL session's cwd is a path inside the distro and never
  // matches a Windows folder, so the local table has nothing to say about it.
  const registered = projects
    .filter((project) => project.distro === distro)
    .map((project) => normalizeFolderPath(project.path))
    .filter((path) => path !== "");
  const registeredSet = new Set(registered);
  const deepestFirst = [...registered].sort(
    (left, right) => right.length - left.length,
  );

  const buckets = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const cwd = normalizeFolderPath(session.cwd ?? "");
    const owner =
      cwd === ""
        ? ""
        : (deepestFirst.find((root) => folderAtOrUnder(cwd, root)) ?? cwd);
    const bucket = buckets.get(owner);
    if (bucket) bucket.push(session);
    else buckets.set(owner, [session]);
  }

  const ordered: string[] = registered.filter((path) => buckets.has(path));
  const loose = [...buckets.keys()]
    .filter((owner) => owner !== "" && !registeredSet.has(owner))
    .sort((left, right) => {
      const byName = folderName(left).localeCompare(folderName(right));
      return byName !== 0 ? byName : left.localeCompare(right);
    });
  ordered.push(...loose);
  // A session that never said where it ran has no folder to be named after; it goes last
  // rather than under a blank heading, and an empty list still needs one block to draw its
  // own empty state in.
  if (buckets.has("")) ordered.push("");
  if (ordered.length === 0) {
    return [{ tool: null, key: "project:none", sessions: [] }];
  }

  return ordered.map((owner) => ({
    tool: null,
    key: owner === "" ? "project:other" : owner,
    label: owner === "" ? otherLabel : folderName(owner),
    sessions: sortByRecent(buckets.get(owner) ?? []),
  }));
}

/** One source's block: this machine (`null`) or one distro. */
export type SessionSourceGroup = {
  distro: string | null;
  sections: SessionGroup[];
};

/**
 * Split by source first, then by agent or by project inside each source.
 *
 * The **order of the sources is fixed**: this machine first, then each distro by name. It is not
 * the order the sessions arrive in. Building the groups by walking a time-sorted list made the
 * group order follow whatever happened to be newest, so a distro session written to a second ago
 * lifted the whole WSL block above this machine's - the list appearing to reorder itself for
 * reasons that have nothing to do with the rows in it. Someone who reads the first block as "my
 * work" does not want it to move because a build ran in a container.
 *
 * Inside a source nothing is pinned beyond recency: the agent sections keep their configured
 * order (or the project sections the project list's order), and each section is newest-first.
 */
export function groupBySource(
  sessions: readonly AgentSession[],
  tools: readonly AgentTool[],
  groupBy: SessionGroupBy,
  projects: readonly ProjectRef[] = [],
  otherLabel = "Other",
): SessionSourceGroup[] {
  const bySource = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const key = session.distro ?? "";
    const bucket = bySource.get(key);
    if (bucket) bucket.push(session);
    else bySource.set(key, [session]);
  }
  // `""` is this machine and sorts before every distro name, which is the order wanted; the
  // explicit comparator keeps it that way whatever a future locale does with `localeCompare`.
  const keys = [...bySource.keys()].sort((left, right) => {
    if (left === right) return 0;
    if (left === "") return -1;
    if (right === "") return 1;
    return left.localeCompare(right);
  });
  const sectionsOf = (key: string) => {
    const list = bySource.get(key) ?? [];
    return groupBy === "project"
      ? groupByProject(list, projects, key === "" ? null : key, otherLabel)
      : groupByTool(list, tools, groupBy);
  };
  const groups = keys.map((key) => ({
    distro: key === "" ? null : key,
    sections: sectionsOf(key),
  }));
  // Nothing to show still needs one empty block, so the list's own empty state has where to draw.
  return groups.length > 0 ? groups : [{ distro: null, sections: sectionsOf("") }];
}
