import { describe, expect, it } from "vitest";
import { agentColor, agentMark } from "./agentIcon";

describe("agentMark", () => {
  it("ships a mark for the six agents this app reads", () => {
    for (const agent of [
      "opencode",
      "pi",
      "zcode",
      "workbuddy",
      "dsh",
    ]) {
      expect(agentMark(agent), agent).toMatch(/^\/agents\/[a-z]+\.png$/);
    }
    expect(agentMark("deepseek-harness")).toBe("/agents/dsh.png");
    expect(agentMark("workbuddy-ai")).toBe("/agents/workbuddy.png");
  });

  it("does not read pi out of another agent's name", () => {
    expect(agentMark("pi")).toBe("/agents/pi.png");
    expect(agentMark("PI")).toBe("/agents/pi.png");
    expect(agentMark("copilot")).toBe(null);
    expect(agentMark("api-agent")).toBe(null);
  });

  it("has no mark for an agent it does not ship, so a drawn one is used instead", () => {
    expect(agentMark("claude")).toBe(null);
    expect(agentMark("something-new")).toBe(null);
  });
});

describe("agentColor", () => {
  it("keeps Claude Code's own colour, whatever case the name arrives in", () => {
    expect(agentColor("claude")).toBe("#D97757");
    expect(agentColor("Claude Code")).toBe("#D97757");
  });

  it("still colours an agent the table has never heard of", () => {
    expect(agentColor("something-new")).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("does not hand every drawn mark the same colour", () => {
    const colors = ["claude", "gemini", "grok", "codex", "unknown"].map(agentColor);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
