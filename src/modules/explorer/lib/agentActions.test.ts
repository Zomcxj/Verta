import { describe, expect, it } from "vitest";
import { translate } from "@/modules/i18n/messages";
import { AGENT_TOOLS } from "@/modules/launcher/lib/tools";
import { LOCAL_WORKSPACE, type WorkspaceEnv } from "@/modules/workspace";
import { agentOpenActions, folderSessionTarget } from "./agentActions";

/** The Chinese catalogue, which is the one the keys are named in. */
const zh = (
  key: Parameters<typeof translate>[1],
  values?: Record<string, string | number>,
) => translate("zh", key, values);

describe("agentOpenActions", () => {
  it("gives one entry per agent tool, labelled with the tool", () => {
    const opened: string[] = [];
    const actions = agentOpenActions(zh, (tool) => opened.push(tool));
    // Built from the list rather than written out, so a third tool cannot be missing here.
    expect(actions.map((action) => action.tool)).toEqual(AGENT_TOOLS);
    expect(actions.map((action) => action.label)).toEqual(
      AGENT_TOOLS.map((tool) => `用 ${tool} 打开`),
    );
    actions[0].onSelect();
    expect(opened).toEqual([AGENT_TOOLS[0]]);
  });

  it("gives nothing at all when nobody is listening", () => {
    // A surface with no way to start a session draws no entries: not entries that do nothing.
    expect(agentOpenActions(zh, undefined)).toEqual([]);
  });
});

describe("folderSessionTarget", () => {
  it("makes the folder itself the session's directory, and names it after the folder", () => {
    expect(folderSessionTarget("F:/work/demo", LOCAL_WORKSPACE)).toEqual({
      cwd: "F:/work/demo",
      title: "demo",
      workspace: LOCAL_WORKSPACE,
    });
  });

  it("reads the env off the folder's own path, wsl included", () => {
    // A folder in WSL has to start its session in that distro, or the agent runs on the wrong side
    // of the boundary and cannot see the files it was pointed at.
    expect(
      folderSessionTarget("//wsl.localhost/Ubuntu/home/x/proj", LOCAL_WORKSPACE),
    ).toEqual({
      cwd: "//wsl.localhost/Ubuntu/home/x/proj",
      title: "proj",
      workspace: { kind: "wsl", distro: "Ubuntu" },
    });
  });

  it("keeps the window's own env for a path that cannot say which it is", () => {
    // A bare Linux path carries no distro name, and guessing one would send the session off to a
    // filesystem the folder is not on. The env the window is in is the answer instead.
    const wsl: WorkspaceEnv = { kind: "wsl", distro: "Debian" };
    expect(folderSessionTarget("/home/x/proj", wsl).workspace).toEqual(wsl);
  });
});