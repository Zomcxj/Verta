import { describe, expect, it } from "vitest";
import { evaluate } from "./agentState";
import {
  type AgentFamily,
  FAMILIES,
  familyFor,
  identifyAgent,
  SPINNER_FRAMES,
} from "./agentRules";

/** A real capture from this machine: the shell's own prompt (pty-1.bin). */
const SHELL_TAIL =
  "special@LAPTOP MINGW64 /f/VibeCoding_workspace/Verta (main)\n$ ";

/** Real captures: opencode's footer and spinner (pty-2.bin / pty-4.bin). */
const OPENCODE_WORKING =
  "Writing the patch\n⠹ Thinking\nctrl+p commands   · Tokens 12.4k";
const OPENCODE_IDLE = "Where to next?\nctrl+p commands   · Tokens 12.4k";

/**
 * The screen a false ending came from, kept verbatim from the capture
 * (`scripts/dev/probes/state-dot-watch.mjs`, 2026-10-27): a turn in flight, with the footer's
 * own progress bar and interrupt hint on its last line. The judge read this as idle, reported
 * the session as finished, and put "a turn finished" into Windows' store.
 */
const OPENCODE_INTERRUPTIBLE = [
  "     ↳ Shell finished · cd /d/VsPro/Verta && node scripts/dev/probes/state-dot-watch.mjs",
  "     + 3 commands, 1 thought",
  "  ┃",
  "  ┃  Build auto · deepseek-v4.1-flash workbuddy · max",
  "   ⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt                       命中率 99.5% ↑0.2% · Tokens 1061.4M · 余额 - ·   ↓ 2 shells · 258.6K (52%)  ctrl+p commands",
].join("\n");

/**
 * The same footer with the interrupt hint gone: the turn has ended but the background shells on
 * that footer have not. Measured, the count falls as those commands finish (three to two on this
 * machine while the session carried on); that the two go together on a real screen has not been
 * captured yet, and this sample is that footer with the turn's hint removed. A rule that reads it
 * as work is what the case needs, and the cost of being wrong is a session that reads as busy a
 * moment longer - not the false alarm the other direction would give.
 */
const OPENCODE_BACKGROUND_SHELL = [
  "     + 3 commands, 1 thought",
  "  ┃",
  "  ┃  Build auto · deepseek-v4.1-flash workbuddy · max",
  "   命中率 99.5% ↑0.2% · Tokens 1061.4M · 余额 - ·   ↓ 2 shells · 258.6K (52%)  ctrl+p commands",
].join("\n");

/** Written from herdr's rules; not yet seen on this machine. */
const CLAUDE_BLOCKED =
  "  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n? for shortcuts";
const CLAUDE_WORKING =
  "⠼ Running the tests\n  esc to interrupt\n? for shortcuts";
const CLAUDE_IDLE = "> \n? for shortcuts";

const CODEX_BLOCKED = "Approve? [y/n]";
const CODEX_IDLE = "$ \nesc to interrupt";

/** The full-width rule pi draws above and below its input (124 columns in the captures). */
const PI_RULE = "─".repeat(124);

/**
 * pi, captured on this machine (2026-10-26) with `scripts/dev/probes/agent-lab.mjs`.
 * Each sample is the bottom of the screen as the terminal model reported it.
 */
const PI_IDLE = [
  "（以上正文约 210 字）",
  " sensenova-6.8-flash-lite | think:med | dir verta-pi-probe | ◫ 17k/262k (6.6%) AC | cache in: 49k | LSP Inactive",
  PI_RULE,
  PI_RULE,
  " ↳ 读一下 a.txt 和 b.txt，比较内容差异，然后用中文写一段 200 字的说明",
].join("\n");
/** Same interface, working: the label is a phrase from the user's whimsical extension. */
const PI_WORKING = [
  " ◠ Bhor bhaye panghat pe...",
  " sensenova-6.8-flash-lite | think:med | dir verta-pi-probe | ◫ 17k/262k (6.4%) AC | cache in: 33k | LSP Inactive",
  PI_RULE,
  PI_RULE,
  " ↳ 读一下 a.txt 和 b.txt，比较内容差异，然后用中文写一段 200 字的说明",
].join("\n");
/** Waiting on the user: the card an `ask_user` call raises. */
const PI_BLOCKED = [
  " 删除文件选择",
  " 该删掉 a.txt 还是 b.txt？",
  " → 删掉 a.txt — 移除 a.txt，保留 b.txt",
  "   删掉 b.txt — 移除 b.txt，保留 a.txt",
  "   Other (type your answer)",
  " ↑↓ navigate  enter select  escape/ctrl+c cancel",
  PI_RULE,
  " ↳ 请再用 ask_user 工具问我：该删掉 a.txt 还是 b.txt？",
].join("\n");
/** The same interface with `--no-extensions`: pi's own chrome, no extension footers. */
const PI_BARE_WORKING = [
  "用一句话说明 notes.txt 里写了什么",
  "── ⠙ Working ─────────────────────────────────────────────────────────────",
  PI_RULE,
  "~\\AppData\\Local\\Temp\\verta-pi-probe",
  "1.6%/262k (auto)                                             (sensenova) sensenova-6.8-flash-lite • medium",
].join("\n");
const PI_BARE_IDLE = [
  "notes.txt 或类似“note”的文件，所以没法概括它的内容。",
  PI_RULE,
  PI_RULE,
  "~\\AppData\\Local\\Temp\\verta-pi-probe",
  "↑6.9k ↓227 R8.2k CH78.8% 2.0%/262k (auto)                     (sensenova) sensenova-6.8-flash-lite • medium",
].join("\n");
/** pi's welcome screen before its interface is up (`Press any key to continue (30s)`). */
const PI_STARTUP = [
  "This project is not trusted. Project .pi resources and packages are ignored.",
  "╰───────────────────── Press any key to continue (24s) ──────────────────────╯",
].join("\n");
/**
 * The half-minute before that, captured live: pi paints its banner, says startup is still
 * running, and sits there. The judge read this as `idle` until it was looked at.
 */
const PI_STARTUP_PROGRESS = [
  "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
  "Startup is still in progress",
  PI_RULE,
  PI_RULE,
  "~\\AppData\\Local\\Temp\\verta-guard-probe",
  "0.0%/500k (auto)                                       deepseek-chat • high",
].join("\n");
/**
 * And the window before that one, also captured live: pi's banner is up, its interface is
 * not, and no status line has been painted. This read as `idle` for the whole capture.
 */
const PI_STARTUP_BANNER = [
  " ▀▀█  v1.4.0",
  " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
  " Press ctrl+o to show full startup help and loaded resources.",
  " Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
  PI_RULE,
  PI_RULE,
  "~\\AppData\\Local\\Temp\\verta-guard-probe",
  "0.0%/500k (auto)                                       deepseek-chat • high",
].join("\n");

/**
 * The same banner as above, on a session that is merely *open*: the counters have arrived, so
 * pi's interface is up and it is sitting at its prompt, with the banner simply left in the
 * scrollback above it. Captured from a live session on this machine (`~` / `~ • daily task`,
 * the footer of an extension).
 */
const PI_OPENED_AT_PROMPT = [
  "cxj@WIN-J8J3DU0CI9T MINGW64 ~",
  "$ pi --session 01a17b4e-6029-74cd-8263-9fc1486db7ef",
  " ▀▀█  v1.4.0",
  " █▀ █ escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
  " Press ctrl+o to show full startup help and loaded resources.",
  " Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
  PI_RULE,
  PI_RULE,
  "~ • daily task",
  "↑629k ↓39k R4.1M CH99.2% 19.5%/500k (auto)                                        MiniMax-M3.1-Flash",
].join("\n");

function judge(tool: string, tail: string): string {
  const family = familyFor(tool) as AgentFamily;
  expect(family).not.toBeNull();
  return evaluate(tail, family.rules).state;
}

describe("identifyAgent", () => {
  it("never reads a plain shell prompt as an agent", () => {
    expect(identifyAgent(SHELL_TAIL)).toBeNull();
    expect(identifyAgent("$ ls\n$ git status\n")).toBeNull();
  });

  it("identifies opencode by its own footer", () => {
    expect(identifyAgent(OPENCODE_IDLE)?.tool).toBe("opencode");
    expect(identifyAgent(OPENCODE_WORKING)?.tool).toBe("opencode");
  });

  it("does not read a shell echoing an agent's name as that agent", () => {
    const shell = "$ codex --help\nUsage: codex [options]\n$ ";
    expect(identifyAgent(shell)).toBeNull();
  });

  it("gates the rules: a spinner in plain output is not an agent at work", () => {
    const shellProgress = "⠹ downloading\n⠸ unpacking\n$ ";
    expect(identifyAgent(shellProgress)).toBeNull();
  });

  it("reads a screen with no agent chrome as no agent", () => {
    expect(identifyAgent("What should I do?\n")).toBeNull();
  });

  it("identifies pi by the rules its own interface draws", () => {
    expect(identifyAgent(PI_IDLE)?.tool).toBe("pi");
    expect(identifyAgent(PI_WORKING)?.tool).toBe("pi");
    expect(identifyAgent(PI_BLOCKED)?.tool).toBe("pi");
    expect(identifyAgent(PI_BARE_IDLE)?.tool).toBe("pi");
    expect(identifyAgent(PI_BARE_WORKING)?.tool).toBe("pi");
  });

  it("does not read a shell that printed a separator as pi", () => {
    const shell =
      "special@LAPTOP MINGW64 /d/VsPro/Verta (main)\n$ pytest -q\n" +
      "------------------------------------ 3 passed ------------------------------------\n$ ";
    expect(identifyAgent(shell)).toBeNull();
  });
});

/** The question panel as this machine drew it (2026-10-30, `state-dot-watch.mjs --once`). */
const OPENCODE_QUESTIONS_PANEL = [
  " ? daily task                    +",
  "→ Asked 1 question",
  "┃  Questions  ┃",
  "┃  你喜欢吃什么？  ┃",
  "┃  1. 火锅  ┃",
  "┃      经典中式美食  ┃",
  "┃  2. 牛排  ┃",
  "┃  5. Type your own answer  ┃",
  "┃  ↑↓ select  enter submit  esc dismiss  ┃",
].join("\n");

describe("opencode", () => {
  it("tells working and idle apart", () => {
    expect(judge("opencode", OPENCODE_WORKING)).toBe("working");
    expect(judge("opencode", OPENCODE_IDLE)).toBe("idle");
  });

  it("reads a turn in flight from the footer, not only from the spinner", () => {
    // The false ending measured on this machine: the spinner glyph was between frames, the
    // footer still said the turn could be interrupted, and the judge settled on idle.
    expect(judge("opencode", OPENCODE_INTERRUPTIBLE)).toBe("working");
  });

  it("keeps a session busy while a background shell on its footer is still running", () => {
    expect(judge("opencode", OPENCODE_BACKGROUND_SHELL)).toBe("working");
  });

  it("keeps a moving frame out of idle", () => {
    for (const frame of SPINNER_FRAMES) {
      const tail = `${frame} Thinking\nctrl+p commands   · Tokens 1k`;
      expect(judge("opencode", tail)).toBe("working");
    }
  });

  it("reads a permission card as blocked", () => {
    const tail =
      "△ Permission required\n  Allow once\n  Allow always\n  Deny\nctrl+p commands";
    expect(judge("opencode", tail)).toBe("blocked");
  });

  it("reads a question card as blocked", () => {
    const tail =
      "? Which model should I use\n❯ 1. Fast\n  2. Smart\nctrl+p commands";
    expect(judge("opencode", tail)).toBe("blocked");
  });

  it("reads the question panel this machine actually draws as blocked", () => {
    // Verbatim rows from `scripts/dev/probes/state-dot-watch.mjs --once`, taken while a session sat
    // waiting on an answer. Two things differ from the card above: the options carry no `❯`, and
    // the footer's hints are the panel's own. That session was drawn green (idle) at the time.
    expect(judge("opencode", OPENCODE_QUESTIONS_PANEL)).toBe("blocked");
  });

  it("still recognizes the question panel as opencode at all", () => {
    // Its footer replaces the usual `ctrl+p` and `· tokens` hints, so nothing else on that screen
    // identifies the tool - without a marker of its own the session reads as having no agent.
    expect(identifyAgent(OPENCODE_QUESTIONS_PANEL)?.tool).toBe("opencode");
  });

  it("does not turn a pasted footer into a question", () => {
    // The panel is recognized by two chrome phrases together; either alone is ordinary text.
    const tail = "we could make enter submit do something else\nctrl+p commands   · Tokens 1k";
    expect(judge("opencode", tail)).not.toBe("blocked");
  });

  it("does not read a pasted transcript as a permission card", () => {
    const tail =
      "> allow me to explain what happened\n  permission was granted earlier\nctrl+p commands";
    expect(judge("opencode", tail)).not.toBe("blocked");
  });
});

describe("claude", () => {
  it("reads blocked, working and idle", () => {
    expect(judge("claude", CLAUDE_BLOCKED)).toBe("blocked");
    expect(judge("claude", CLAUDE_WORKING)).toBe("working");
    expect(judge("claude", CLAUDE_IDLE)).toBe("idle");
  });

  it("does not let the prompt marker turn a question into idle", () => {
    const tail = "  Do you want to proceed?\n  ❯ 1. Yes\n> \n? for shortcuts";
    expect(judge("claude", tail)).toBe("blocked");
  });
});

describe("codex", () => {
  it("reads blocked and idle", () => {
    expect(judge("codex", CODEX_BLOCKED)).toBe("blocked");
    expect(judge("codex", CODEX_IDLE)).toBe("idle");
  });
});

describe("pi", () => {
  it("reads blocked, working and idle", () => {
    expect(judge("pi", PI_IDLE)).toBe("idle");
    expect(judge("pi", PI_WORKING)).toBe("working");
    expect(judge("pi", PI_BLOCKED)).toBe("blocked");
    expect(judge("pi", PI_BARE_IDLE)).toBe("idle");
    expect(judge("pi", PI_BARE_WORKING)).toBe("working");
  });

  it("reads every frame of both spinners as work", () => {
    for (const frame of ["⠋", "⠙", "⠼", "◜", "◝", "◠", "◡"]) {
      const tail = `${frame} Musing...\n${PI_RULE}\n${PI_RULE}`;
      expect(judge("pi", tail)).toBe("working");
    }
  });

  it("calls the welcome screen busy rather than idle", () => {
    expect(judge("pi", PI_STARTUP)).toBe("working");
    expect(judge("pi", PI_STARTUP_PROGRESS)).toBe("working");
    expect(judge("pi", PI_STARTUP_BANNER)).toBe("working");
  });

  it("stops reading an opened session as work once pi's interface is up", () => {
    // Measured live on 2026-10-27 by `scripts/dev/probes/state-dot-watch.mjs`, which records the
    // rule that won and the rows it read. The screen is `PI_STARTUP_BANNER` with its counters
    // moving: the banner stays in the scrollback for the life of the session, so a session that
    // was merely open read as work for as long as its tab was open, and sat above the idle rule.
    expect(judge("pi", PI_OPENED_AT_PROMPT)).toBe("idle");
  });

  it("does not read a prompt that mentions the question as a question card", () => {
    // The echo of what the user typed sits below the input, and it can name the tool
    // and repeat the question without any card being on screen.
    const tail = [
      PI_RULE,
      " ↳ 请再用 ask_user 工具问我：该删掉 a.txt 还是 b.txt？",
    ].join("\n");
    expect(judge("pi", tail)).toBe("idle");
  });

  it("does not read the agent's own words as work", () => {
    // The label is a phrase from an extension, so it is a spinner that says work; an
    // answer that says the same word while nothing is running is still idle.
    const tail = [
      "Working through the diff now, the remaining question is which file to touch.",
      PI_RULE,
      PI_RULE,
    ].join("\n");
    expect(judge("pi", tail)).toBe("idle");
  });
});

describe("the family table", () => {
  it("names the tools the rest of the app uses", () => {
    for (const tool of ["opencode", "pi", "claude", "codex"]) {
      expect(familyFor(tool)?.tool).toBe(tool);
    }
    expect(familyFor("nonesuch")).toBeNull();
  });

  it("keeps every rule id unique across families", () => {
    const seen = new Set<string>();
    for (const family of FAMILIES) {
      for (const candidate of family.rules) {
        expect(seen.has(candidate.id)).toBe(false);
        seen.add(candidate.id);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("gives every rule a state it can show", () => {
    for (const family of FAMILIES) {
      for (const candidate of family.rules) {
        const flags = [
          candidate.visibleWorking,
          candidate.visibleBlocker,
          candidate.visibleIdle,
          candidate.skipStateUpdate,
        ];
        expect(flags.filter(Boolean)).toHaveLength(1);
      }
    }
  });
});
