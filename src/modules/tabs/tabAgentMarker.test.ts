import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Which tabs draw the agent state marker.
 *
 * The marker says "an agent is on this session", and the person it is drawn for asked for it to
 * follow the icon: a tab whose icon is the agent's is marked, a tab whose icon is the plain terminal
 * is not. That is not the same as "the activity store knows something about this pty" - the judge
 * finds agents by reading screens, so it also knows about an agent that was typed into a plain
 * shell, and that tab's icon still says terminal.
 *
 * What is left here is the wiring, because the chip cannot be rendered without a whole tab strip.
 * The decision itself is `tabAgentIcon`, and it has a truth-table test of its own
 * (`lib/tabAgentIcon.test.ts`). That split is the lesson of the first version of this file: it read
 * the condition as source text, the text was `tab.agent !== null`, a tab opened with Ctrl+T has no
 * `agent` property at all - so `undefined !== null` was true, every terminal tab in the window was
 * marked, and the assertion passed the whole time.
 */
const chip = readFileSync(new URL("./TabChip.tsx", import.meta.url), "utf8");

describe("the tab's agent marker", () => {
  it("is drawn only on a tab whose icon is an agent's", () => {
    // Both halves of the condition, in the order they are written: the state has to exist, and the
    // tab has to be one whose icon is the agent's.
    expect(chip).toContain(
      "agentStatus.state !== null && tabAgentIcon(tab) !== null",
    );
  });

  it("is not conditioned on the store alone", () => {
    // The shape before this was asked for, which marked a plain shell that an agent had been typed
    // into.
    expect(chip).not.toContain("{agentStatus.state !== null ? (");
  });

  it("asks its question in one place, the same one the icon asks", () => {
    // Both readers of `tab.agent` go through the predicate. A test of that property written here
    // instead is how the icon and the marker came apart the first time.
    expect(chip).toContain('from "./lib/tabAgentIcon"');
    expect(chip).not.toContain("tab.agent");
  });
});
