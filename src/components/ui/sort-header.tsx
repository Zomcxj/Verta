import { cn } from "@/lib/utils";

/**
 * Sort state of one table. `null` means the table is showing its own order, which is what
 * a third click on the same column goes back to.
 */
export type SortState<K extends string = string> =
  | { key: K; ascending: boolean }
  | null;

/**
 * Three-state cycle on a column header: first click ascending, second descending, third
 * clears the sort. Clicking another column restarts from ascending for that column.
 */
export function cycleSort<K extends string>(
  current: SortState<K>,
  key: K,
): SortState<K> {
  if (current?.key !== key) return { key, ascending: true };
  if (current.ascending) return { key, ascending: false };
  return null;
}

/**
 * A sortable column header. The arrow is drawn from the state rather than kept locally, so
 * only the column that is really sorting shows one.
 *
 * The base padding suits the project table; a caller whose cells have no left padding
 * overrides `px` through `className`.
 */
export function SortHeader<K extends string>({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: K;
  sort: SortState<K>;
  onSort: (next: SortState<K>) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  return (
    <th className={cn("px-2 py-1 font-medium", className)}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          active && "text-foreground",
        )}
        onClick={() => onSort(cycleSort(sort, column))}
      >
        {label}
        {active ? <span>{sort?.ascending ? "▲" : "▼"}</span> : null}
      </button>
    </th>
  );
}
