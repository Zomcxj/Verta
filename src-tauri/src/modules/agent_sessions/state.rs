//! What an agent is doing, read from the last lines of its terminal.
//!
//! None of the agents tell the app when they are waiting for an answer, and installing an integration into
//! each of them would mean shipping a promise we cannot keep for the tools we do not control. The signal is
//! therefore read from the tail of the pane, the way the terminal multiplexers do it: a spinner that keeps
//! moving means working, an empty prompt box means idle, and a question on screen means the agent is
//! blocked on the user.
//!
//! This module is the whole judgement and nothing else: plain text in, a detection out, no IO, no clock, no
//! terminal. The PTY tap and the event that carries the answer live next to the session code, so the rules
//! can be tested against captured output (see the tests at the bottom of `manifests.rs`).
//!
//! Two things the model borrows from herdr's detector, because they are what makes tail matching usable:
//!
//! - a **region** per rule (usually the bottom handful of non-empty lines), so a phrase printed in the
//!   conversation above cannot be mistaken for a prompt;
//! - **negative patterns** per rule, so text the user typed or pasted (which the agent echoes) cannot
//!   masquerade as a signal;
//! - and four **confidence flags** plus `skip_state_update`, so a screen that is not live state at all (a
//!   transcript viewer, a pager) can say so instead of flipping the state.

/// The three states worth showing, plus "we do not know".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentState {
    /// Running: the spinner is moving or the tool says it is busy.
    Working,
    /// Waiting for the user: a question, a permission card, a choice.
    Blocked,
    /// Turn finished and the prompt is back.
    Idle,
    /// Nothing recognised on screen.
    Unknown,
}

impl AgentState {
    /// The wire name, which is also what the frontend store and the event carry.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Blocked => "attention",
            AgentState::Idle => "idle",
            AgentState::Unknown => "unknown",
        }
    }
}

/// Which part of the tail a rule looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    /// The bottom `n` lines that have anything on them. This is the default: an agent paints its spinner,
    /// its prompt box or its question at the bottom of the screen, while the conversation above is history.
    BottomNonEmptyLines(usize),
    /// The whole tail handed in.
    All,
}

/// What a rule looks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pattern {
    /// The text appears anywhere in the region, ignoring case.
    Contains(&'static str),
    /// One of these characters appears in the region. Spinners are drawn with a small character set that
    /// moves frame by frame, and the set is what identifies them.
    AnyChar(&'static [char]),
    /// Some line of the region starts with the text, ignoring case and leading spaces.
    LineStartsWith(&'static str),
}

/// One detection rule.
///
/// The fields mirror the shape of herdr's manifest entries (id, state, priority, region, the visible_*
/// flags, the patterns and their counter-examples) so rules can be read side by side with theirs; the
/// matcher itself is this module's own small one rather than a regex engine, because every rule the four
/// families need is a substring, a prefix or a character set, and a regex engine is a dependency and a
/// compile cost for nothing. A rule that ever needs more than that can be added here without touching the
/// judge.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    /// Stable name, carried into the detection so a test can assert which rule won.
    pub id: &'static str,
    pub state: AgentState,
    /// Highest wins. Live signals sit above idle ones, an on-screen question above both.
    pub priority: u16,
    pub region: Region,
    /// All of these must match the region.
    pub all_of: &'static [Pattern],
    /// None of these may match the region.
    pub none_of: &'static [Pattern],
    /// The screen is showing the agent working. Set on the working rules.
    pub visible_working: bool,
    /// The screen is showing a question the agent is waiting on.
    pub visible_blocker: bool,
    /// The screen is showing the agent at its prompt.
    pub visible_idle: bool,
    /// A match is real, but it is not live state (a transcript view, a pager): do not move the state.
    pub skip_state_update: bool,
}

impl Rule {
    /// A rule that carries no flags, which is the common shape: only the state matters.
    pub const fn plain(
        id: &'static str,
        state: AgentState,
        priority: u16,
        region: Region,
        all_of: &'static [Pattern],
        none_of: &'static [Pattern],
    ) -> Self {
        Self {
            id,
            state,
            priority,
            region,
            all_of,
            none_of,
            visible_working: false,
            visible_blocker: false,
            visible_idle: false,
            skip_state_update: false,
        }
    }

    /// The same, but marking the screen it matched as showing live work.
    pub const fn working(mut self) -> Self {
        self.visible_working = true;
        self
    }

    /// The same, but marking the screen it matched as showing a blocker.
    pub const fn blocker(mut self) -> Self {
        self.visible_blocker = true;
        self
    }

    /// The same, but marking the screen as the agent's own prompt.
    pub const fn idle(mut self) -> Self {
        self.visible_idle = true;
        self
    }

    /// The same, but saying this screen is not live state.
    pub const fn skip(mut self) -> Self {
        self.skip_state_update = true;
        self
    }
}

/// What the judge decided, plus how sure the matching screen was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentDetection {
    pub state: AgentState,
    pub visible_working: bool,
    pub visible_blocker: bool,
    pub visible_idle: bool,
    /// A match was found, but it is not live state; the caller must keep the state it had.
    pub skip_state_update: bool,
    /// The rule that decided, for logs and tests. `None` when nothing matched.
    pub rule: Option<&'static str>,
}

impl AgentDetection {
    /// Nothing on screen was recognised.
    pub const fn unknown() -> Self {
        Self {
            state: AgentState::Unknown,
            visible_working: false,
            visible_blocker: false,
            visible_idle: false,
            skip_state_update: false,
            rule: None,
        }
    }

    /// The state the user should see, which for a skipped screen is "no change".
    pub fn applies(self) -> bool {
        self.state != AgentState::Unknown && !self.skip_state_update
    }
}

/// The last `count` lines of `text` that have anything on them, in order.
///
/// Blank lines are skipped rather than counted: a TUI clears the area under its prompt with newlines, and
/// counting those would push the real signal out of the region.
pub fn bottom_non_empty_lines(text: &str, count: usize) -> String {
    let mut lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.len() > count {
        lines.drain(..lines.len() - count);
    }
    lines.join("\n")
}

/// The text a rule looks at.
fn region_text(tail: &str, region: Region) -> String {
    match region {
        Region::BottomNonEmptyLines(count) => bottom_non_empty_lines(tail, count),
        Region::All => tail.to_owned(),
    }
}

/// True when one pattern matches the text. Public because the families' identification step uses the
/// same matcher, so a rule and an identify pattern cannot drift apart.
pub fn pattern_hit(text: &str, pattern: Pattern) -> bool {
    match pattern {
        Pattern::Contains(needle) => {
            let haystack = text.to_lowercase();
            let needle = needle.to_lowercase();
            haystack.contains(&needle)
        }
        Pattern::AnyChar(set) => text.chars().any(|c| set.contains(&c)),
        Pattern::LineStartsWith(prefix) => text.lines().any(|line| {
            let trimmed = line.trim_start();
            // Characters, not bytes: an agent's markers are multi-byte (the caret, the spinner), and slicing
            // a string by byte offset would panic halfway through one of them.
            let head: String = trimmed.chars().take(prefix.chars().count()).collect();
            head.eq_ignore_ascii_case(prefix)
        }),
    }
}

fn rule_matches(tail: &str, rule: &Rule) -> bool {
    let region = region_text(tail, rule.region);
    if !rule.all_of.iter().all(|p| pattern_hit(&region, *p)) {
        return false;
    }
    !rule.none_of.iter().any(|p| pattern_hit(&region, *p))
}

/// Decide what the tail shows. The highest priority matching rule wins; a tie goes to the earlier rule in
/// the table, so the answer does not depend on iteration order of anything but the table itself.
pub fn evaluate(tail: &str, rules: &[Rule]) -> AgentDetection {
    let mut best: Option<&Rule> = None;
    for rule in rules {
        if !rule_matches(tail, rule) {
            continue;
        }
        match best {
            Some(current) if current.priority >= rule.priority => {}
            _ => best = Some(rule),
        }
    }
    match best {
        None => AgentDetection::unknown(),
        Some(rule) => AgentDetection {
            state: rule.state,
            visible_working: rule.visible_working,
            visible_blocker: rule.visible_blocker,
            visible_idle: rule.visible_idle,
            skip_state_update: rule.skip_state_update,
            rule: Some(rule.id),
        },
    }
}

/// Drop terminal control sequences so rules can match what a person sees.
///
/// The tap keeps raw bytes because the terminal needs them; the judge needs the opposite. Escape sequences
/// are removed (CSI, OSC and the two-character charset switches), carriage returns are dropped so a line
/// that was redrawn does not become two lines, and other control bytes are replaced by nothing rather than
/// splitting a word, which is what a cursor-move inside a word would do.
pub fn strip_ansi(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.peek() {
                // CSI: ESC [ ... final byte in 0x40..=0x7e
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next.is_ascii() && ('\u{40}'..='\u{7e}').contains(&next) {
                            break;
                        }
                    }
                    out.push('\n');
                }
                // OSC: ESC ] ... terminated by BEL or ESC \
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Charset switch: ESC ( x / ESC ) x
                Some('(') | Some(')') => {
                    chars.next();
                    chars.next();
                }
                _ => {}
            },
            '\r' => {}
            '\n' => out.push('\n'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPINNER: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

    fn rules() -> Vec<Rule> {
        vec![
            Rule::plain(
                "question",
                AgentState::Blocked,
                1000,
                Region::BottomNonEmptyLines(8),
                &[Pattern::Contains("do you want to proceed?")],
                &[],
            )
            .blocker(),
            Rule::plain(
                "spinner",
                AgentState::Working,
                800,
                Region::BottomNonEmptyLines(8),
                &[Pattern::AnyChar(SPINNER)],
                &[],
            )
            .working(),
            Rule::plain(
                "prompt",
                AgentState::Idle,
                400,
                Region::BottomNonEmptyLines(8),
                &[Pattern::LineStartsWith("> ")],
                &[],
            )
            .idle(),
        ]
    }

    #[test]
    fn a_question_on_screen_is_blocked() {
        let tail = "some work happened\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
        let found = evaluate(tail, &rules());
        assert_eq!(found.state, AgentState::Blocked);
        assert!(found.visible_blocker);
        assert_eq!(found.rule, Some("question"));
    }

    #[test]
    fn a_moving_spinner_is_working() {
        let found = evaluate("⠹ thinking about the answer\n", &rules());
        assert_eq!(found.state, AgentState::Working);
        assert!(found.visible_working);
    }

    #[test]
    fn the_prompt_alone_is_idle() {
        let found = evaluate("> \n", &rules());
        assert_eq!(found.state, AgentState::Idle);
        assert!(found.visible_idle);
    }

    #[test]
    fn nothing_recognised_stays_unknown() {
        let found = evaluate("$ ls -la\ntotal 0\n", &rules());
        assert_eq!(found.state, AgentState::Unknown);
        assert!(!found.applies());
        assert_eq!(found.rule, None);
    }

    #[test]
    fn a_question_printed_in_the_conversation_does_not_count() {
        // The phrase is far above the bottom of the screen: a rule that reads the whole tail would call this
        // blocked, and the region is what stops it.
        let mut tail = String::new();
        for n in 0..40 {
            tail.push_str(&format!("line {n}\n"));
        }
        tail.push_str("do you want to proceed?\n");
        for n in 0..12 {
            tail.push_str(&format!("later {n}\n"));
        }
        let found = evaluate(&tail, &rules());
        assert_eq!(found.state, AgentState::Unknown, "got {:?}", found.rule);
    }

    #[test]
    fn a_higher_priority_rule_beats_a_lower_one_on_the_same_screen() {
        // A spinner and a question at once: the question is what the user has to act on.
        let tail = "⠋ working\n Do you want to proceed?\n";
        assert_eq!(evaluate(tail, &rules()).state, AgentState::Blocked);
    }

    #[test]
    fn a_negative_pattern_stops_a_pasted_line_from_counting() {
        let guarded = vec![Rule::plain(
            "idle",
            AgentState::Idle,
            500,
            Region::BottomNonEmptyLines(4),
            &[Pattern::Contains("ready")],
            &[Pattern::Contains("not ready yet")],
        )
        .idle()];
        assert_eq!(evaluate("ready\n", &guarded).state, AgentState::Idle);
        assert_eq!(
            evaluate("the log said: not ready yet\n", &guarded).state,
            AgentState::Unknown
        );
    }

    #[test]
    fn a_skipped_screen_does_not_move_the_state() {
        let skipping = vec![Rule::plain(
            "viewer",
            AgentState::Unknown,
            900,
            Region::BottomNonEmptyLines(4),
            &[Pattern::Contains("-- transcript --")],
            &[],
        )
        .skip()];
        let found = evaluate("-- transcript --\n", &skipping);
        assert!(found.skip_state_update);
        assert!(!found.applies());
    }

    #[test]
    fn the_bottom_of_the_tail_is_what_the_region_reads() {
        let text = "one\n\n two \n\nthree\nfour\n";
        assert_eq!(bottom_non_empty_lines(text, 2), "three\nfour");
        assert_eq!(bottom_non_empty_lines(text, 10), "one\n two \nthree\nfour");
    }

    #[test]
    fn the_wire_names_are_the_ones_the_frontend_already_knows() {
        // `agentActivity.ts` maps these three kinds onto its phases; keep them spelled the same here.
        assert_eq!(AgentState::Working.as_str(), "working");
        assert_eq!(AgentState::Blocked.as_str(), "attention");
        assert_eq!(AgentState::Idle.as_str(), "idle");
    }

    #[test]
    fn escape_sequences_do_not_reach_the_rules() {
        let raw = b"\x1b[2J\x1b[1;1HDo you want\x1b[K to proceed?\x07\x1b]0;title\x07\n";
        let text = strip_ansi(raw);
        assert!(text.contains("Do you want"), "got {text:?}");
        assert!(text.contains("to proceed?"), "got {text:?}");
        assert!(!text.contains('\u{1b}'), "got {text:?}");
        assert!(!text.contains("title"), "the OSC payload is not text: {text:?}");
    }

    #[test]
    fn a_carriage_return_does_not_split_a_line() {
        // Progress lines are redrawn with \r rather than \n; keeping the \r would turn one line into several
        // and hand the rules a line that was never on screen.
        let text = strip_ansi(b"loading 1%\rloading 42%\rloading 100%\n");
        assert_eq!(text.trim_end(), "loading 1%loading 42%loading 100%");
        assert_eq!(text.lines().count(), 1);
    }

    #[test]
    fn a_prefix_pattern_ignores_the_indent_a_tui_uses() {
        let rules = vec![Rule::plain(
            "prompt",
            AgentState::Idle,
            400,
            Region::BottomNonEmptyLines(4),
            &[Pattern::LineStartsWith("> ")],
            &[],
        )
        .idle()];
        assert_eq!(evaluate("      > \n", &rules).state, AgentState::Idle);
        assert_eq!(evaluate("      >> \n", &rules).state, AgentState::Unknown);
    }
}