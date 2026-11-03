import { describe, expect, it } from "vitest";
import {
  beginScope,
  isCurrentTicket,
  newReadTickets,
  takeTicket,
} from "./readTicket";

describe("read tickets", () => {
  it("keeps a read that is still the newest of its kind", () => {
    const tickets = newReadTickets();
    const reading = takeTicket(tickets, "list");
    expect(isCurrentTicket(tickets, "list", reading)).toBe(true);
  });

  it("drops a read the same panel has asked again for", () => {
    // The case the list guard was written for: flipping the state filter quickly, where an earlier
    // slow answer must not overwrite the newer one.
    const tickets = newReadTickets();
    const first = takeTicket(tickets, "list");
    const second = takeTicket(tickets, "list");
    expect(isCurrentTicket(tickets, "list", first)).toBe(false);
    expect(isCurrentTicket(tickets, "list", second)).toBe(true);
  });

  it("drops every read taken before the panel moved to another repository", () => {
    // Reported: A's #7 still loading while the panel was moved to B. It landed on B's screen, and
    // B's close/comment buttons take their number from whatever detail is on screen.
    const tickets = newReadTickets();
    const aDetail = takeTicket(tickets, "detail");
    const aList = takeTicket(tickets, "list");
    beginScope(tickets);
    const bList = takeTicket(tickets, "list");

    expect(isCurrentTicket(tickets, "detail", aDetail)).toBe(false);
    expect(isCurrentTicket(tickets, "list", aList)).toBe(false);
    expect(isCurrentTicket(tickets, "list", bList)).toBe(true);
  });

  it("drops reads taken before the panel was closed", () => {
    const tickets = newReadTickets();
    const reading = takeTicket(tickets, "detail");
    beginScope(tickets);
    expect(isCurrentTicket(tickets, "detail", reading)).toBe(false);
  });

  it("lets one kind be re-asked without cancelling the other", () => {
    // A write refreshes both: the detail it just changed and the list it belongs to. Neither may
    // cancel the other, or the panel would end up showing the half that answered last.
    const tickets = newReadTickets();
    const detail = takeTicket(tickets, "detail");
    const list = takeTicket(tickets, "list");
    expect(isCurrentTicket(tickets, "detail", detail)).toBe(true);
    expect(isCurrentTicket(tickets, "list", list)).toBe(true);
  });

  it("drops a detail read the user has backed out of for another entry", () => {
    const tickets = newReadTickets();
    const first = takeTicket(tickets, "detail");
    const second = takeTicket(tickets, "detail");
    expect(isCurrentTicket(tickets, "detail", first)).toBe(false);
    expect(isCurrentTicket(tickets, "detail", second)).toBe(true);
  });

  it("counts scopes from the first switch, not from zero", () => {
    // A ticket taken before any switch has scope 0, which no ticket after a switch can equal.
    const tickets = newReadTickets();
    const fresh = takeTicket(tickets, "list");
    expect(fresh.scope).toBe(0);
    expect(beginScope(tickets)).toBe(1);
    expect(takeTicket(tickets, "list").scope).toBe(1);
  });
});
