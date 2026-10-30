import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Where the "something new" dot is drawn, and what makes it go away.
 *
 * The rule itself is tested in `activity.test.ts` as pure functions; what is checked here is the
 * wiring that the person actually sees, because both halves of it have failed quietly elsewhere in
 * this file: a dot that shares the row's flexible width and gets squeezed to nothing next to a long
 * repository name, and a "read" that fires when the list opens rather than when an item is opened -
 * which would silently mark everything in the list as read.
 */
const view = readFileSync(
  new URL("../RemoteReposView.tsx", import.meta.url),
  "utf8",
);
const dialog = readFileSync(
  new URL("../IssuesDialog.tsx", import.meta.url),
  "utf8",
);
const messages = readFileSync(
  new URL("../../i18n/messages.ts", import.meta.url),
  "utf8",
);

describe("the dot on a repository row", () => {
  it("draws in the name cell, and cannot be squeezed to nothing", () => {
    expect(view).toContain('data-repo-activity="new"');
    // `truncate` on the name lets it shrink; the dot next to it must not.
    const dot = view.slice(view.indexOf('data-repo-activity="new"'));
    expect(dot.slice(0, 400)).toContain("shrink-0");
    // And it has to sit in the first cell, beside the name rather than in a column of its own.
    const nameCell = view.indexOf("{row.fullName}");
    expect(nameCell).toBeGreaterThan(-1);
    expect(view.indexOf('data-repo-activity="new"')).toBeGreaterThan(nameCell);
  });

  it("is decided by comparing against the mark, not by the read alone", () => {
    expect(view).toContain("isNewer(");
  });

  it("asks when the row is touched, not before", () => {
    // The existing hover callback is the only trigger; that is what keeps startup quiet.
    const hover = view.slice(view.indexOf("const onHover = useCallback"));
    const body = hover.slice(0, hover.indexOf("}, ["));
    expect(body).toContain("onCheckCi");
    expect(body).toContain("onCheckActivity");
    expect(view).not.toContain("useEffect(() => {\n    void checkActivity");
  });
});

describe("what counts as having seen it", () => {
  it("advances when a detail opens, inside openDetail and nowhere else", () => {
    const start = dialog.indexOf("const openDetail");
    expect(start).toBeGreaterThan(-1);
    const end = dialog.indexOf("}, [repo", start);
    expect(end).toBeGreaterThan(start);
    const body = dialog.slice(start, end);
    expect(body).toContain("onDetailOpened");

    // Opening the list is not reading it: the list read must not advance anything.
    const listRead = dialog.slice(
      dialog.indexOf("const load = useCallback"),
      dialog.indexOf("const openDetail"),
    );
    expect(listRead).not.toContain("onDetailOpened");
  });
});

describe("the dot explains itself", () => {
  it("has its own words in both languages", () => {
    const matches = messages.match(/"remotes\.activity\.new":/g) ?? [];
    expect(matches.length).toBe(2);
  });
});