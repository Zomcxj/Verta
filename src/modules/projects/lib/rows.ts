import type { AgentSession } from "@/modules/launcher";
import { samePath } from "./paths";
import type { ProjectRow, ProjectStatus } from "./types";

/** 界面上给一行定的色调，文案在 i18n 里。 */
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
  /** i18n 键；带参数时用 `params` 插值。 */
  key: string;
  params?: Record<string, number | string>;
};

/**
 * 一行状态的判定。优先级按「用户最需要先看到什么」排：读不出来的错误最靠前，
 * 其次是改动，再是领先/落后。
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

/** 排序用的稳定键：把「状态」折算成一个可比较的严重度，缺状态排最后。 */
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
  | "branch"
  | "state"
  | "dirty"
  | "upstream"
  | "stashed"
  | "checked";

export type SortState = { key: SortKey; ascending: boolean } | null;

/**
 * 列头点击的三态循环：第一次升序、第二次降序、第三次取消排序（回到清单原顺序）。
 * 点另一列则从该列的升序重新开始。
 */
export function cycleSort(current: SortState, key: SortKey): SortState {
  if (current?.key !== key) return { key, ascending: true };
  if (current.ascending) return { key, ascending: false };
  return null;
}

export function sortRows(rows: ProjectRow[], sort: SortState): ProjectRow[] {
  if (!sort) return rows;
  const direction = sort.ascending ? 1 : -1;
  const value = (row: ProjectRow): string | number => {
    switch (sort.key) {
      case "name":
        return row.status?.name.toLowerCase() ?? "";
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
  // 复制一份再排：调用方拿到的数组顺序不该被就地改动。
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === right) return 0;
    return (left < right ? -1 : 1) * direction;
  });
}

/** 按路径关键字筛选（含完整路径，便于按盘符或父目录过滤）。 */
export function filterRows(rows: ProjectRow[], keyword: string): ProjectRow[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => row.path.toLowerCase().includes(needle));
}

/**
 * 这个会话属于这个项目吗。按 spec §12.2 的规则：会话 cwd 与项目 root **精确相等**
 * （不匹配子目录），并且两侧的环境要一致，免得本机与发行版里同名路径串在一起。
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

/** 该项目下的会话，最近的在前。 */
export function sessionsForProject(
  sessions: AgentSession[],
  row: Pick<ProjectRow, "path" | "workspace">,
): AgentSession[] {
  return sessions
    .filter((session) => sessionBelongsToProject(session, row))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}