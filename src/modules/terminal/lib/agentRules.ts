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
 * - `pi`: captured on this machine (2026-10-26) with
 *   `scripts/dev/probes/agent-lab.mjs`, in both configurations (as the user runs it,
 *   and with `--no-extensions`, so the chrome its own interface draws could be told
 *   apart from the chrome their extensions draw). The family below says what each
 *   state looks like and what is deliberately not matched.
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

/** The footer hints that are on screen whenever the TUI is at rest. */
const OPENCODE_FOOTER: readonly Pattern[] = [contains("ctrl+p"), contains("· tokens")];

/**
 * Anything on screen that says this is opencode.
 *
 * The family test takes **any** of these, so this is also where a screen that hides the usual
 * footer has to be named.
 */
const OPENCODE_IDENTIFY: readonly Pattern[] = [
  ...OPENCODE_FOOTER,
  // The question panel replaces the footer, so neither hint above is on screen while it is open.
  // Measured on this machine with `scripts/dev/probes/state-dot-watch.mjs --once`: the whole footer
  // read `↑↓ select  enter submit  esc dismiss`, and with no other marker matching, a session
  // sitting on a question was reported as having no agent at all.
  //
  // Deliberately not in `OPENCODE_FOOTER`: the idle rule requires every footer hint, and a question
  // panel is the opposite of idle.
  contains("enter submit"),
  // And the same panel with more than one question, whose footer navigates between them and says
  // `enter choose  tab next` instead. Without this, a session sitting on a two-question panel was
  // reported as having no agent at all, which is how the tab stayed green with a panel open on it.
  contains("enter choose"),
];

/**
 * What a screen showing background work must *not* have on it.
 *
 * The interrupt hint in any spelling (`rupt` covers `esc interrupt` and the elided `esc...rupt`),
 * the status word a running turn paints, and a spinner glyph. Any of them means the screen is being
 * worked on right now, which is work in flight rather than work left behind.
 */
const OPENCODE_NOT_TRAILING: readonly Pattern[] = [
  contains("rupt"),
  contains("thinking"),
  anyChar(SPINNER_FRAMES),
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
  // A question with options, older shape: the selected row is marked with the same caret the
  // other TUIs use.
  rule({
    id: "opencode_question",
    state: "blocked",
    priority: 990,
    region: BOTTOM,
    allOf: [lineStartsWith("❯ 1.")],
  }),
  // A question panel, the shape this machine's opencode actually draws. Measured with
  // `state-dot-watch.mjs --once`: the options carry **no** caret - `1. 火锅`, not `❯ 1. 火锅` - so the
  // rule above never matched, and a session waiting on an answer was drawn as idle (green) instead
  // of as the blue that means "it is asking you something".
  //
  // Identified by the panel's own footer rather than by its content. The footer reads
  // `↑↓ select  enter submit  esc dismiss`, which is chrome: an option line pasted into a
  // conversation looks exactly like a real option, and this does not.
  rule({
    id: "opencode_questions_panel",
    state: "blocked",
    priority: 995,
    region: BOTTOM,
    allOf: [contains("enter submit"), contains("esc dismiss")],
  }),
  // The same panel asked with more than one question. It then navigates between them, and the footer
  // becomes `↑↓ select  enter choose  tab next  esc dismiss` - both spellings are in the installed
  // opencode's own strings, and this one was on screen while the tab stayed green: the rule above
  // matches `enter submit`, which this footer does not contain. Its options carry the same shape, so
  // it is the same panel and the same answer: the agent is waiting on the user.
  rule({
    id: "opencode_questions_panel_multi",
    state: "blocked",
    priority: 995,
    region: BOTTOM,
    allOf: [contains("enter choose"), contains("esc dismiss")],
  }),
  // Working, and saying so for the whole time: the footer carries the interrupt hint and a
  // progress bar for as long as a turn runs, unlike the spinner glyph, which the TUI paints on
  // some frames and not others. Measured on this machine (2026-10-27, with
  // `scripts/dev/probes/state-dot-watch.mjs`, which records the rule that won and the rows it
  // read): the judge called a session idle while that session's own footer said
  // `⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt`, and every such false ending also put a "a turn finished"
  // notification into Windows' own store - six of them in three minutes.
  //
  // The footer is one line, so this rule reads only that line: the phrase itself is short enough
  // to turn up in a conversation, and the conversation is exactly what sits above the footer.
  rule({
    id: "opencode_interruptible",
    state: "working",
    priority: 820,
    region: bottom(1),
    allOf: [contains("esc interrupt")],
  }),
  // Background work outlives the turn: opencode keeps counting its own shells and the subagents a
  // turn started on that same footer line, and a job still running is not a session at rest.
  // Measured on this machine (2026-10-31, `idle-screen.log`, 121 screens sampled while nothing was
  // driving the session):
  //
  //   F:\…\Verta:ma…  命中率 99.8% ↑0.7% · Tokens 2232.6M · 余额 -   ↓ 1 shell · ◎ goal paused · 319.7K (64%)  ctrl+p commands
  //   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt 命中率 99.8% · Tokens 78.3M · 余额 - · ↓ 3 subagents · ◎ goal · 317.6K (64%) ctrl+p commands
  //   ⬝⬝⬝⬝⬝⬝■■esc...rupt 命中率 99.8% · Tokens 78.3M · 余 ↓ 3 subagents · 1 shell · ◎ goal · 317.6K (64%) ctrl+p commands
  //
  // Four things those three lines settle, each of which a rule written from the first one alone
  // would have got wrong:
  //
  // - the count is singular for one shell and plural after that, and a shell that follows a subagent
  //   count is spelled `1 shell` with no arrow of its own, so the match is on the word rather than on
  //   the `↓` beside it.
  // - subagents are counted in the same place and are the same kind of thing: work the turn left
  //   running. They are matched as `subagent` rather than as `agent`, because `agent` is also the
  //   name opencode prints for its model router on the line above (`gpt-6.1-sol openai_agentrouter`).
  // - the footer **wraps**, so the count is often on the line *above* the last one (the last line is
  //   the remainder, `·`). Read from `bottom(1)` the idle screen matched nothing and fell through to
  //   the spinner rule, which read the same situation as `working` - the same session, the same one
  //   shell, two different answers depending on how wide the pane happened to be. This reads the last
  //   two non-empty lines.
  // - the interrupt hint is what separates "a turn is in flight" from "the turn is over": while a
  //   turn runs the footer carries `esc interrupt` *and* the counts. So the hint is excluded rather
  //   than merely outranked: `opencode_interruptible` sits above these rules anyway, but it matches
  //   the literal words, and the same hint is drawn elided (`esc...rupt`) on some frames, which would
  //   let these read a working screen as background work.
  //
  // The spinner is excluded for the same reason: a glyph anywhere in the region means something is
  // being painted right now, and that is work rather than background work.
  rule({
    id: "opencode_trailing_shell",
    state: "trailing",
    priority: 815,
    region: bottom(2),
    allOf: [contains("shell"), contains("ctrl+p")],
    noneOf: OPENCODE_NOT_TRAILING,
  }),
  rule({
    id: "opencode_trailing_subagent",
    state: "trailing",
    priority: 815,
    region: bottom(2),
    allOf: [contains("subagent"), contains("ctrl+p")],
    noneOf: OPENCODE_NOT_TRAILING,
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
  // Idle: the footer is there and nothing on it is moving - no spinner, no status word, and no
  // interrupt hint anywhere in the region (the hint sits on the footer's own line, which the
  // rule above reads alone, but a screen that says the turn can be interrupted is not idle
  // wherever it says it).
  rule({
    id: "opencode_idle",
    state: "idle",
    priority: 500,
    region: BOTTOM,
    // The usual footer, not the family's whole identify list: that one also names the question
    // panel, and a panel waiting on an answer is the one screen that is certainly not idle.
    allOf: OPENCODE_FOOTER,
    noneOf: [
      anyChar(SPINNER_FRAMES),
      contains("thinking"),
      contains("esc interrupt"),
    ],
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
 * pi's own screen, captured on this machine (2026-10-26) with and without the
 * user's extensions (`scripts/dev/probes/agent-lab.mjs`, in a directory of its own):
 *
 * - idle: two full-width rules with the input between them, a footer line under them.
 *   The extensions give the footer `... | LSP Inactive`; with `--no-extensions` it reads
 *   `↑6.9k ↓227 R8.2k CH78.8% 2.0%/262k (auto)`;
 * - working, `--no-extensions`: `── ⠙ Working ─────...` - a braille frame and the label
 *   inside the rule, above the input;
 * - working, as the user runs it: the label is a phrase from their whimsical extension
 *   (`── ◝ Musing... ──`, and at other times the phrase sits on its own line above the
 *   footer, with no rule around it), so the phrase is not what a rule can match;
 * - waiting on the user: the `ask_user` card, captured as a title, the question, `→`
 *   option rows, `Other (type your answer)`, and the hints
 *   `↑↓ navigate  enter select  escape/ctrl+c cancel`.
 *
 * The two configurations share no footer string - not the token counter, not the model
 * name, and `(auto)` against `AC` - so the family is identified by the pair of rules pi's
 * own interface draws: twenty or more box-drawing dashes (`─`, U+2500) in the bottom of
 * the screen. Command output draws its separators with ASCII `-` instead, so a shell that
 * prints a line of them is not read as pi.
 *
 * Nothing was observed asking for approval of a command: a destructive `rm -f` in the
 * working directory ran without a prompt, so no approval rule is written for one.
 */
const PI_IDENTIFY: readonly Pattern[] = [contains("─".repeat(20))];

/** The frames pi's own spinner rotates through (seen in the `--no-extensions` capture). */
const PI_SPINNER_FRAMES: readonly string[] = [
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
];

/** The frames the user's whimsical extension rotates through instead (seen beside its phrases). */
const PI_WHIMSY_FRAMES: readonly string[] = [
  "◜",
  "◝",
  "◞",
  "◟",
  "◠",
  "◡",
];

const PI_WORKING_FRAMES: readonly string[] = [
  ...PI_SPINNER_FRAMES,
  ...PI_WHIMSY_FRAMES,
];

const PI_RULES: readonly AgentRule[] = [
  // The card pi shows when it needs a decision from the user: options with one selected,
  // and the key hints under them. The hints are the wider of the two signals, because the
  // question text itself is whatever the model wrote.
  rule({
    id: "pi_question_hints",
    state: "blocked",
    priority: 1000,
    region: BOTTOM,
    allOf: [contains("enter select"), contains("escape/ctrl+c cancel")],
  }),
  // The same card read from its other end: the row the user types an answer into.
  rule({
    id: "pi_question_card",
    state: "blocked",
    priority: 990,
    region: BOTTOM,
    allOf: [contains("other (type your answer)")],
  }),
  // Starting up: the welcome screen, which leaves on any key or on its own countdown.
  // It is busy rather than waiting on the user, so it is work.
  rule({
    id: "pi_startup",
    state: "working",
    priority: 950,
    region: BOTTOM,
    allOf: [contains("press any key to continue")],
  }),
  // Starting up, and saying so: pi paints this line while it loads its resources, which is
  // the screen it sat on for minutes in the capture. It must not read as an agent idle at
  // its prompt.
  rule({
    id: "pi_startup_in_progress",
    state: "working",
    priority: 945,
    region: BOTTOM,
    allOf: [contains("startup is still in progress")],
  }),
  // Starting up, the half before that: pi has painted its banner line and nothing else yet.
  // Measured live: an instance sat here for minutes on this machine, and reading that as an
  // agent idle at its prompt is wrong in the direction that matters (nothing tells the user
  // to wait). The banner is a proxy - its own line for the key hints - because pi paints
  // nothing else that says "starting" until the line above appears. A fresh session with an
  // empty conversation can still have the banner this close to its input, and reads as work
  // until it paints something over it.
  //
  // That was the first version of this rule and it was wrong for a session that is simply
  // *open*: the banner stays in the scrollback for the life of the session, so the proxy never
  // stops matching. Measured on a session opened and then left alone, the banner was still the
  // nearest thing to the bottom of the screen while pi sat at its prompt, and this rule sat
  // above the idle one (940 against 500), so the session read as work for as long as the tab
  // was open. What tells the two apart is pi's status line, which is painted only once its own
  // interface is up: the token counters with their arrows. With that line on screen the banner
  // is history, and nothing below it has to be read as work.
  rule({
    id: "pi_startup_banner",
    state: "working",
    priority: 940,
    region: BOTTOM,
    allOf: [contains("ctrl+o more")],
    noneOf: [contains("↑"), contains("↓")],
  }),
  // Working: the frame inside the rule pi draws above its input.
  rule({
    id: "pi_spinner_in_rule",
    state: "working",
    priority: 900,
    region: BOTTOM,
    allOf: [lineStartsWith("──"), anyChar(PI_WORKING_FRAMES)],
  }),
  // Working, second signal: the same frame with the phrase on its own line instead,
  // which is the other shape the extension draws it in.
  rule({
    id: "pi_spinner",
    state: "working",
    priority: 880,
    region: BOTTOM,
    allOf: [anyChar(PI_WORKING_FRAMES)],
  }),
  // Idle: pi's own screen is there and nothing on it is moving.
  rule({
    id: "pi_idle",
    state: "idle",
    priority: 500,
    region: BOTTOM,
    allOf: PI_IDENTIFY,
    noneOf: [anyChar(PI_WORKING_FRAMES)],
  }),
];

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
