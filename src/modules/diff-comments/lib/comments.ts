import { invoke } from "@tauri-apps/api/core";

/**
 * One review note anchored to a line of a diff.
 *
 * Matches the Rust `DiffComment` after its `#[serde(rename_all = "camelCase")]`, so the
 * field names are the ones the command returns: `startLine` is the range's beginning
 * (`null` for a single line), `lineNumber` its end, `sentAt` set once it has been
 * written to a terminal.
 */
export type DiffComment = {
  id: string;
  sessionId: string;
  filePath: string;
  startLine: number | null;
  lineNumber: number;
  body: string;
  /** Which diff the line was read from: `"unstaged" | "staged" | "branch"`. */
  scope: string;
  sentAt: number | null;
};

/** Every note stored for a session. A session with none reads as an empty list. */
export async function loadComments(sessionId: string): Promise<DiffComment[]> {
  return invoke<DiffComment[]>("diff_comments_list", { sessionId });
}

/** Replace a session's stored notes with `comments`. */
export async function saveComments(
  sessionId: string,
  comments: readonly DiffComment[],
): Promise<void> {
  return invoke<void>("diff_comments_save", { sessionId, comments });
}

/** Notes grouped by the line they end on, so a row can look up its own. */
export function groupByLine(
  comments: readonly DiffComment[],
): Map<number, DiffComment[]> {
  const grouped = new Map<number, DiffComment[]>();
  for (const comment of comments) {
    const bucket = grouped.get(comment.lineNumber);
    if (bucket) {
      bucket.push(comment);
    } else {
      grouped.set(comment.lineNumber, [comment]);
    }
  }
  return grouped;
}
