export {
  countAgentPhases,
  subscribeAgentSignals,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  findLeaf,
  findLeafCwd,
  hasLeaf,
  leafIds,
  type PaneBounds,
  type PaneNode,
} from "./lib/panes";
export {
  clearFocusedTerminal,
  disposeSession,
  leafCommandRunning,
  leafHasForegroundProcess,
  leafIdForPty,
  leafFrameCount,
  leafOutputBytes,
  leafScreenTail,
  leafUsesAlternateScreen,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  whenLeafPaints,
  whenSessionReady,
  writeToSession,
} from "./lib/terminalSessionApi";
export { AgentStateDot, AgentStateMarquee } from "./AgentStateDot";
export { isTerminalSurfaceTarget } from "./lib/terminalSurfaceTarget";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export type { TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";
