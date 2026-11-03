/**
 * What a change of the open path means for the document already in hand.
 *
 * A path changes for two reasons: the file was renamed or moved, which is the same document at a
 * new name, or the pane is being pointed at a different file. The first keeps everything - the
 * buffer, its unsaved flag and the saved baseline - and re-keys the draft; the second reads the new
 * file from disk.
 *
 * The answer comes from the caller's word (`renamedFrom`), not from "the path is not what it was".
 * Guessing "renamed" would write one file's buffer into another, and guessing "different file" would
 * throw away the edits the user has not saved, so the only safe default is the one that loses
 * nothing if the caller is wrong - and a re-read of a file that did not move loses nothing.
 */
export type DocumentPathChange = "none" | "keep" | "load";

export function documentPathChange({
  previousPath,
  path,
  renamedFrom,
}: {
  previousPath: string | null;
  path: string;
  renamedFrom?: string | null;
}): DocumentPathChange {
  if (previousPath === path) return "none";
  if (previousPath !== null && renamedFrom === previousPath) return "keep";
  return "load";
}
