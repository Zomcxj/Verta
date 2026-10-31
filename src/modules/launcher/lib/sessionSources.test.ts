import { describe, expect, it } from "vitest";
import {
  allRows,
  byNewestFirst,
  keptSources,
  noSourceRows,
  withSourceRows,
  withoutSource,
} from "./sessionSources";
import type { AgentSession } from "./types";

/**
 * What the sessions list does while one of its sources is still being read.
 *
 * The bug this is written against (reported 2026-10-31, reproduced by pressing the panel's own
 * Refresh and sampling the drawn rows every 10 ms): the list was rebuilt from the sources that had
 * answered so far, so local opencode answering in 50 to 150 ms drew a list without local pi's four
 * rows, which only came back when pi answered 2.6 to 3.3 s later. The tests below are that sequence
 * as data, plus the two edges the per-source keeping has to get right: a source that stops being
 * asked, and a source that failed.
 */

const session = (
  id: string,
  updatedAtMs: number,
  extra: Partial<AgentSession> = {},
): AgentSession => ({
  tool: "opencode",
  id,
  title: id,
  cwd: "/work",
  updatedAtMs,
  parentId: null,
  distro: null,
  ...extra,
});

const OPENCODE = "::opencode";
const PI = "::pi";

/** Two of this machine's opencode sessions and four of its pi ones, as the panel reads them. */
const localOpencode = () => [session("oc-1", 5_000), session("oc-2", 4_000)];
const localPi = () => [
  session("pi-1", 9_000, { tool: "pi" }),
  session("pi-2", 8_000, { tool: "pi" }),
  session("pi-3", 7_000, { tool: "pi" }),
  session("pi-4", 6_000, { tool: "pi" }),
];

const ids = (rows: readonly AgentSession[]) => rows.map((row) => row.id);

describe("the rows kept per source", () => {
  it("keeps the slow source's rows while the fast source answers again", () => {
    // Both sources answered once.
    let rows = withSourceRows(noSourceRows<AgentSession>(), PI, localPi());
    rows = withSourceRows(rows, OPENCODE, localOpencode());
    expect(ids(allRows(rows, byNewestFirst))).toEqual([
      "pi-1",
      "pi-2",
      "pi-3",
      "pi-4",
      "oc-1",
      "oc-2",
    ]);

    // The read that used to make them vanish: opencode settles first and replaces its own rows.
    rows = withSourceRows(rows, OPENCODE, [
      session("oc-3", 10_000),
      ...localOpencode(),
    ]);
    // The four pi rows are still drawn, which is the whole point of keeping them per source.
    expect(ids(allRows(rows, byNewestFirst))).toEqual([
      "oc-3",
      "pi-1",
      "pi-2",
      "pi-3",
      "pi-4",
      "oc-1",
      "oc-2",
    ]);

    // And when pi does answer, it replaces its own four and nothing else.
    rows = withSourceRows(
      rows,
      PI,
      [session("pi-5", 11_000, { tool: "pi" }), ...localPi()],
    );
    expect(ids(allRows(rows, byNewestFirst))).toEqual([
      "pi-5",
      "oc-3",
      "pi-1",
      "pi-2",
      "pi-3",
      "pi-4",
      "oc-1",
      "oc-2",
    ]);
  });

  it("takes an empty answer as an answer", () => {
    // A source that answered with nothing has to drop its rows: keeping the previous read's would
    // show sessions that are no longer in the store.
    let rows = withSourceRows(noSourceRows<AgentSession>(), PI, localPi());
    rows = withSourceRows(rows, PI, []);
    expect(ids(allRows(rows, byNewestFirst))).toEqual([]);
  });

  it("stops drawing a source a read is no longer asking for", () => {
    // The WSL toggle going off: the distro is not asked any more, so its rows must not stay.
    let rows = withSourceRows(noSourceRows<AgentSession>(), "Ubuntu-22.04::pi", [
      session("wsl-1", 9_000, { distro: "Ubuntu-22.04", tool: "pi" }),
    ]);
    rows = withSourceRows(rows, PI, localPi());
    rows = keptSources(rows, new Set([PI]));
    expect(ids(allRows(rows, byNewestFirst))).toEqual([
      "pi-1",
      "pi-2",
      "pi-3",
      "pi-4",
    ]);
    // The source is still asked, so a read still in flight keeps its rows on screen.
    expect(ids(allRows(keptSources(rows, new Set([PI])), byNewestFirst))).toEqual([
      "pi-1",
      "pi-2",
      "pi-3",
      "pi-4",
    ]);
  });

  it("drops a source that failed to answer", () => {
    // Rows from the previous read would claim a store that could not be read at all is unchanged.
    // The source is still in the asked set, so only the failure path can drop it.
    let rows = withSourceRows(noSourceRows<AgentSession>(), PI, localPi());
    rows = withSourceRows(rows, OPENCODE, localOpencode());
    rows = withoutSource(rows, PI);
    expect(ids(allRows(rows, byNewestFirst))).toEqual(["oc-1", "oc-2"]);
    // Dropping a source that never answered is a no-op, not a new cache.
    expect(withoutSource(rows, PI)).toBe(rows);
  });

  it("draws the same list whatever order the sources answered in", () => {
    // The list is redrawn on every settle, so two rows of equal age must not swap places because a
    // source happened to answer first on one read and second on the next. Equal ages are what makes
    // this a real question: with `sort` stable, the tie goes to the source walk, which is sorted.
    const opencode = [session("oc-1", 5_000)];
    const pi = [session("pi-1", 5_000, { tool: "pi" })];
    const oneOrder = withSourceRows(
      withSourceRows(noSourceRows<AgentSession>(), PI, pi),
      OPENCODE,
      opencode,
    );
    const otherOrder = withSourceRows(
      withSourceRows(noSourceRows<AgentSession>(), OPENCODE, opencode),
      PI,
      pi,
    );
    expect(ids(allRows(oneOrder, byNewestFirst))).toEqual(
      ids(allRows(otherOrder, byNewestFirst)),
    );
  });
});
