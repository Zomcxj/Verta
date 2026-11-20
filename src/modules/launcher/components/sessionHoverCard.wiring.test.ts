import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The card that follows the pointer along the session list.
 *
 * A row says a title and, at the standard density, three numbers. What a session *is* - its id, its
 * directory, and which session it belongs to - was reachable only by opening the dialog from the
 * row's menu, or, at the compact density, through a card that the standard density did not draw at
 * all. The contract now is one card, for every row, in either density and in either mode: hovering is
 * how a session is read, and ticking it first must not be the price of asking.
 *
 * The card is a glance, not a record. It says the id, the directory and the usage, plus the parent
 * for a subagent; the agent, the source and the subagents a session started are the dialog's job.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const list = readFileSync(new URL("./SessionList.tsx", import.meta.url), "utf8");
const card = readFileSync(
  new URL("./SessionHoverCard.tsx", import.meta.url),
  "utf8",
);
const facts = readFileSync(
  new URL("./SessionFacts.tsx", import.meta.url),
  "utf8",
);
const dialog = readFileSync(
  new URL("./SessionInfoDialog.tsx", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("./LauncherPanel.tsx", import.meta.url),
  "utf8",
);

describe("the session hover card", () => {
  it("is drawn for a row whatever the density", () => {
    // The one thing the card used to be gated on. A compact row needs it more, a standard row needs
    // it too: three numbers are not a session.
    expect(list).not.toMatch(/density === "compact"/);
    expect(list).toMatch(/onHover=\{hoverRow\}/);
  });

  it("is drawn while managing, whether or not the row is ticked", () => {
    // Ticking is the manage view's action, not its gate. The card is opened by the pointer, so a row
    // that is ticked still answers which session it is.
    expect(list).toMatch(/const showCard =[\s\S]{0,200}?hovered !== null/);
    expect(list).not.toMatch(/showCard =[\s\S]{0,200}?!selectable/);
  });

  it("never steps aside, because a row is never a text field", () => {
    // The card steps aside for nothing now: renaming happens in the agent's own terminal, so a row
    // is never a text field and there is no state that has to keep the card away.
    expect(list).not.toContain("isRenaming");
    expect(list).toMatch(/const showCard = hovered !== null && hoveredSession !== null;/);
  });

  it("reads the session from the same block the dialog draws", () => {
    // Two surfaces, one description: a card and a dialog that disagreed about a number would be
    // worse than either alone.
    expect(card).toContain("SessionFacts");
    expect(dialog).toContain("SessionFacts");
    expect(facts).toContain("data-session-facts");
    expect(facts).toContain("data-session-facts-id");
    expect(facts).toContain("data-session-facts-dir");
    expect(facts).toContain("data-session-facts-stats");
  });

  it("says the parent on a subagent's row and nothing on a top-level one", () => {
    // A top-level session belongs to nothing; a row saying so on every line of the list is a field
    // that never carries information.
    expect(facts).toContain("data-session-facts-parent");
    expect(facts).toMatch(/session\.parentId !== null \? \(/);
    expect(facts).toContain('t("launcher.infoParent")');
  });

  it("leaves the record to the dialog: the agent, the source and the children", () => {
    // Asked for by name: the card is the id, the directory, the usage and the parent. What a session
    // started is a list that can run to fifty rows, and the card cannot scroll - it takes no pointer
    // events, or it would keep itself open.
    expect(card).not.toContain("maxChildren");
    expect(card).not.toContain("origin=");
    expect(card).toMatch(/<SessionFacts session=\{session\} subagents=\{NO_SUBAGENTS\} \/>/);
    expect(dialog).toMatch(
      /<SessionFacts\s+session=\{session\}\s+subagents=\{subagents\}\s+record\s*\/>/,
    );
    // The two record-only fields are behind the flag, and the children with them.
    expect(facts).toMatch(/record \? \(/);
    expect(facts).toMatch(/record && session\.distro !== null/);
    expect(facts).toMatch(/record && session\.parentId === null \? \(/);
  });

  it("names every subagent in the dialog, which scrolls", () => {
    // No cap: the dialog's list has a maximum height and scrolls, so a session with sixty children
    // costs it nothing.
    expect(facts).toContain("data-session-facts-children");
    expect(facts).toContain("data-session-facts-child={child.id}");
    expect(facts).toMatch(/subagents\.map\(\(child\) => \(/);
  });

  it("names the subagents from the list's own rows", () => {
    // A stored count could drift from the rows the manage view draws; a grouping of those rows
    // cannot.
    expect(panel).toMatch(/subagentsByParent\(sessions\)/);
    expect(panel).toMatch(/subagentsOf\(sessions, infoSession\)/);
  });
});
