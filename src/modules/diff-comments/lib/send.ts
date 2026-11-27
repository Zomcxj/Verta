import { openTabForSession } from "@/modules/launcher";
import type { Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal/lib/panes";
import type { DiffComment } from "./comments";

/**
 * The pane showing a session's terminal, if one is open.
 *
 * This is the forward lookup the spec asks for: the tab records which session it was
 * opened for, and its pane tree gives the leaves. `sessionStateById` cannot be used - it
 * drops a session whose state is still null (a shell with no agent signal yet) and its
 * pty map is thrown away after each read, so a session opened as a plain shell would be
 * mistaken for "not in a Verta terminal".
 */
export function resolveLeafForSession(
  tabs: readonly Tab[],
  sessionId: string,
): number | null {
  const tab = openTabForSession(tabs, sessionId);
  if (tab?.kind !== "terminal") return null;
  const leaves = leafIds(tab.paneTree);
  return leaves.length > 0 ? leaves[0] : null;
}

/**
 * The single line a terminal takes, matching `format_comments` on the Rust side.
 *
 * Kept in step with `diff_comments/format.rs` by the same rules: the marker once, entries
 * joined by ` ;; `, separators escaped, newlines flattened. A newline would be Enter to
 * the terminal, so nothing here may contain one.
 */
export function formatComments(comments: readonly DiffComment[]): string {
  if (comments.length === 0) return "";
  const body = comments.map(formatEntry).join(" ;; ");
  return `[git diff review] ${body}`;
}

function formatEntry(comment: DiffComment): string {
  const lines =
    comment.startLine !== null && comment.startLine !== comment.lineNumber
      ? `Lines: ${comment.startLine}-${comment.lineNumber}`
      : `Line: ${comment.lineNumber}`;
  return `File: ${comment.filePath} | ${lines} | ${escapeBody(comment.body)}`;
}

/** Backslashes first, so the ones added for `|` and `;` are not doubled. */
function escapeBody(body: string): string {
  return body
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/;/g, "\\;")
    .replace(/\r\n/g, " ")
    .replace(/[\n\r]/g, " ");
}
