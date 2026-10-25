import { labelFor, type Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal";

/** One session that is waiting on the user and has not been looked at yet. */
export type AgentAttention = {
  /** The pty the session is on, which is what the activity store keys on. */
  readonly ptyId: number;
  /** The leaf it is drawn in, which is where the question is on screen. */
  readonly leafId: number;
  /** The tab to activate to answer it. */
  readonly tabId: number;
  /** The tab's label, so the row does not have to carry a tab around. */
  readonly title: string;
  /** The agent's name, or `null` when the screen never said which one it is. */
  readonly agent: string | null;
  /** When it started waiting with nobody looking. */
  readonly sinceMs: number;
};

type AttentionState = {
  readonly unseen: Record<number, number>;
  readonly leafPty: Record<number, number>;
  readonly agents: Record<number, string>;
};

/**
 * Every session waiting on the user that the user has not seen, newest first.
 *
 * Built from the tabs (which carry the label and the leaves) and the activity
 * store (which carries the latch and the leaf to pty map), so the notification
 * layer needs no data of its own: an item disappears the moment the session is
 * looked at or the agent stops waiting, because the latch it is built from does.
 */
export function pendingAttentions(
  tabs: readonly Tab[],
  state: AttentionState,
): AgentAttention[] {
  const out: AgentAttention[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    for (const leafId of leafIds(tab.paneTree)) {
      const ptyId = state.leafPty[leafId];
      if (ptyId === undefined) continue;
      const sinceMs = state.unseen[ptyId];
      if (sinceMs === undefined) continue;
      out.push({
        ptyId,
        leafId,
        tabId: tab.id,
        title: labelFor(tab),
        agent: state.agents[ptyId] ?? null,
        sinceMs,
      });
    }
  }
  // Newest first: the question that just appeared is the one to answer next.
  return out.sort((a, b) => b.sinceMs - a.sinceMs);
}

/**
 * What the session is asking, read from the bottom of its screen.
 *
 * The same lines the judge reads, so nothing is stored twice and nothing can go
 * stale in the store: the question is on screen because the agent is still
 * waiting on it. It is a preview, so it is capped and collapsed to one line, and
 * a tail with nothing on it (a session whose screen was just cleared) reads as no
 * excerpt rather than as an empty row.
 */
export function questionExcerpt(
  tail: string | null,
  maxChars = 160,
): string {
  if (!tail) return "";
  const lines = tail
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = lines.slice(-3).join(" · ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}