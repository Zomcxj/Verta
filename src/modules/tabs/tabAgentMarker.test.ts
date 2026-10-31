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
 * Read as source text, because the condition is one expression in a memoised component and there is
 * no way to render it without a whole tab strip: what is being pinned is which predicate the marker
 * hangs on, and that is visible in the source.
 */
const chip = readFileSync(new URL("./TabChip.tsx", import.meta.url), "utf8");

describe("the tab's agent marker", () => {
  it("is drawn only on a tab whose icon is an agent's", () => {
    // Both halves of the condition, in the order they are written: the state has to exist, and the
    // tab's icon has to be the agent's.
    expect(chip).toContain("agentStatus.state !== null && hasAgentIcon(tab)");
    // The predicate itself: a terminal tab that was opened for an agent.
    expect(chip).toMatch(
      /function hasAgentIcon\(tab: Tab\): boolean \{\s*return tab\.kind === "terminal" && tab\.agent !== null;/,
    );
  });

  it("is not drawn on a bare terminal tab", () => {
    // The negative half, spelled out: the marker must not be conditioned on the store alone. That
    // was the shape before this was asked for, and it marked a plain shell that an agent had been
    // typed into.
    expect(chip).not.toContain("{agentStatus.state !== null ? (");
  });
});
