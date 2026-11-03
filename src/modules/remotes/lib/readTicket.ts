/**
 * Tickets for reads that can answer after the panel has moved on.
 *
 * The remotes panels are one instance reused across repositories - `RemoteReposView` swaps the
 * `repo` prop of a single mounted dialog - and a read answers seconds later. A's #7, still in
 * flight, can land after the panel is showing B: B's list then draws A's rows, and because every
 * write takes the entry number off whatever detail is on screen, B's buttons would comment on,
 * close or delete A's entry. A confirmation dialog cannot undo a write aimed at the wrong
 * repository, so the read has to be refused before it is used.
 *
 * Two counters, because a read is replaced by one of two different things: the **scope** changes
 * when the panel moves to another repository or closes, and the **request** changes whenever the
 * same panel asks for the same kind of thing again. A ticket is only current while both still hold,
 * which is what lets a retry cancel the read it replaces without cancelling the other kind.
 *
 * The state is a plain object the caller keeps (a `useRef` in the components) so this stays a pure
 * module: no clock, no React, and nothing to reset between tests.
 */
export type ReadTickets = {
  /** The repository the panel is answering for. */
  scope: number;
  /** The newest list read. */
  list: number;
  /** The newest detail read. */
  detail: number;
};

/** One read's claim on being the answer the panel is waiting for. */
export type ReadTicket = { readonly scope: number; readonly request: number };

export function newReadTickets(): ReadTickets {
  return { scope: 0, list: 0, detail: 0 };
}

/**
 * The panel moved to another repository, or closed.
 *
 * Returns the new scope so the caller's own effect can pass it on; every ticket handed out before
 * this call is stale from here.
 */
export function beginScope(tickets: ReadTickets): number {
  tickets.scope += 1;
  return tickets.scope;
}

/** Take a ticket for one read of `kind`, replacing that kind's previous read. */
export function takeTicket(
  tickets: ReadTickets,
  kind: "list" | "detail",
): ReadTicket {
  tickets[kind] += 1;
  return { scope: tickets.scope, request: tickets[kind] };
}

/** Whether the read holding this ticket is still the one the panel is waiting for. */
export function isCurrentTicket(
  tickets: ReadTickets,
  kind: "list" | "detail",
  ticket: ReadTicket,
): boolean {
  return ticket.scope === tickets.scope && ticket.request === tickets[kind];
}
