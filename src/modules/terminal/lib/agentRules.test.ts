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

/** Written from herdr's rules; not yet seen on this machine. */
const CLAUDE_BLOCKED =
  "  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n? for shortcuts";
const CLAUDE_WORKING =
  "⠼ Running the tests\n  esc to interrupt\n? for shortcuts";
const CLAUDE_IDLE = "> \n? for shortcuts";

const CODEX_BLOCKED = "Approve? [y/n]";
const CODEX_IDLE = "$ \nesc to interrupt";

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

  it("keeps a family with no identify pattern silent", () => {
    // pi until its own screen has been captured: identified by nothing, so the
    // rules never even get a chance to fire.
    expect(familyFor("pi")?.identify).toHaveLength(0);
    expect(identifyAgent("What should I do?\n")).toBeNull();
  });
});

describe("opencode", () => {
  it("tells working and idle apart", () => {
    expect(judge("opencode", OPENCODE_WORKING)).toBe("working");
    expect(judge("opencode", OPENCODE_IDLE)).toBe("idle");
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
