import type { Ownership } from "@/lib/ownership";
import type { WorkspaceEnv } from "@/modules/workspace";

/** One project in the list. */
export type ProjectEntry = {
  path: string;
  /** Which env the project is in: it decides where status is queried and which env the
   * workspace gets when opened. */
  workspace: WorkspaceEnv;
  /**
   * Whether this project is in the user's list. false means it was discovered from
   * distro sessions (only visible with WSL on); the UI offers no "remove" there so the
   * user does not think deleting it would delete something.
   */
  managed: boolean;
};

/** The `kind` reported by the backend; see the same-named Rust type for the meanings. */
export type ProjectStatusKind = "repo" | "notRepo" | "missing" | "error";

export type ProjectStatus = {
  path: string;
  name: string;
  workspace: WorkspaceEnv;
  kind: ProjectStatusKind;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  dirty: number;
  stashed: number;
  error: string | null;
  /** Why the fetch this check was asked for failed; null when it worked or was not asked
   * for. `ahead`/`behind` stay readable either way, but they may be out of date. */
  fetchError: string | null;
};

/** How a row looks in the UI: the list entry plus the status from this check (which may
 * be absent or still running). */
export type ProjectRow = ProjectEntry & {
  status: ProjectStatus | null;
  checking: boolean;
  /** Whether this project looks like one of the signed-in account's own repositories. */
  ownership: Ownership;
};