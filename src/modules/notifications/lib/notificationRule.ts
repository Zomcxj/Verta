import {
  type AgentPhase,
  flashForPhaseChange,
} from "@/modules/terminal/lib/agentActivity";

/** What one phase change is worth telling the user about, if anything. */
export type NoticeVerdict = "waiting" | "done" | null;

/**
 * What a phase change is worth a system notification for, and nothing else.
 *
 * The sibling of the taskbar flash rule, and built on it so the two can never disagree about
 * what a change means: one place knows that `attention` is a question the agent is waiting on
 * and `finished` is a turn that stopped painting work.
 *
 * Two things are the notification layer's own. A `finished` turn is only worth interrupting
 * someone for when the window is *not* in front - a toast is a real interruption, while a
 * flash on a window the user is already looking at is not something Windows even shows. And a
 * wait is announced once: the store's latch stays set for as long as the agent is blocked, so
 * the moment it started waiting is what says whether this is the same wait as the one already
 * announced, or a new one.
 *
 * The `attention` case needs no front-of-window test of its own: the latch is only ever set
 * for a wait the user was not looking at.
 */
export function noticeForPhaseChange(
  previous: AgentPhase | undefined,
  phase: AgentPhase | undefined,
  seen: {
    /** When this session started waiting unseen, from the activity store's latch. */
    sinceMs: number | undefined;
    /** The wait already announced for this session, if one was. */
    announcedSinceMs: number | undefined;
    /** Whether the session is on screen in a window that is in front. */
    foreground: boolean;
  },
): NoticeVerdict {
  const flash = flashForPhaseChange(previous, phase, seen.sinceMs !== undefined);
  if (flash === "ask") {
    return seen.sinceMs === seen.announcedSinceMs ? null : "waiting";
  }
  if (flash === "done") return seen.foreground ? null : "done";
  return null;
}