import { describe, expect, it } from "vitest";
import {
  type AgentComponent,
  batchFailureNotice,
  batchIds,
  hasUpdate,
  type UpdateReason,
  upgradable,
  updateReason,
  updateRows,
  upgradedNotice,
} from "./useAgentVersions";

/** One row, with only what a case cares about spelled out. */
function row(fields: Partial<AgentComponent> & { id: string }): AgentComponent {
  return {
    agent: "pi",
    name: fields.id,
    current: null,
    latest: null,
    error: null,
    compare: "version",
    ...fields,
  };
}

describe("hasUpdate", () => {
  it("offers an update when the published version is newer", () => {
    // The pair measured on this machine: pi-lens installed 4.4.7, published 4.4.8.
    expect(hasUpdate("4.4.7", "4.4.8")).toBe(true);
    expect(hasUpdate("1.4.0", "1.5.0")).toBe(true);
    expect(hasUpdate("1.4.0", "2.0.0")).toBe(true);
  });

  it("offers nothing when they are equal", () => {
    expect(hasUpdate("2.2.5", "2.2.5")).toBe(false);
    expect(hasUpdate("1.4.0", "1.4.0")).toBe(false);
  });

  it("offers nothing when the installed one is ahead", () => {
    // A prerelease or a local build can be ahead of the registry; that is not an update.
    expect(hasUpdate("2.3.0", "2.2.5")).toBe(false);
    expect(hasUpdate("4.4.8", "4.4.7")).toBe(false);
  });

  it("compares component by component, not as text", () => {
    // "4.4.10" is newer than "4.4.9", which a string compare gets backwards.
    expect(hasUpdate("4.4.9", "4.4.10")).toBe(true);
    expect(hasUpdate("4.4.10", "4.4.9")).toBe(false);
  });

  it("offers nothing when either side is unknown", () => {
    // A registry that could not be asked must not produce an upgrade button.
    expect(hasUpdate(null, "2.2.5")).toBe(false);
    expect(hasUpdate("2.2.5", null)).toBe(false);
    expect(hasUpdate(null, null)).toBe(false);
  });

  it("offers nothing when a version cannot be parsed", () => {
    expect(hasUpdate("not-a-version", "2.2.5")).toBe(false);
    expect(hasUpdate("2.2.5", "latest")).toBe(false);
  });

  it("compares a revision by difference, because commits have no order", () => {
    // A git checkout's row carries two commits. They are either the same commit or the checkout is
    // behind, and which of the two hashes happens to sort lower says nothing about that.
    expect(hasUpdate("2ce8aa1", "22f0b46", "revision")).toBe(true);
    expect(hasUpdate("22f0b46", "2ce8aa1", "revision")).toBe(true);
    expect(hasUpdate("22f0b46", "22f0b46", "revision")).toBe(false);
    // A commit is not a number either, so the version parse must not be reached.
    expect(hasUpdate("not-a-version", "22f0b46", "revision")).toBe(true);
    // Unknown on either side is still nothing to offer.
    expect(hasUpdate(null, "22f0b46", "revision")).toBe(false);
  });
});

describe("upgradable", () => {
  it("keeps only the rows with something newer", () => {
    const rows: AgentComponent[] = [
      row({ id: "opencode", agent: "opencode", current: "2.2.5", latest: "2.2.5" }),
      row({ id: "pi", current: "1.4.0", latest: "1.5.0" }),
      row({ id: "x", name: "pi-lens", current: "4.4.7", latest: "4.4.8" }),
    ];
    expect(upgradable(rows).map((r) => r.id)).toEqual(["pi", "x"]);
  });

  it("is empty when everything is current", () => {
    const rows: AgentComponent[] = [
      row({ id: "opencode", agent: "opencode", current: "2.2.5", latest: "2.2.5" }),
    ];
    expect(upgradable(rows)).toEqual([]);
  });

  it("counts a checkout that is on an older commit", () => {
    // Measured on this machine: pi's own checkout of superpowers is on 2ce8aa15 while the remote is
    // on 22f0b463, and that belongs in the badge exactly as a released version does.
    const rows: AgentComponent[] = [
      row({
        id: "pi-git:github.com/obra/superpowers",
        name: "obra/superpowers",
        current: "2ce8aa1",
        latest: "22f0b46",
        compare: "revision",
      }),
    ];
    expect(upgradable(rows).map((r) => r.id)).toEqual([
      "pi-git:github.com/obra/superpowers",
    ]);
  });
});

describe("updateRows", () => {
  it("keeps a row whose check could not answer", () => {
    // Reported 2026-11-02: an upgrade failed with a network error, the popover was reopened, the
    // re-check could not reach the registry, and the row vanished into "everything is up to date"
    // - taking its button with it, so the failed update had nothing left to retry. A row nobody
    // could check is not a row that is current.
    const rows: AgentComponent[] = [
      row({
        id: "pi-extension:obra/superpowers",
        name: "obra/superpowers",
        current: "1.0.0",
        error: "查询 obra/superpowers 失败：connect timeout",
      }),
      row({ id: "pi", current: "1.4.0", latest: "1.4.0" }),
    ];
    expect(updateRows(rows).map((r) => r.id)).toEqual([
      "pi-extension:obra/superpowers",
    ]);
  });

  it("still lists the rows that have a newer version", () => {
    const rows: AgentComponent[] = [
      row({ id: "pi", current: "1.4.0", latest: "1.5.0" }),
      row({ id: "opencode", agent: "opencode", current: "2.2.5", latest: "2.2.5" }),
      // The same library opencode installed, which pi may also have: one name, two rows, told
      // apart by the row's own agent.
      row({
        id: "opencode-plugin:superpowers",
        name: "superpowers",
        agent: "opencode",
        current: "7.0.1",
        latest: "7.0.2",
      }),
    ];
    expect(updateRows(rows).map((r) => r.id)).toEqual([
      "pi",
      "opencode-plugin:superpowers",
    ]);
  });

  it("is empty only when every row was checked and is current", () => {
    expect(updateRows([row({ id: "pi", current: "1.4.0", latest: "1.4.0" })])).toEqual(
      [],
    );
  });
});

describe("upgradedNotice", () => {
  it("reports the version the component landed on", () => {
    // The case that prompted this: pi-lens 4.4.7 -> 4.4.8, after which the row leaves the
    // list. The confirmation is what tells the user it worked.
    const after: AgentComponent[] = [
      row({
        id: "pi-extension:pi-lens",
        name: "pi-lens",
        current: "4.4.8",
        latest: "4.4.8",
      }),
    ];
    expect(upgradedNotice("pi-lens", after, "pi-extension:pi-lens")).toEqual({
      name: "pi-lens",
      version: "4.4.8",
    });
  });

  it("reports no version when the row is gone entirely", () => {
    // An extension pi dropped during the upgrade: nothing to quote, so the caller says "updated".
    expect(upgradedNotice("pi-lens", [], "pi-extension:pi-lens")).toEqual({
      name: "pi-lens",
      version: null,
    });
  });

  it("does not confuse the component with another row", () => {
    const after: AgentComponent[] = [
      row({ id: "opencode", agent: "opencode", current: "2.2.5", latest: "2.2.5" }),
      row({ id: "pi", current: "1.4.0", latest: "1.4.0" }),
    ];
    expect(upgradedNotice("pi-lens", after, "pi-extension:pi-lens")).toEqual({
      name: "pi-lens",
      version: null,
    });
  });
});

describe("batchIds", () => {
  it("is every row the list is showing, the unreadable ones included", () => {
    // "缺少一键更新按钮": the button used to appear only when more than one row was *known* to be
    // behind, so one behind row plus one row whose check was refused left nothing to click - even
    // though both rows had their own button on screen.
    const rows: AgentComponent[] = [
      row({
        id: "pi-git:obra/superpowers",
        current: "1.0.0",
        latest: "1.1.0",
        compare: "revision",
      }),
      row({
        id: "opencode-plugin:superpowers",
        agent: "opencode",
        current: "6.3.0",
        latest: null,
        error: "查询 obra/superpowers 失败：HTTP 403 Forbidden",
      }),
      row({ id: "opencode", agent: "opencode", current: "2.2.5", latest: "2.2.5" }),
    ];
    expect(batchIds(rows)).toEqual([
      "pi-git:obra/superpowers",
      "opencode-plugin:superpowers",
    ]);
  });

  it("is empty when every row was read and is current", () => {
    const rows: AgentComponent[] = [
      row({ id: "pi", current: "1.4.0", latest: "1.4.0" }),
    ];
    expect(batchIds(rows)).toEqual([]);
  });
});

describe("updateReason", () => {
  const kindOf = (error: string | null): UpdateReason | null => updateReason(error);

  it("reads the two statuses that mean the quota ran out", () => {
    // The row that prompted this: "浮窗查询失败 HTTP 403 Forbidden 更新失败".
    expect(
      kindOf("查询 obra/superpowers 失败：HTTP 403 Forbidden（多为匿名读取的配额用完）"),
    ).toEqual({ kind: "rateLimited", code: 403 });
    expect(kindOf("查询 x 失败：HTTP 429")).toEqual({ kind: "rateLimited", code: 429 });
  });

  it("reads any other refusal as the status it is", () => {
    expect(kindOf("查询 x 失败：HTTP 500")).toEqual({ kind: "http", code: 500 });
  });

  it("says nothing about a failure with no status in it", () => {
    // A transport failure: the host never answered, so there is no status to report.
    expect(kindOf("查询 x 失败：error sending request")).toEqual({
      kind: "other",
      code: null,
    });
    expect(kindOf(null)).toBeNull();
  });
});

describe("batchFailureNotice", () => {
  it("names every failed component and quotes the first detail", () => {
    // A batch runs several rows; the notice is one line, so every name appears - a user has to know
    // which rows are still behind - and only the first detail is quoted.
    expect(
      batchFailureNotice([
        { name: "superpowers", message: "npm error code 128" },
        { name: "@dietrichgebert/ponytail", message: "" },
      ]),
    ).toEqual({
      names: "superpowers, @dietrichgebert/ponytail",
      detail: "npm error code 128",
    });
  });

  it("keeps the detail to one line", () => {
    // npm's failure is a dozen lines; pasted whole it would push the popover off the window.
    const said = batchFailureNotice([
      {
        name: "superpowers",
        message: ["npm error code 128", "npm error  An unknown git error", ""].join(
          String.fromCharCode(10),
        ),
      },
    ]);
    expect(said?.detail).toBe("npm error code 128 npm error An unknown git error");
  });

  it("says nothing when nothing failed", () => {
    expect(batchFailureNotice([])).toBeNull();
  });
});
