import type { PaneNode } from "@/modules/terminal";

/** How many panes a grouped terminal tab opens with. */
export type PaneCount = 1 | 2 | 3 | 4;

export type PanePlan = {
  paneTree: PaneNode;
  leafIds: number[];
};

/**
 * Splits one terminal tab into `count` panes. Layout: 1 fills the tab, 2 sit
 * side by side, 3 stack the last two, 4 form a 2x2 grid.
 */
export function createPanePlan(
  count: PaneCount,
  allocateId: () => number,
  cwd?: string,
): PanePlan {
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new RangeError("Pane count must be between 1 and 4.");
  }

  const leaves = Array.from({ length: count }, () => ({
    kind: "leaf" as const,
    id: allocateId(),
    cwd,
  }));
  const split = (dir: "row" | "col", children: PaneNode[]): PaneNode => ({
    kind: "split",
    id: allocateId(),
    dir,
    children,
  });

  switch (count) {
    case 1:
      return { paneTree: leaves[0], leafIds: leaves.map((leaf) => leaf.id) };
    case 2:
      return {
        paneTree: split("row", leaves),
        leafIds: leaves.map((leaf) => leaf.id),
      };
    case 3:
      return {
        paneTree: split("row", [
          leaves[0],
          split("col", [leaves[1], leaves[2]]),
        ]),
        leafIds: leaves.map((leaf) => leaf.id),
      };
    case 4:
      return {
        paneTree: split("row", [
          split("col", [leaves[0], leaves[1]]),
          split("col", [leaves[2], leaves[3]]),
        ]),
        leafIds: leaves.map((leaf) => leaf.id),
      };
  }
}