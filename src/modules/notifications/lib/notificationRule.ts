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
 * Three things are the notification layer's own. A `finished` turn is only worth interrupting
 * someone for when the window is *not* in front - a toast is a real interruption, while a
 * flash on a window the user is already looking at is not something Windows even shows. A wait
 * is announced once: the store's latch stays set for as long as the agent is blocked, so the
 * moment it started waiting is what says whether this is the same wait as the one already
 * announced, or a new one. And a wait is judged by its latch rather than by its phase changing:
 * the store writes the phase first and the latch a moment later in a second write (measured),
 * so at the moment the latch appears the phase has already moved and a rule that waited for the
 * phase to change would miss every wait there is. Being latched is also already the answer to
 * "was the user looking", so nothing else is needed to tell the two apart.
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
  if (phase === "attention") {
    if (seen.sinceMs === undefined) return null;
    return seen.sinceMs === seen.announcedSinceMs ? null : "waiting";
  }
  if (flashForPhaseChange(previous, phase, false) === "done") {
    return seen.foreground ? null : "done";
  }
  return null;
}