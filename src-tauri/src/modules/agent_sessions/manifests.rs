//! The rules each agent family is recognised by.
//!
//! A family is identified first (its own chrome, which changes far less often than its state lines) and only
//! then judged, so a spinner in some unrelated TUI cannot be read as an agent at work.
//!
//! Evidence is recorded per family, because a rule that was never compared against a real screen is a guess:
//!
//! - `opencode` and the plain shell: captured PTY output from this machine
//!   (`scripts/dev/ptydump/pty-2.bin`, `pty-4.bin`, `pty-1.bin`).
//! - `claude` and `codex`: herdr's published rules (`src/detect/manifests/*.toml`), which are the rules the
//!   state model was borrowed from. Neither tool is installed here, so none of these lines has been seen on
//!   this machine yet.
//! - `pi`: identified, but no state rules yet, because no live screen has been captured. It stays silent
//!   rather than guessing; a rule with a false positive is worse than no rule.
//!
//! No family has a `skip_state_update` rule yet: those are for screens that are real but not live state (a
//! transcript view, a pager), and none has been captured. The capability is part of the judge and is tested
//! there; a family gets one the day someone photographs the screen it belongs to.
//!
//! When a rule is confirmed or corrected against a live screen, move the sample into the test below and say
//! where it came from.

use super::state::{AgentState, Pattern, Region, Rule};

/// Spinner frames the agent TUIs draw while they work. Two sets, because the plain braille set and the
/// half-circle set are both in use.
pub const SPINNER_FRAMES: &[char] = &[
    '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '⏸', '⏵', '◐', '◓', '◑', '◒',
];

/// Lines a rule looks at by default: enough for a question card and its options, small enough that the
/// conversation above stays out.
const BOTTOM: Region = Region::BottomNonEmptyLines(12);

// ---------------------------------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------------------------------

/// Captured from this machine: the footer hints (`ctrl+p`, `· Tokens`) are part of the TUI's own chrome and
/// stay put while it works, which is what makes them usable for identification.
const OPENCODE_IDENTIFY: &[Pattern] = &[
    Pattern::Contains("ctrl+p"),
    Pattern::Contains("· tokens"),
];

const OPENCODE_RULES: &[Rule] = &[
    // A permission card: opencode asks before it runs something outside the working tree. The wording is
    // from the tool's own prompt style and has NOT been confirmed against a live screen yet (see the note at
    // the top of this file); the counter-examples keep a pasted transcript from looking like one.
    Rule::plain(
        "opencode_permission",
        AgentState::Blocked,
        1000,
        BOTTOM,
        &[
            Pattern::Contains("permission"),
            Pattern::Contains("allow"),
        ],
        &[Pattern::Contains("allow me to explain")],
    )
    .blocker(),
    // A question with options: the selected row is marked with the same caret the other TUIs use.
    Rule::plain(
        "opencode_question",
        AgentState::Blocked,
        990,
        BOTTOM,
        &[Pattern::LineStartsWith("❯ 1.")],
        &[],
    )
    .blocker(),
    // Working: the spinner frames, either on its own line or in front of its status word. Seen in the
    // capture: `⠋`, `⠙`, `⠏` frames alongside `Thinking`.
    Rule::plain(
        "opencode_spinner",
        AgentState::Working,
        800,
        BOTTOM,
        &[Pattern::AnyChar(SPINNER_FRAMES)],
        &[Pattern::Contains("esc to interrupt")],
    )
    .working(),
    // Working, second signal: the status word the TUI paints while a turn runs.
    Rule::plain(
        "opencode_status_word",
        AgentState::Working,
        780,
        BOTTOM,
        &[Pattern::Contains("thinking")],
        &[],
    )
    .working(),
    // Idle: the footer is there and nothing is moving on it.
    Rule::plain(
        "opencode_idle",
        AgentState::Idle,
        500,
        BOTTOM,
        OPENCODE_IDENTIFY,
        &[
            Pattern::AnyChar(SPINNER_FRAMES),
            Pattern::Contains("thinking"),
        ],
    )
    .idle(),
];

// ---------------------------------------------------------------------------------------------------
// claude code
// ---------------------------------------------------------------------------------------------------

/// From herdr's rules; not yet seen here (the tool is not installed on this machine).
const CLAUDE_IDENTIFY: &[Pattern] = &[
    Pattern::Contains("? for shortcuts"),
    Pattern::Contains("esc to interrupt"),
];

const CLAUDE_RULES: &[Rule] = &[
    Rule::plain(
        "claude_permission",
        AgentState::Blocked,
        1100,
        BOTTOM,
        &[Pattern::Contains("do you want to proceed?")],
        &[],
    )
    .blocker(),
    Rule::plain(
        "claude_choice",
        AgentState::Blocked,
        1090,
        BOTTOM,
        &[Pattern::LineStartsWith("❯ 1.")],
        &[],
    )
    .blocker(),
    Rule::plain(
        "claude_esc_to_cancel",
        AgentState::Blocked,
        1080,
        BOTTOM,
        &[Pattern::Contains("esc to cancel")],
        &[],
    )
    .blocker(),
    // A turn that is running says so, and the spinner frames keep moving.
    Rule::plain(
        "claude_interrupt",
        AgentState::Working,
        970,
        BOTTOM,
        &[Pattern::Contains("esc to interrupt")],
        &[],
    )
    .working(),
    Rule::plain(
        "claude_spinner",
        AgentState::Working,
        960,
        BOTTOM,
        &[Pattern::AnyChar(SPINNER_FRAMES)],
        &[Pattern::Contains("do you want to proceed?")],
    )
    .working(),
    // Background work it reports while it waits.
    Rule::plain(
        "claude_background_tasks",
        AgentState::Working,
        950,
        BOTTOM,
        &[Pattern::Contains("mcp tasks still running")],
        &[],
    )
    .working(),
    Rule::plain(
        "claude_idle",
        AgentState::Idle,
        500,
        BOTTOM,
        &[Pattern::LineStartsWith(">")],
        &[
            Pattern::AnyChar(SPINNER_FRAMES),
            Pattern::Contains("esc to cancel"),
        ],
    )
    .idle(),
];

// ---------------------------------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------------------------------

/// From herdr's rules; not yet seen here. The tool's name is deliberately not an identify pattern: a shell
/// echoing `codex --help` would otherwise be read as the agent's own screen.
const CODEX_IDENTIFY: &[Pattern] = &[
    Pattern::Contains("esc to interrupt"),
    Pattern::Contains("approve?"),
    Pattern::Contains("[y/n]"),
];

const CODEX_RULES: &[Rule] = &[
    Rule::plain(
        "codex_approval",
        AgentState::Blocked,
        1000,
        BOTTOM,
        &[Pattern::Contains("approve?")],
        &[],
    )
    .blocker(),
    Rule::plain(
        "codex_yes_no",
        AgentState::Blocked,
        990,
        BOTTOM,
        &[Pattern::Contains("[y/n]")],
        &[],
    )
    .blocker(),
    Rule::plain(
        "codex_spinner",
        AgentState::Working,
        800,
        BOTTOM,
        &[Pattern::AnyChar(SPINNER_FRAMES)],
        &[],
    )
    .working(),
    Rule::plain(
        "codex_idle",
        AgentState::Idle,
        500,
        BOTTOM,
        &[Pattern::LineStartsWith("$")],
        &[Pattern::AnyChar(SPINNER_FRAMES)],
    )
    .idle(),
];

// ---------------------------------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------------------------------

/// The name is a guess to be checked; nothing else is known about its screen yet.
const PI_IDENTIFY: &[Pattern] = &[Pattern::Contains("pi agent")];

/// Empty on purpose: no live screen has been captured, so there is nothing honest to match against. The
/// family is still named here, so the wiring and the tests already have a place to put it.
const PI_RULES: &[Rule] = &[];

/// The families, keyed by the tool name the rest of the app uses.
pub const FAMILIES: &[Family] = &[
    Family {
        tool: "opencode",
        identify: OPENCODE_IDENTIFY,
        rules: OPENCODE_RULES,
    },
    Family {
        tool: "claude",
        identify: CLAUDE_IDENTIFY,
        rules: CLAUDE_RULES,
    },
    Family {
        tool: "codex",
        identify: CODEX_IDENTIFY,
        rules: CODEX_RULES,
    },
    Family {
        tool: "pi",
        identify: PI_IDENTIFY,
        rules: PI_RULES,
    },
];

#[derive(Debug)]
pub struct Family {
    pub tool: &'static str,
    /// Chrome that says this is that agent, checked before any state rule.
    pub identify: &'static [Pattern],
    pub rules: &'static [Rule],
}

impl Family {
    /// True when this screen is that agent's at all.
    pub fn matches(&self, tail: &str) -> bool {
        let region = super::state::bottom_non_empty_lines(tail, 16);
        self.identify
            .iter()
            .any(|pattern| super::state::pattern_hit(&region, *pattern))
    }
}

/// Which agent this screen belongs to, if any.
///
/// Two families can match the same screen in principle; the first one in `FAMILIES` wins, and the order
/// there is from the most specific chrome to the least.
pub fn identify(tail: &str) -> Option<&'static Family> {
    FAMILIES.iter().find(|family| family.matches(tail))
}

/// The rules for a tool name, for callers that already know which agent is running.
pub fn family_for(tool: &str) -> Option<&'static Family> {
    FAMILIES.iter().find(|family| family.tool == tool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::agent_sessions::state::{evaluate, AgentState};

    /// Real capture from this machine: the shell's own prompt (pty-1.bin), which must never look like an
    /// agent.
    const SHELL_TAIL: &str = "special@LAPTOP-7P186K9V MINGW64 /f/VibeCoding_workspace/Verta (main)\n$ ";

    /// Real capture: opencode's footer and spinner (pty-2.bin / pty-4.bin).
    const OPENCODE_WORKING: &str =
        "Writing the patch\n⠹ Thinking\nctrl+p commands   · Tokens 12.4k";
    const OPENCODE_IDLE: &str = "Where to next?\nctrl+p commands   · Tokens 12.4k";

    /// Written from herdr's rules, not yet seen here.
    const CLAUDE_BLOCKED: &str = "  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n? for shortcuts";
    const CLAUDE_WORKING: &str = "⠼ Running the tests\n  esc to interrupt\n? for shortcuts";
    const CLAUDE_IDLE: &str = "> \n? for shortcuts";

    const CODEX_BLOCKED: &str = "Approve? [y/n]\ncodex";
    const CODEX_IDLE: &str = "$ \ncodex";

    fn judge(tool: &str, tail: &str) -> AgentState {
        let family = family_for(tool).expect("family");
        evaluate(tail, family.rules).state
    }

    #[test]
    fn a_shell_prompt_is_not_an_agent() {
        assert!(identify(SHELL_TAIL).is_none());
        assert!(identify("$ ls\n$ git status\n") .is_none());
    }

    #[test]
    fn opencode_is_identified_by_its_own_footer() {
        assert_eq!(identify(OPENCODE_IDLE).map(|f| f.tool), Some("opencode"));
        assert_eq!(identify(OPENCODE_WORKING).map(|f| f.tool), Some("opencode"));
    }

    #[test]
    fn opencode_working_and_idle_are_told_apart() {
        assert_eq!(judge("opencode", OPENCODE_WORKING), AgentState::Working);
        assert_eq!(judge("opencode", OPENCODE_IDLE), AgentState::Idle);
    }

    #[test]
    fn opencode_moving_frames_keep_the_state_out_of_idle() {
        for frame in SPINNER_FRAMES.iter().take(10) {
            let tail = format!("{frame} Thinking\nctrl+p commands   · Tokens 1k");
            assert_eq!(
                judge("opencode", &tail),
                AgentState::Working,
                "frame {frame} should read as working"
            );
        }
    }

    #[test]
    fn a_permission_card_reads_as_blocked() {
        let tail = "△ Permission required\n  Allow once\n  Allow always\n  Deny\nctrl+p commands";
        assert_eq!(judge("opencode", tail), AgentState::Blocked);
    }

    #[test]
    fn a_question_card_reads_as_blocked() {
        let tail = "? Which model should I use\n❯ 1. Fast\n  2. Smart\nctrl+p commands";
        assert_eq!(judge("opencode", tail), AgentState::Blocked);
    }

    #[test]
    fn a_pasted_transcript_does_not_look_like_a_permission_card() {
        // The user pasted a log that talks about permissions and about the word allow; it must not be read as
        // a card, which is what the counter-example is for.
        let tail = "> allow me to explain what happened\n  permission was granted earlier\nctrl+p commands";
        assert_ne!(judge("opencode", tail), AgentState::Blocked);
    }

    #[test]
    fn a_shell_echoing_an_agent_name_is_not_that_agent() {
        let shell = "$ codex --help
Usage: codex [options]
$ ";
        assert!(identify(shell).is_none(), "got {:?}", identify(shell));
    }

    #[test]
    fn the_identify_step_gates_the_rules() {
        // A braille spinner inside plain shell output (a progress bar from some command) is not an agent at
        // work: identification is what keeps the rules from firing.
        let shell_progress = "⠹ downloading\n⠸ unpacking\n$ ";
        assert!(identify(shell_progress).is_none());
    }

    #[test]
    fn claude_blocked_working_and_idle() {
        assert_eq!(judge("claude", CLAUDE_BLOCKED), AgentState::Blocked);
        assert_eq!(judge("claude", CLAUDE_WORKING), AgentState::Working);
        assert_eq!(judge("claude", CLAUDE_IDLE), AgentState::Idle);
    }

    #[test]
    fn a_claude_question_does_not_read_as_idle() {
        // The prompt marker is on screen as part of the card; the card has to win.
        let tail = "  Do you want to proceed?\n  ❯ 1. Yes\n> \n? for shortcuts";
        assert_eq!(judge("claude", tail), AgentState::Blocked);
    }

    #[test]
    fn codex_blocked_and_idle() {
        assert_eq!(judge("codex", CODEX_BLOCKED), AgentState::Blocked);
        assert_eq!(judge("codex", CODEX_IDLE), AgentState::Idle);
    }

    #[test]
    fn pi_stays_silent_until_its_screen_has_been_captured() {
        // Not a claim about pi's output: a claim that nothing is guessed. The family is identified, and with
        // no rules it can only answer "unknown".
        let tail = "pi agent\nWhat should I do?\n";
        assert_eq!(identify(tail).map(|f| f.tool), Some("pi"));
        assert_eq!(judge("pi", tail), AgentState::Unknown);
    }

    #[test]
    fn every_family_name_matches_the_tool_names_the_app_uses() {
        // `agent_sessions_list` is called with these two today; the other two are in the table for the agents
        // the plans name, and a typo here would silently disable a family.
        for tool in ["opencode", "pi", "claude", "codex"] {
            assert!(family_for(tool).is_some(), "{tool} is missing");
        }
        assert!(family_for("nonesuch").is_none());
    }

    #[test]
    fn the_rule_ids_are_unique_across_families() {
        let mut seen = Vec::new();
        for family in FAMILIES {
            for rule in family.rules {
                assert!(
                    !seen.contains(&rule.id),
                    "duplicate rule id {}",
                    rule.id
                );
                seen.push(rule.id);
            }
        }
    }

    #[test]
    fn every_state_rule_carries_the_flag_its_state_implies() {
        for family in FAMILIES {
            for rule in family.rules {
                match rule.state {
                    AgentState::Working => assert!(
                        rule.visible_working,
                        "{} should say it is showing work",
                        rule.id
                    ),
                    AgentState::Blocked => assert!(
                        rule.visible_blocker,
                        "{} should say it is showing a blocker",
                        rule.id
                    ),
                    AgentState::Idle => assert!(
                        rule.visible_idle,
                        "{} should say it is showing the prompt",
                        rule.id
                    ),
                    AgentState::Unknown => assert!(
                        rule.skip_state_update,
                        "{} has no state of its own, so it has to be a skip",
                        rule.id
                    ),
                }
            }
        }
    }
}