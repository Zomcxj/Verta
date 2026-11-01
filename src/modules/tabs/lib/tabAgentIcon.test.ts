import { describe, expect, it } from "vitest";
import { tabAgentIcon } from "./tabAgentIcon";
import type { Tab } from "./useTabs";

/**
 * The truth table the icon and the marker both read.
 *
 * Written because the first version of the marker guard read the condition as source text and so
 * pinned a spelling instead of an answer: it asserted `tab.agent !== null`, which is true for a tab
 * with no `agent` property at all, and every terminal tab in the window was marked while the
 * assertion passed. The shapes below are the ones measured on the dev build (2026-11-01).
 */

const terminal = (agent?: string) =>
  ({
    kind: "terminal",
    id: 1,
    title: "Desktop",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...(agent === undefined ? {} : { agent }),
  }) as unknown as Tab;

describe("tabAgentIcon", () => {
  it("is the agent the tab was opened for", () => {
    expect(tabAgentIcon(terminal("opencode"))).toBe("opencode");
    expect(tabAgentIcon(terminal("pi"))).toBe("pi");
  });

  it("is nothing for a terminal tab that was not opened for one", () => {
    // The case this exists for: Ctrl+T makes a terminal tab and never sets `agent`, so the property
    // is absent rather than null.
    const opened = terminal();
    expect(tabAgentIcon(opened)).toBeNull();
    expect("agent" in opened).toBe(false);
  });

  it("is nothing when the property is there but empty", () => {
    // A tab that came back through storage with the field present and null is the same tab.
    expect(
      tabAgentIcon({ ...terminal(), agent: null } as unknown as Tab),
    ).toBeNull();
  });

  it("is nothing for a tab that is not a terminal", () => {
    expect(
      tabAgentIcon({
        kind: "editor",
        id: 3,
        title: "a.ts",
      } as unknown as Tab),
    ).toBeNull();
  });
});
