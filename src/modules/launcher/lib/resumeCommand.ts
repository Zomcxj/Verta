import { IS_WINDOWS } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import type { AgentTool } from "./types";

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

type ResumeTarget = {
  tool: AgentTool;
  id: string;
  cwd: string;
  /** Which distro the session belongs to; given one, we follow WSL rules (POSIX
   * quoting, the right binary). */
  distro?: string | null;
};

/**
 * `opencode` inside a distro is very likely the Windows exe (WSL interop). It
 * resolves the home directory from its own filesystem, so it reads and writes a
 * different store: measured with the same cwd, the one on PATH (`/mnt/d/...`) does
 * not see the distro's sessions while `~/.npm-global/bin/opencode` does. Hence the
 * install locations inside the distro filesystem go in front of PATH, falling back
 * to the distro's own PATH when none of them exists.
 */
const WSL_OPENCODE =
  'env PATH="$HOME/.opencode/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH" opencode';

/**
 * Command for starting a new session: launch the agent itself, with no `--session`.
 *
 * opencode inside a distro is often the Windows exe (interop), which resolves the
 * home directory from its own filesystem and therefore touches a different store,
 * so starting a session needs the same PATH prefix inside the distro as resuming.
 */
export function newSessionCommand(
  tool: AgentTool,
  distro?: string | null,
): string {
  if (tool === "opencode") return distro ? WSL_OPENCODE : "opencode";
  return "pi";
}

/**
 * The session id is concatenated straight into the command line, so it is
 * whitelist-validated first. Any disallowed character refuses the whole call rather
 * than being escaped and allowed through.
 */
export function resumeCommand(
  { tool, id, cwd, distro }: ResumeTarget,
  windows = IS_WINDOWS,
): string {
  if (!SESSION_ID.test(id)) {
    // The message is data for the caller's log, so it is composed here rather
    // than through the string table: this module has no language context.
    throw new Error(`refusing to build a resume command from id ${id}`);
  }
  if (tool === "opencode") {
    // opencode takes --session <id> plus a positional directory. The cwd has to come
    // along: run from another directory, --session misses the session and silently
    // creates a new one.
    const binary = distro ? WSL_OPENCODE : "opencode";
    // Inside a distro it is a Linux path, so quote it POSIX-style.
    const directory = quoteShellArg(cwd, distro ? false : windows);
    return `${binary} --session ${id} ${directory}`;
  }
  // pi looks sessions up by id within its own cwd, which the terminal's working
  // directory provides.
  return `pi --session ${id}`;
}
