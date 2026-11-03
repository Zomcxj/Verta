/**
 * Which projects may be pulled right now, given the ones already in flight.
 *
 * The pull is a git command per row and each one hits the network. The list can hold dozens of
 * projects and the check fetches all of them, so a pull that lands on top of a check, or five
 * pulls started by five clicks, compete for the same disks and the same remote. Measured on this
 * machine: 32 projects on the list, and the statuses the window showed arrived late enough that the
 * panel looked stale until it was refreshed by hand.
 *
 * So: two at a time, never during a check, and never the same project twice. The panel disables
 * what this refuses, so the button's state and the guard cannot drift apart.
 */
export type PullGate = {
  /** True while the status check is running; a pull waits for it. */
  readonly checking: boolean;
  /** Normalized paths already being pulled. */
  readonly pulling: ReadonlySet<string>;
};

/** How many projects may be pulled at once. */
export const MAX_CONCURRENT_PULLS = 2;

/** Whether `path` can be pulled right now. */
export function canStartPull(gate: PullGate, path: string): boolean {
  if (gate.checking) return false;
  if (gate.pulling.has(path)) return false;
  return gate.pulling.size < MAX_CONCURRENT_PULLS;
}

/** The gate after one pull has started. */
export function addPull(gate: PullGate, path: string): PullGate {
  const pulling = new Set(gate.pulling);
  pulling.add(path);
  return { ...gate, pulling };
}

/** The gate after one pull has ended, whether or not it worked. */
export function removePull(gate: PullGate, path: string): PullGate {
  if (!gate.pulling.has(path)) return gate;
  const pulling = new Set(gate.pulling);
  pulling.delete(path);
  return { ...gate, pulling };
}
