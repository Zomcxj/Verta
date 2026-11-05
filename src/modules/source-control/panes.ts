import type { SourceControlFileEntry } from "./useSourceControlPanel";

/**
 * The source-control panel lists the working tree as two panes rather than one merged list: what is
 * still unstaged, and what has already been staged. The merged list answered "which files differ"
 * but not "what am I about to commit", and its checkboxes had three states to express that (a file
 * with both staged and unstaged edits showed `indeterminate`), so no single click meant one thing.
 *
 * A pane's checkbox is a *selection*, not the action: ticking nothing changes on disk, and the
 * button above the list acts on what is ticked - staging in the changes pane, unstaging in the
 * staged pane, where a file goes back to the working tree with its edits intact. A file with edits on
 * both sides belongs to both panes, which is honest: it does have changes on each side.
 */
export type ScmPane = "changes" | "staged";

/** The files this pane lists. */
export function filesInPane(
  entries: SourceControlFileEntry[],
  pane: ScmPane,
): SourceControlFileEntry[] {
  return entries.filter((entry) => (pane === "staged" ? entry.staged : entry.unstaged));
}

/** The ticked paths that this pane is showing, in the list's own order. */
export function selectedInPane(
  entries: SourceControlFileEntry[],
  pane: ScmPane,
  selected: ReadonlySet<string>,
): string[] {
  return filesInPane(entries, pane)
    .map((entry) => entry.path)
    .filter((path) => selected.has(path));
}

/** Whether every file in the pane is ticked - what the header checkbox shows. */
export function allInPaneSelected(
  entries: SourceControlFileEntry[],
  pane: ScmPane,
  selected: ReadonlySet<string>,
): boolean {
  const paths = filesInPane(entries, pane).map((entry) => entry.path);
  return paths.length > 0 && paths.every((path) => selected.has(path));
}

/**
 * The header checkbox: tick every file in the pane, or untick every file in it. Only this pane's
 * paths are touched, so a selection built in the other pane is not thrown away by looking at it.
 */
export function togglePaneSelection(
  entries: SourceControlFileEntry[],
  pane: ScmPane,
  selected: ReadonlySet<string>,
): Set<string> {
  const paths = filesInPane(entries, pane).map((entry) => entry.path);
  const next = new Set(selected);
  if (paths.length > 0 && paths.every((path) => next.has(path))) {
    for (const path of paths) next.delete(path);
  } else {
    for (const path of paths) next.add(path);
  }
  return next;
}

/** What the button above the list does to the ticked files. */
export function paneAction(pane: ScmPane): "stage" | "unstage" {
  return pane === "staged" ? "unstage" : "stage";
}
