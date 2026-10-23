import type { Tab } from "@/modules/tabs/lib/useTabs";
import { hasLeaf } from "@/modules/terminal/lib/panes";

export type ControlContext = {
  window_id: "main";
  /**
   * Used to mean "which workspace". Workspaces are gone, but this protocol has external
   * consumers (`verta-cli identify` prints it and scripts may branch on it), so it keeps
   * a fixed value rather than being removed from the protocol.
   */
  space_id: string;
  tab_id: number | null;
  pane_id: number | null;
  source: "caller" | "active";
};

const DEFAULT_SPACE_ID = "default";

export function resolveControlContext(
  tabs: Tab[],
  activeTabId: number,
  callerPaneId?: number,
): ControlContext {
  if (callerPaneId != null) {
    const callerTab = tabs.find(
      (tab) => tab.kind === "terminal" && hasLeaf(tab.paneTree, callerPaneId),
    );
    if (callerTab?.kind === "terminal") {
      return {
        window_id: "main",
        space_id: DEFAULT_SPACE_ID,
        tab_id: callerTab.id,
        pane_id: callerPaneId,
        source: "caller",
      };
    }
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  return {
    window_id: "main",
    space_id: DEFAULT_SPACE_ID,
    tab_id: activeTab?.id ?? null,
    pane_id: activeTab?.kind === "terminal" ? activeTab.activeLeafId : null,
    source: "active",
  };
}
