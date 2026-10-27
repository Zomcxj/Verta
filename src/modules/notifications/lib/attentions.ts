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
 * Where a session is drawn right now, read from the leaf-to-pty mirror rather than from the
 * latch: a notification that is clicked after its wait was already looked at should still go
 * to the session it named, and one whose tab has been closed since has nowhere to go. The
 * leaf comes along because the body of a waiting notification is the screen under it.
 */
export function tabForPty(
  tabs: readonly Tab[],
  leafPty: Record<number, number>,
  ptyId: number,
): { tabId: number; leafId: number } | null {
  for (const tab of tabs) {
    if (tab.kind !== "terminal") continue;
    for (const leafId of leafIds(tab.paneTree)) {
      if (leafPty[leafId] === ptyId) return { tabId: tab.id, leafId };
    }
  }
  return null;
}

/**
 * What the session is asking, read from whichever of its leaves still has a screen.
 *
 * A leaf can outlive its own session - a tab that was left open, a pane whose session was
 * replaced - and it keeps its place in the leaf-to-pty mirror while it does. Reading only the
 * leaf the session is drawn in can therefore read nothing at all, which is how a notification
 * came out with a title and no question under it. So every leaf of that session is tried, in
 * the order given (the leaf it is drawn in first), and the first screen with something on it
 * wins.
 */
export function sessionExcerpt(
  leafIds: readonly number[],
  screen: (leafId: number) => string | null,
  maxChars = 160,
): string {
  for (const leafId of leafIds) {
    const excerpt = questionExcerpt(screen(leafId), maxChars);
    if (excerpt) return excerpt;
  }
  return "";
}

/** A bare shell prompt character on a line of its own. */
const BARE_PROMPT = /^[$#>%]\s*$/;
/** A shell's own prompt line: `user@host MINGW64 ~/work`. */
const PROMPT_LINE = /^[^\s@]+@[^\s@]+\s+\S+/;
/** A row that is nothing but the rule an agent draws across its interface. */
const SEPARATOR = /^[─═━—–\-_·…\s]+$/;

/**
 * What the session is asking, read from the bottom of its screen.
 *
 * The same lines the judge reads, so nothing is stored twice and nothing can go stale in the
 * store: the question is on screen because the agent is still waiting on it. It is a preview,
 * so it is capped and collapsed to one line.
 *
 * Two things are deliberately left out of it. The user's own shell is not the agent's words -
 * a card that has just been cleared leaves a screen with a prompt on it, and a toast quoting
 * the prompt back says nothing about anything. And when there is a question line, that line is
 * the excerpt rather than the rows around it: a card puts its question above its options, so
 * the options, the key hints and the rule are its furniture and do not belong in a
 * notification. The first question in the bottom region is taken rather than the last, because
 * what is printed under a card is what the user typed, which is already theirs.
 */
export function questionExcerpt(
  tail: string | null,
  maxChars = 160,
): string {
  if (!tail) return "";
  const lines = tail
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(
      (line) =>
        line &&
        !BARE_PROMPT.test(line) &&
        !PROMPT_LINE.test(line) &&
        !SEPARATOR.test(line),
    );
  const question = lines.slice(-8).find((line) => /[?？]$/.test(line));
  const text = (question ?? lines.slice(-3).join(" · ")).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}