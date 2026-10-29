import type { MessageKey } from "@/modules/i18n/messages";
import type { AgentTool } from "@/modules/launcher/lib/types";
import { AGENT_TOOLS } from "@/modules/launcher/lib/tools";
import { basename } from "@/modules/projects/lib/paths";
import { envForPath, type WorkspaceEnv } from "@/modules/workspace";

/**
 * One agent, as an entry in a folder's menu.
 *
 * A folder can be handed to an agent, and the agents are a list - so an entry per agent is built
 * from that list rather than written out, and a third one appears in every such menu by being
 * added there. This is the same shape the local project row uses; the wording is the same key
 * too, because it is the same offer ("open with {tool}") and two keys that have to be kept
 * saying the same thing are two chances to drift.
 */
export type AgentOpenAction = {
  tool: AgentTool;
  label: string;
  onSelect: () => void;
};

/**
 * The agents a folder can be opened with.
 *
 * `open` is what to do when one is picked, and it is the whole reason the entries exist: a
 * surface that cannot start a session gets no entries rather than entries that do nothing, so
 * the caller never has to remember to check before drawing them.
 */
export function agentOpenActions(
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  open: ((tool: AgentTool) => void) | undefined,
): AgentOpenAction[] {
  if (!open) return [];
  return AGENT_TOOLS.map((tool) => ({
    tool,
    label: t("projects.action.openWith", { tool }),
    onSelect: () => open(tool),
  }));
}

/** Where a session started on a folder runs, and what it is called. */
export type FolderSessionTarget = {
  cwd: string;
  title: string;
  workspace: WorkspaceEnv;
};

/**
 * The session a folder turns into: the folder itself as its directory, its own name as the title,
 * and the env to start it in.
 *
 * The folder decides the env rather than the window, because the two can disagree for an instant
 * while a workspace switch lands, and starting an agent on the wrong side of the boundary gives it
 * a directory it cannot see. A path that cannot say which it is keeps the window's answer - or the
 * distro the window last used, when the window's own answer is local - which is what that helper
 * does, and what keeps a stateless Linux path off the local filesystem.
 */
export function folderSessionTarget(
  path: string,
  previous: WorkspaceEnv,
): FolderSessionTarget {
  return {
    cwd: path,
    title: basename(path),
    workspace: envForPath(path, previous),
  };
}