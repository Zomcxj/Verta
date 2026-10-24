import { describe, expect, it, vi } from "vitest";
import type { WorkspaceEnv } from "@/modules/workspace";
import { hydrateTabs, type SerializedTab } from "./serialize";

// The repair only applies on Windows, where a local path without a drive is not usable.
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));

const LOCAL: WorkspaceEnv = { kind: "local" };
const WSL: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu-22.04" };

/** Ids only need to be unique for these tests. */
const counter = () => {
  let next = 100;
  return () => (next += 1);
};

const terminal = (
  cwd: string | undefined,
  workspace?: WorkspaceEnv,
): SerializedTab => ({
  kind: "terminal",
  tree: { kind: "leaf", active: true, ...(cwd && { cwd }), ...(workspace && { workspace }) },
});

function firstLeaf(tabs: ReturnType<typeof hydrateTabs>) {
  const tab = tabs[0];
  if (tab?.kind !== "terminal") throw new Error("expected a terminal tab");
  return { tab, leaf: tab.paneTree };
}

describe("hydrateTabs", () => {
  it("keeps a drive path for a local terminal", () => {
    const { tab, leaf } = firstLeaf(
      hydrateTabs([terminal("F:/VibeCoding_workspace/Verta")], counter(), "preview", LOCAL),
    );
    expect(leaf.kind === "leaf" && leaf.cwd).toBe("F:/VibeCoding_workspace/Verta");
    expect(tab.cwd).toBe("F:/VibeCoding_workspace/Verta");
    expect(tab.title).toBe("Verta");
  });

  it("keeps a UNC share", () => {
    const { leaf } = firstLeaf(
      hydrateTabs([terminal("\\\\server\\share\\repo")], counter(), "preview", LOCAL),
    );
    expect(leaf.kind === "leaf" && leaf.cwd).toBe("\\\\server\\share\\repo");
  });

  // The failure this guards: a Windows path that lost its drive letter. Windows resolves
  // it against the app's own drive, which is why a restored tab opened somewhere else
  // entirely (or failed with "cwd not accessible: ... os error 3") depending on where the
  // app was launched from. The directory is dropped instead, and the directory the shell
  // really starts in arrives over OSC 7 as usual.
  it("drops a local path that lost its drive letter", () => {
    const { tab, leaf } = firstLeaf(
      hydrateTabs(
        [terminal("/VibeCoding_workspace/Verta", LOCAL)],
        counter(),
        "preview",
        LOCAL,
      ),
    );
    expect(leaf.kind === "leaf" && leaf.cwd).toBeUndefined();
    expect(tab.cwd).toBeUndefined();
    // The label still says which terminal this was until the shell reports its own cwd.
    expect(tab.title).toBe("Verta");
  });

  it("keeps a Linux path for a distro terminal", () => {
    const { leaf } = firstLeaf(
      hydrateTabs([terminal("/home/me/proj", WSL)], counter(), "preview", WSL),
    );
    expect(leaf.kind === "leaf" && leaf.cwd).toBe("/home/me/proj");
  });
});
