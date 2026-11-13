/**
 * Which region is the outermost one on each side, right now.
 *
 * The three regions are laid out as one sheet (`boundless`), and the sheet's own edge - the rounded
 * corner and the window's margin - belongs to whichever region is at the end of the row. It used to
 * belong to the *sidebar* and to the *right* panel by name, which is the same thing only while both
 * are open: collapsing a panel took the sheet's edge away with it, and the workspace - square in the
 * middle of the sheet by design - ended up flush against the window with a square corner (reported with
 * two screenshots: "收起时不要贴边，还是要圆角").
 *
 * Pure, so the truth table is a test rather than a screenshot: a region answers `true` only when it is
 * the last visible one on that side, and with both panels closed the workspace is both ends at once.
 */
export type ShellRegion = "sidebar" | "workspace" | "right";

export type ShellEdges = Record<ShellRegion, { left: boolean; right: boolean }>;

export function shellEdges(input: {
  /** Whether the sidebar is open (a collapsed panel is not on screen at all). */
  sidebar: boolean;
  /** Whether the right panel is open. */
  right: boolean;
}): ShellEdges {
  return {
    sidebar: { left: input.sidebar, right: false },
    workspace: { left: !input.sidebar, right: !input.right },
    right: { left: false, right: input.right },
  };
}
