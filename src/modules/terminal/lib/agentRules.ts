/**
 * The rules each agent family is recognised by.
 *
 * A family is identified first (its own chrome, which changes far less often than
 * its state lines) and only then judged, so a spinner in an unrelated TUI cannot
 * be read as an agent at work.
 *
 * Evidence is recorded per family, because a rule that was never compared against
 * a real screen is a guess:
 *
 * - `opencode`: captured pty output from this machine
 *   (`scripts/dev/ptydump/pty-2.bin` and `pty-4.bin`, which show the spinner
 *   frames, the `Thinking` status word and the `ctrl+p` / `· Tokens` footer).
 *   Its permission card was NOT in those captures; that rule is written from the
 *   tool's own prompt style and is marked below as still to be confirmed.
 * - `claude` and `codex`: herdr's published rules (`src/detect/manifests/*.toml`),
 *   which are the rules this whole model was borrowed from. Neither tool is
 *   installed on this machine, so none of these lines has been seen here.
 * - `pi`: named, with no identify pattern and no rules, because no live screen has
 *   been captured. It stays silent rather than guessing; a rule with a false
 *   positive is worse than no rule.
 *
 * When a rule is confirmed or corrected against a live screen, move the sample
 * into the test beside this file and say where it came from.
 */

import {
  type AgentRule,
  anyChar,
  bottom,
  bottomNonEmptyLines,
  contains,
  lineStartsWith,
  type Pattern,
  patternHit,
  rule,
} from "@/modules/terminal/lib/agentState";

/**
 * Spinner frames the agent TUIs draw while they work: the braille set, the
 * half-circle set, and the pause/play pair some of them swap in.
 */
export const SPINNER_FRAMES: readonly string[] = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
  "⏸",
  "⏵",
  "◐",
  "◓",
  "◑",
  "◒",
];

/**
 * Lines a rule looks at by default: enough for a question card and its options,
 * small enough that the conversation above stays out.
 */
const BOTTOM = bottom(12);

/** The chrome a family is identified by is read from a slightly wider region. */
const IDENTIFY_LINES = 16;

export type AgentFamily = {
  /** The name the rest of the app uses for the agent (`tab.agent`, session stores). */
  readonly tool: string;
  /** Chrome that says this is that agent, checked before any state rule. */
  readonly identify: readonly Pattern[];
  readonly rules: readonly AgentRule[];
};

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

/** Seen in the captures: the footer hints stay put while the TUI works. */
const OPENCODE_IDENTIFY: readonly Pattern[] = [
  contains("ctrl+p"),
  contains("· tokens"),
];

const OPENCODE_RULES: readonly AgentRule[] = [
  // A permission card: opencode asks before it runs something outside the working
  // tree. The wording is written from the tool's prompt style and has NOT been
  // confirmed against a live screen yet; the counter-example keeps a pasted line
  // from looking like one.
  rule({
    id: "opencode_permission",
    state: "blocked",
    priority: 1000,
    region: BOTTOM,
    allOf: [contains("permission"), contains("allow")],
    noneOf: [contains("allow me to explain")],
  }),
  // A question with options: the selected row is marked with the same caret the
  // other TUIs use.
  rule({
    id: "opencode_question",
    state: "blocked",
    priority: 990,
    region: BOTTOM,
    allOf: [lineStartsWith("❯ 1.")],
  }),
  // Working: the spinner frames. Seen in the captures (`⠋`, `⠙`, `⠏`).
  rule({
    id: "opencode_spinner",
    state: "working",
    priority: 800,
    region: BOTTOM,
    allOf: [anyChar(SPINNER_FRAMES)],
  }),
  // Working, second signal: the status word the TUI paints while a turn runs.
  rule({
    id: "opencode_status_word",
    state: "working",
    priority: 780,
    region: BOTTOM,
    allOf: [contains("thinking")],
  }),
  // Idle: the footer is there and nothing on it is moving.
  rule({
    id: "opencode_idle",
    state: "idle",
    priority: 500,
    region: BOTTOM,
    allOf: OPENCODE_IDENTIFY,
    noneOf: [anyChar(SPINNER_FRAMES), contains("thinking")],
  }),
];

// ---------------------------------------------------------------------------
// claude code
// ---------------------------------------------------------------------------

/** From herdr's rules; not yet seen here (the tool is not installed). */
const CLAUDE_IDENTIFY: readonly Pattern[] = [
  contains("? for shortcuts"),
  contains("esc to interrupt"),
];

const CLAUDE_RULES: readonly AgentRule[] = [
  rule({
    id: "claude_permission",
    state: "blocked",
    priority: 1100,
    region: BOTTOM,
    allOf: [contains("do you want to proceed?")],
  }),
  rule({
    id: "claude_choice",
    state: "blocked",
    priority: 1090,
    region: BOTTOM,
    allOf: [lineStartsWith("❯ 1.")],
  }),
  rule({
    id: "claude_esc_to_cancel",
    state: "blocked",
    priority: 1080,
    region: BOTTOM,
    allOf: [contains("esc to cancel")],
  }),
  // A turn that is running says so, and the spinner frames keep moving.
  rule({
    id: "claude_interrupt",
    state: "working",
    priority: 970,
    region: BOTTOM,
    allOf: [contains("esc to interrupt")],
  }),
  rule({
    id: "claude_spinner",
    state: "working",
    priority: 960,
    region: BOTTOM,
    allOf: [anyChar(SPINNER_FRAMES)],
    noneOf: [contains("do you want to proceed?")],
  }),
  // Background work it reports while it waits.
  rule({
    id: "claude_background_tasks",
    state: "working",
    priority: 950,
    region: BOTTOM,
    allOf: [contains("mcp tasks still running")],
  }),
  rule({
    id: "claude_idle",
    state: "idle",
    priority: 500,
    region: BOTTOM,
    allOf: [lineStartsWith(">")],
    noneOf: [anyChar(SPINNER_FRAMES), contains("esc to cancel")],
  }),
];

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

/**
 * From herdr's rules; not yet seen here. The tool's name is deliberately not an
 * identify pattern: a shell echoing `codex --help` would otherwise be read as the
 * agent's own screen.
 */
const CODEX_IDENTIFY: readonly Pattern[] = [
  contains("esc to interrupt"),
  contains("approve?"),
  contains("[y/n]"),
];

const CODEX_RULES: readonly AgentRule[] = [
  rule({
    id: "codex_approval",
    state: "blocked",
    priority: 1000,
    region: BOTTOM,
    allOf: [contains("approve?")],
  }),
  rule({
    id: "codex_yes_no",
    state: "blocked",
    priority: 990,
    region: BOTTOM,
    allOf: [contains("[y/n]")],
  }),
  rule({
    id: "codex_spinner",
    state: "working",
    priority: 800,
    region: BOTTOM,
    allOf: [anyChar(SPINNER_FRAMES)],
  }),
  rule({
    id: "codex_idle",
    state: "idle",
    priority: 500,
    region: BOTTOM,
    allOf: [lineStartsWith("$")],
    noneOf: [anyChar(SPINNER_FRAMES)],
  }),
];

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

/**
 * Empty on purpose. The tool is installed here, but no live screen has been
 * captured yet, so there is nothing honest to match against. The family is named
 * so the wiring and the tests already have a place to put its chrome.
 */
const PI_IDENTIFY: readonly Pattern[] = [];

const PI_RULES: readonly AgentRule[] = [];

/**
 * The families, in identify order: the most specific chrome first, so two
 * families that could both match the same screen resolve to the narrower one.
 */
export const FAMILIES: readonly AgentFamily[] = [
  { tool: "opencode", identify: OPENCODE_IDENTIFY, rules: OPENCODE_RULES },
  { tool: "claude", identify: CLAUDE_IDENTIFY, rules: CLAUDE_RULES },
  { tool: "codex", identify: CODEX_IDENTIFY, rules: CODEX_RULES },
  { tool: "pi", identify: PI_IDENTIFY, rules: PI_RULES },
];

/** True when this screen is that family's at all. */
function familyMatches(family: AgentFamily, tail: string): boolean {
  const region = bottomNonEmptyLines(tail, IDENTIFY_LINES);
  return family.identify.some((pattern) => patternHit(region, pattern));
}

/** Which agent this screen belongs to, if any. */
export function identifyAgent(tail: string): AgentFamily | null {
  return FAMILIES.find((family) => familyMatches(family, tail)) ?? null;
}

/** The family for a tool name, for callers that already know which agent runs. */
export function familyFor(tool: string): AgentFamily | null {
  return FAMILIES.find((family) => family.tool === tool) ?? null;
}
