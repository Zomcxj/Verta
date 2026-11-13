import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Reading one session, from the manage view.
 *
 * The manage view is the only place a subagent row is drawn, and such a row carries an id, a title and
 * a badge - which is not enough to answer "what is this and what do I lose by deleting it". The dialog
 * is that answer, and what has to hold is where it is opened from and what it is allowed to claim.
 *
 * Read as text, the way the other wiring tests here do: this repository renders no components.
 */
const dialog = readFileSync(
  new URL("./SessionInfoDialog.tsx", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("./LauncherPanel.tsx", import.meta.url),
  "utf8",
);
const list = readFileSync(new URL("./SessionList.tsx", import.meta.url), "utf8");

describe("the session info dialog", () => {
  it("is opened for exactly one row while managing", () => {
    // One row is one session; the button is meaningless for none or for many, so it is disabled
    // rather than opening something that has to pick.
    expect(panel).toMatch(/disabled=\{selected\.size !== 1\}/);
    expect(panel).toMatch(/setInfoKey\(key \?\? null\)/);
  });

  it("is reachable without entering the manage view", () => {
    // The same details are useful on a plain row - a subagent is just one more session there.
    expect(list).toMatch(/actions\.onInfo\(session\)/);
    expect(list).toContain('t("launcher.info")');
  });

  it("names the session by its id, its tool and its usage", () => {
    expect(dialog).toContain("data-session-info-id");
    expect(dialog).toContain("data-session-info-tool");
    expect(dialog).toContain("data-session-info-stats");
    // The directory is shown without a marker of its own: `break-all` is what tells the long path
    // apart from the labels beside it.
    expect(dialog).toMatch(/launcher\.infoDir[\s\S]{0,400}break-all/);
    // A subagent says what it belongs to; a parent says what it started.
    expect(dialog).toContain("data-session-info-parent");
    expect(dialog).toContain("data-session-info-children");
  });

  it("counts its subagents from the list's own rows", () => {
    // A stored count could drift from the rows the manage view draws - and the number next to
    // "delete" is exactly where that drift would matter.
    expect(panel).toMatch(/subagentsOf\(sessions, infoSession\)/);
    expect(dialog).toMatch(/subagents\.length === 0/);
    expect(dialog).toMatch(/count: subagents\.length/);
    expect(dialog).toMatch(/data-session-info-child=\{child\.id\}/);
  });

  it("keeps tracking the session across a refresh, by key rather than by row", () => {
    // The list re-reads while the dialog is up (the watcher fires); a row object would be replaced
    // under it, and a dialog keyed by the old object would close itself.
    expect(panel).toMatch(/const \[infoKey, setInfoKey\] = useState<string \| null>\(null\)/);
    expect(panel).toMatch(/sessions\.find\(\(session\) => sessionKey\(session\) === infoKey\)/);
  });
});
