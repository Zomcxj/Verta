import { describe, expect, it } from "vitest";
import { agentColor } from "./agentIcon";

describe("agentColor", () => {
  it("gives each agent it knows a colour no neighbour shares", () => {
    const agents = ["claude", "pi", "opencode", "zcode", "workbuddy", "dsh"];
    const colors = agents.map(agentColor);
    expect(new Set(colors).size).toBe(agents.length);
    for (const color of colors) expect(color).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("matches case-insensitively and on the names the tools are stored under", () => {
    expect(agentColor("Claude Code")).toBe("#D97757");
    expect(agentColor("claude")).toBe("#D97757");
    expect(agentColor("opencode")).toBe(agentColor("OpenCode"));
  });

  it("does not read pi out of another agent's name", () => {
    expect(agentColor("copilot")).not.toBe(agentColor("pi"));
    expect(agentColor("api-agent")).not.toBe(agentColor("pi"));
    expect(agentColor("pi")).toBe(agentColor("PI"));
  });

  it("still colours an agent the table has never heard of", () => {
    expect(agentColor("something-new")).toMatch(/^#[0-9A-F]{6}$/i);
  });
});
