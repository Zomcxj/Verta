import { describe, expect, it } from "vitest";
import {
  type AgentRule,
  anyChar,
  bottom,
  bottomNonEmptyLines,
  contains,
  detectionApplies,
  evaluate,
  lineStartsWith,
  rule,
  UNKNOWN_DETECTION,
} from "./agentState";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function rules(): AgentRule[] {
  return [
    rule({
      id: "question",
      state: "blocked",
      priority: 1000,
      region: bottom(8),
      allOf: [contains("do you want to proceed?")],
    }),
    rule({
      id: "spinner",
      state: "working",
      priority: 800,
      region: bottom(8),
      allOf: [anyChar(SPINNER)],
    }),
    rule({
      id: "prompt",
      state: "idle",
      priority: 400,
      region: bottom(8),
      allOf: [lineStartsWith("> ")],
    }),
  ];
}

describe("evaluate", () => {
  it("reads a question on screen as blocked", () => {
    const tail =
      "some work happened\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";
    const found = evaluate(tail, rules());
    expect(found.state).toBe("blocked");
    expect(found.visibleBlocker).toBe(true);
    expect(found.rule).toBe("question");
  });

  it("reads a moving spinner as working", () => {
    const found = evaluate("⠹ thinking about the answer\n", rules());
    expect(found.state).toBe("working");
    expect(found.visibleWorking).toBe(true);
  });

  it("reads the prompt alone as idle", () => {
    const found = evaluate("> \n", rules());
    expect(found.state).toBe("idle");
    expect(found.visibleIdle).toBe(true);
  });

  it("stays unknown when nothing is recognised", () => {
    const found = evaluate("$ ls -la\ntotal 0\n", rules());
    expect(found).toEqual(UNKNOWN_DETECTION);
    expect(detectionApplies(found)).toBe(false);
  });

  it("does not count a question printed in the conversation above", () => {
    // The phrase is far above the bottom of the screen: a rule that read the whole
    // tail would call this blocked, and the region is what stops it.
    const lines: string[] = [];
    for (let n = 0; n < 40; n += 1) lines.push(`line ${n}`);
    lines.push("do you want to proceed?");
    for (let n = 0; n < 12; n += 1) lines.push(`later ${n}`);
    const found = evaluate(`${lines.join("\n")}\n`, rules());
    expect(found.state).toBe("unknown");
  });

  it("lets a higher priority rule beat a lower one on the same screen", () => {
    // A spinner and a question at once: the question is what the user has to act on.
    expect(
      evaluate("⠋ working\n Do you want to proceed?\n", rules()).state,
    ).toBe("blocked");
  });

  it("stops a pasted line counting with a negative pattern", () => {
    const guarded = [
      rule({
        id: "idle",
        state: "idle",
        priority: 500,
        region: bottom(4),
        allOf: [contains("ready")],
        noneOf: [contains("not ready yet")],
      }),
    ];
    expect(evaluate("ready\n", guarded).state).toBe("idle");
    expect(evaluate("the log said: not ready yet\n", guarded).state).toBe(
      "unknown",
    );
  });

  it("treats a skipped screen as no state change", () => {
    const skipping = [
      rule({
        id: "viewer",
        state: "unknown",
        priority: 900,
        region: bottom(4),
        allOf: [contains("-- transcript --")],
      }),
    ];
    const found = evaluate("-- transcript --\n", skipping);
    expect(found.skipStateUpdate).toBe(true);
    expect(detectionApplies(found)).toBe(false);
  });

  it("breaks a priority tie toward the earlier rule in the table", () => {
    const tied = [
      rule({
        id: "first",
        state: "working",
        priority: 500,
        region: bottom(4),
        allOf: [contains("busy")],
      }),
      rule({
        id: "second",
        state: "idle",
        priority: 500,
        region: bottom(4),
        allOf: [contains("busy")],
      }),
    ];
    expect(evaluate("busy\n", tied).rule).toBe("first");
  });
});

describe("bottomNonEmptyLines", () => {
  it("reads the bottom of the tail", () => {
    const text = "one\n\n two \n\nthree\nfour\n";
    expect(bottomNonEmptyLines(text, 2)).toBe("three\nfour");
  });

  it("keeps everything when the tail is shorter than the region", () => {
    const text = "one\n\n two \n\nthree\nfour\n";
    expect(bottomNonEmptyLines(text, 10)).toBe("one\n two \nthree\nfour");
  });
});

describe("rule flags", () => {
  it("derives the confidence flag from the state", () => {
    expect(
      rule({ id: "w", state: "working", priority: 1, allOf: [contains("x")] }),
    ).toMatchObject({
      visibleWorking: true,
      visibleBlocker: false,
      visibleIdle: false,
      skipStateUpdate: false,
    });
    expect(
      rule({ id: "b", state: "blocked", priority: 1, allOf: [contains("x")] }),
    ).toMatchObject({ visibleBlocker: true });
    expect(
      rule({ id: "i", state: "idle", priority: 1, allOf: [contains("x")] }),
    ).toMatchObject({ visibleIdle: true });
    expect(
      rule({ id: "s", state: "unknown", priority: 1, allOf: [contains("x")] }),
    ).toMatchObject({ skipStateUpdate: true });
  });
});

describe("a prefix pattern", () => {
  it("ignores the indent a TUI uses", () => {
    const onlyPrompt = [
      rule({
        id: "prompt",
        state: "idle",
        priority: 400,
        region: bottom(4),
        allOf: [lineStartsWith("> ")],
      }),
    ];
    expect(evaluate("      > \n", onlyPrompt).state).toBe("idle");
    expect(evaluate("      >> \n", onlyPrompt).state).toBe("unknown");
  });

  it("compares the caret as a character, not a byte", () => {
    // The multi-byte caret is what the agents mark a selected row with; a rule
    // that sliced by byte offset would read it as two different characters.
    const choice = [
      rule({
        id: "choice",
        state: "blocked",
        priority: 900,
        region: bottom(4),
        allOf: [lineStartsWith("❯ 1.")],
      }),
    ];
    expect(evaluate("❯ 1. Yes\n", choice).state).toBe("blocked");
    expect(evaluate("  ❯ 1. Yes\n", choice).state).toBe("blocked");
    expect(evaluate("❯ 2. No\n", choice).state).toBe("unknown");
  });
});
