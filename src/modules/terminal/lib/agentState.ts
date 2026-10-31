/**
 * What an agent is doing, judged from the last lines of its terminal.
 *
 * None of the agents tell the app when they are waiting for an answer, and
 * installing an integration into each of them would mean shipping a promise we
 * cannot keep for the tools we do not control. The signal is read from the tail
 * of the pane instead, the way the terminal multiplexers do it: a spinner that
 * keeps moving means working, a prompt box with nothing in it means idle, and a
 * question on screen means the agent is blocked on the user.
 *
 * This module is the judgement and nothing else: plain text in, a detection out,
 * no IO, no clock, no terminal. It is deliberately in the front end, because the
 * screen only exists there: the terminal model is a real emulator, so reading a
 * row range back as text is a method call and no IPC at all. The alternative
 * (keeping a ring of raw pty bytes in Rust) loses the screen itself: a permission
 * card that was answered stays in the byte window and keeps reading as blocked,
 * and a full screen repaint appends rather than replacing.
 *
 * Two things the model borrows from herdr's detector, because they are what
 * makes tail matching usable:
 *
 * - a **region** per rule (usually the bottom handful of non-empty lines), so a
 *   phrase printed in the conversation above cannot be mistaken for a prompt;
 * - **negative patterns** per rule, so text the user typed or pasted (which the
 *   agent echoes) cannot masquerade as a signal;
 * - and four **confidence flags** plus `skipStateUpdate`, so a screen that is not
 *   live state at all (a transcript viewer, a pager) can say so instead of
 *   flipping the state.
 */

/**
 * The states worth showing, plus "we do not know".
 *
 * `trailing` is the one that is not a turn: the turn is over and the tool still counts background
 * work of its own (opencode's footer carries the count). It is a state rather than plain `working`
 * because the two ask different things of the reader - one says "the agent is on it", the other says
 * "nothing is being thought about, something is still running" - and it is a state rather than
 * `idle` because a session with a job still going is not at rest.
 */
export type AgentState = "working" | "blocked" | "idle" | "trailing" | "unknown";

/** Which part of the tail a rule looks at. */
export type Region =
  | { readonly kind: "all" }
  /**
   * The bottom `count` lines that have anything on them. This is the default: an
   * agent paints its spinner, its prompt box or its question at the bottom of
   * the screen, while the conversation above is history.
   */
  | { readonly kind: "bottomNonEmptyLines"; readonly count: number };

/** What a rule looks for. */
export type Pattern =
  /** The text appears anywhere in the region, ignoring case. */
  | { readonly kind: "contains"; readonly text: string }
  /**
   * One of these characters appears in the region. Spinners are drawn with a
   * small character set that moves frame by frame, and the set is what
   * identifies them.
   */
  | { readonly kind: "anyChar"; readonly chars: readonly string[] }
  /** Some line of the region starts with the text, ignoring case and indent. */
  | { readonly kind: "lineStartsWith"; readonly prefix: string };

/**
 * One detection rule.
 *
 * The fields mirror the shape of herdr's manifest entries (id, state, priority,
 * region, the `visible*` flags, the patterns and their counter-examples) so rules
 * can be read side by side with theirs. The matcher itself is this module's own
 * small one rather than a regular expression, because every rule the families
 * need is a substring, a prefix or a character set, and a regular expression
 * engine is a dependency and a runtime cost for nothing.
 */
export type AgentRule = {
  /** Stable name, carried into the detection so a test can assert which rule won. */
  readonly id: string;
  readonly state: AgentState;
  /** Highest wins. Live signals sit above idle ones, an on-screen question above both. */
  readonly priority: number;
  readonly region: Region;
  /** All of these must match the region. */
  readonly allOf: readonly Pattern[];
  /** None of these may match the region. */
  readonly noneOf: readonly Pattern[];
  /** The screen is showing the agent working. */
  readonly visibleWorking: boolean;
  /** The screen is showing a question the agent is waiting on. */
  readonly visibleBlocker: boolean;
  /** The screen is showing the agent at its prompt. */
  readonly visibleIdle: boolean;
  /**
   * The screen is showing work that outlived the turn: the agent is not painting anything and the
   * tool still counts jobs of its own. Not `visibleIdle` (something is running) and not
   * `visibleWorking` (nothing is being thought about), which is why it is its own flag.
   */
  readonly visibleTrailing: boolean;
  /** A match is real, but it is not live state (a transcript view, a pager). */
  readonly skipStateUpdate: boolean;
};

/** What the judge decided, plus how sure the matching screen was. */
export type AgentDetection = {
  readonly state: AgentState;
  readonly visibleWorking: boolean;
  readonly visibleBlocker: boolean;
  readonly visibleIdle: boolean;
  readonly visibleTrailing: boolean;
  /** A match was found, but it is not live state; the caller keeps the state it had. */
  readonly skipStateUpdate: boolean;
  /** The rule that decided, for logs and tests. `null` when nothing matched. */
  readonly rule: string | null;
};

/** The whole tail handed in. Rarely what a rule wants; here for completeness. */
export const ALL: Region = { kind: "all" };

/** The bottom `count` non-empty lines. */
export const bottom = (count: number): Region => ({
  kind: "bottomNonEmptyLines",
  count,
});

export const contains = (text: string): Pattern => ({ kind: "contains", text });
export const anyChar = (chars: readonly string[]): Pattern => ({
  kind: "anyChar",
  chars,
});
export const lineStartsWith = (prefix: string): Pattern => ({
  kind: "lineStartsWith",
  prefix,
});

/** What a rule is written from; the flags follow the state unless overridden. */
export type RuleSpec = {
  id: string;
  state: AgentState;
  priority: number;
  region?: Region;
  allOf: readonly Pattern[];
  noneOf?: readonly Pattern[];
  visibleWorking?: boolean;
  visibleBlocker?: boolean;
  visibleIdle?: boolean;
  visibleTrailing?: boolean;
  skipStateUpdate?: boolean;
};

/**
 * A rule, with the confidence flags derived from its state.
 *
 * Deriving them removes the chance of a working rule that forgot to say it is
 * showing work, which would leave the tab icon idle while the agent runs. A rule
 * that genuinely wants a different flag set can still pass one.
 */
export function rule(spec: RuleSpec): AgentRule {
  return {
    id: spec.id,
    state: spec.state,
    priority: spec.priority,
    region: spec.region ?? bottom(12),
    allOf: spec.allOf,
    noneOf: spec.noneOf ?? [],
    visibleWorking: spec.visibleWorking ?? spec.state === "working",
    visibleBlocker: spec.visibleBlocker ?? spec.state === "blocked",
    visibleIdle: spec.visibleIdle ?? spec.state === "idle",
    visibleTrailing: spec.visibleTrailing ?? spec.state === "trailing",
    skipStateUpdate: spec.skipStateUpdate ?? spec.state === "unknown",
  };
}

/**
 * The last `count` lines of `text` that have anything on them, in order.
 *
 * Blank lines are skipped rather than counted: a TUI clears the area under its
 * prompt with newlines, and counting those would push the real signal out of the
 * region.
 */
export function bottomNonEmptyLines(text: string, count: number): string {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

/** True when one pattern matches the text. Shared with the families' identify step. */
export function patternHit(text: string, pattern: Pattern): boolean {
  switch (pattern.kind) {
    case "contains":
      return text.toLowerCase().includes(pattern.text.toLowerCase());
    case "anyChar":
      for (const char of text) if (pattern.chars.includes(char)) return true;
      return false;
    case "lineStartsWith":
      return text.split("\n").some((line) => {
        const trimmed = line.trimStart();
        return (
          trimmed.slice(0, pattern.prefix.length).toLowerCase() ===
          pattern.prefix.toLowerCase()
        );
      });
  }
}

function regionText(tail: string, region: Region): string {
  return region.kind === "all" ? tail : bottomNonEmptyLines(tail, region.count);
}

function ruleMatches(tail: string, candidate: AgentRule): boolean {
  const region = regionText(tail, candidate.region);
  if (!candidate.allOf.every((pattern) => patternHit(region, pattern))) {
    return false;
  }
  return !candidate.noneOf.some((pattern) => patternHit(region, pattern));
}

/** Nothing on screen was recognised. */
export const UNKNOWN_DETECTION: AgentDetection = {
  state: "unknown",
  visibleWorking: false,
  visibleBlocker: false,
  visibleIdle: false,
  visibleTrailing: false,
  skipStateUpdate: false,
  rule: null,
};

/**
 * Decide what the tail shows. The highest priority matching rule wins; a tie goes
 * to the earlier rule in the table, so the answer does not depend on anything but
 * the table itself.
 */
export function evaluate(
  tail: string,
  rules: readonly AgentRule[],
): AgentDetection {
  let best: AgentRule | null = null;
  for (const candidate of rules) {
    if (!ruleMatches(tail, candidate)) continue;
    if (best === null || candidate.priority > best.priority) best = candidate;
  }
  if (best === null) return UNKNOWN_DETECTION;
  return {
    state: best.state,
    visibleWorking: best.visibleWorking,
    visibleBlocker: best.visibleBlocker,
    visibleIdle: best.visibleIdle,
    visibleTrailing: best.visibleTrailing,
    skipStateUpdate: best.skipStateUpdate,
    rule: best.id,
  };
}

/** The state the user should see, which for a skipped screen is "no change". */
export function detectionApplies(detection: AgentDetection): boolean {
  return detection.state !== "unknown" && !detection.skipStateUpdate;
}
