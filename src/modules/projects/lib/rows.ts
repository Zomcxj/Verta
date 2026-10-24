import {
  cycleSort as cycleSortShared,
  type SortState as SharedSortState,
} from "@/components/ui/sort-header";
import {
  type Account,
  type Ownership,
  ownershipOfFolder,
  ownershipRank,
} from "@/lib/ownership";
import type { AgentSession } from "@/modules/launcher";
import { samePath } from "./paths";
import type { ProjectRow, ProjectStatus } from "./types";

/** Tone assigned to a row in the UI; the copy lives in i18n. */
export type StateTone =
  | "clean"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged"
  | "warn"
  | "error"
  | "unknown";

export type RowState = {
  tone: StateTone;
  /** i18n key; `params` are interpolated when present. */
  key: string;
  params?: Record<string, number | string>;
};

/**
 * Row state resolution. Priority follows what the user most needs to see first: a
 * read failure comes first, then uncommitted changes, then ahead/behind.
 */
export function stateOf(status: ProjectStatus | null): RowState {
  if (!status) return { tone: "unknown", key: "projects.state.unchecked" };
  switch (status.kind) {
    case "missing":
      return { tone: "warn", key: "projects.state.missing" };
    case "notRepo":
      return { tone: "warn", key: "projects.state.notRepo" };
    case "error":
      return { tone: "error", key: "projects.state.failed" };
    default:
      break;
  }
  if (status.ahead > 0 && status.behind > 0) {
    return {
      tone: "diverged",
      key: "projects.state.diverged",
      params: { ahead: status.ahead, behind: status.behind },
    };
  }
  if (status.ahead > 0) {
    return {
      tone: "ahead",
      key: "projects.state.ahead",
      params: { count: status.ahead },
    };
  }
  if (status.behind > 0) {
    return {
      tone: "behind",
      key: "projects.state.behind",
      params: { count: status.behind },
    };
  }
  if (status.dirty > 0) {
    return {
      tone: "dirty",
      key: "projects.state.dirty",
      params: { count: status.dirty },
    };
  }
  return { tone: "clean", key: "projects.state.clean" };
}

/** Stable sort key: fold the state into a comparable severity, with no status last. */
const SEVERITY: Record<StateTone, number> = {
  error: 0,
  warn: 1,
  diverged: 2,
  behind: 3,
  ahead: 4,
  dirty: 5,
  clean: 6,
  unknown: 7,
};

export type SortKey =
  | "name"
  | "owner"
  | "branch"
  | "state"
  | "dirty"
  | "upstream"
  | "stashed"
  | "checked";

/** The shared shape, narrowed to the columns of this table. */
export type SortState = SharedSortState<SortKey>;

export const cycleSort = cycleSortShared;

export function sortRows(rows: ProjectRow[], sort: SortState): ProjectRow[] {
  if (!sort) return rows;
  const direction = sort.ascending ? 1 : -1;
  const value = (row: ProjectRow): string | number => {
    switch (sort.key) {
      case "name":
        return row.status?.name.toLowerCase() ?? "";
      case "owner":
        return ownershipRank(row.ownership);
      case "branch":
        return row.status?.branch?.toLowerCase() ?? "";
      case "state":
        return SEVERITY[stateOf(row.status).tone];
      case "dirty":
        return row.status?.dirty ?? -1;
      case "upstream":
        return row.status?.upstream?.toLowerCase() ?? "";
      case "stashed":
        return row.status?.stashed ?? -1;
      case "checked":
        return 0;
      default:
        return 0;
    }
  };
  // Sort a copy, so the caller's array is never reordered in place.
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === right) return 0;
    return (left < right ? -1 : 1) * direction;
  });
}

/**
 * The project's ownership, from the account read elsewhere.
 *
 * The name compared against the account is the folder name the backend already reports,
 * and only a repository has one worth comparing: a folder that is not a repository, or
 * one whose status has not come back yet, gets no owner rather than a guess.
 */
export function ownershipOfRow(
  status: ProjectStatus | null,
  account: Account,
): Ownership {
  if (status?.kind !== "repo") return "unknown";
  return ownershipOfFolder(status.name, account);
}

/** Filter by a path keyword (the full path, so a drive or parent directory works as
 * a filter). */
export function filterRows(rows: ProjectRow[], keyword: string): ProjectRow[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.path.toLowerCase().includes(needle));
}

/**
 * Whether this session belongs to this project. Per spec §12.2 the session cwd and
 * the project root must be **exactly equal** (subdirectories do not match), and the
 * envs must agree, so same-named local and distro paths never get mixed up.
 */
export function sessionBelongsToProject(
  session: AgentSession,
  row: Pick<ProjectRow, "path" | "workspace">,
): boolean {
  if (!samePath(session.cwd, row.path)) return false;
  const sessionDistro = session.distro;
  if (row.workspace.kind === "wsl") return sessionDistro === row.workspace.distro;
  return sessionDistro === null;
}

/** Sessions under this project, most recent first. */
export function sessionsForProject(
  sessions: AgentSession[],
  row: Pick<ProjectRow, "path" | "workspace">,
): AgentSession[] {
  return sessions
    .filter((session) => sessionBelongsToProject(session, row))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}