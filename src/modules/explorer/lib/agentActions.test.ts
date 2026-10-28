import { describe, expect, it } from "vitest";
import { translate } from "@/modules/i18n/messages";
import { AGENT_TOOLS } from "@/modules/launcher/lib/tools";
import { agentOpenActions } from "./agentActions";

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