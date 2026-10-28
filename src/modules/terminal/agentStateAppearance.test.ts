import { describe, expect, it } from "vitest";
import {
  DOT_CLASS,
  MARQUEE_SWEEP_CLASS,
  MARQUEE_TRACK_CLASS,
  STATE_COLOUR,
} from "./AgentStateDot";

/**
 * How a state is drawn, as data.
 *
 * The colour a state is drawn in is what the user reads from across the window, so it is pinned here
 * rather than measured on the screen first: a session list row and a tab chip have to agree about one
 * session, and that agreement is this table.
 */

const STATES = ["attention", "working", "idle", "finished"] as const;

describe("the state appearance", () => {
  it("puts one colour on a state, and only three colours exist", () => {
    expect(STATE_COLOUR.attention).toBe("sky-500");
    expect(STATE_COLOUR.working).toBe("orange-500");
    // A turn that ended and an agent sitting at its prompt are the same thing to the user now: the
    // question is only whether work is in flight, and a finished session says it stays.
    expect(STATE_COLOUR.finished).toBe("emerald-500");
    expect(STATE_COLOUR.idle).toBe("emerald-500");
    expect(new Set(Object.values(STATE_COLOUR)).size).toBe(3);
  });

  it("draws every state as an indicator that breathes", () => {
    for (const state of STATES) {
      expect(DOT_CLASS[state]).toContain(STATE_COLOUR[state]);
      // The marker the stylesheet stops when nobody can see the window, and the one it keeps
      // running when the window is only unfocused.
      expect(DOT_CLASS[state]).toContain("verta-state-indicator");
      expect(DOT_CLASS[state]).toContain("verta-state-breathe");
    }
  });

  it("gives every state a running light in the colour of its dot", () => {
    for (const state of STATES) {
      expect(MARQUEE_TRACK_CLASS[state]).toContain(STATE_COLOUR[state]);
      expect(MARQUEE_SWEEP_CLASS[state]).toContain(STATE_COLOUR[state]);
      // The bar is an indicator too: unseen stops it with everything else, and merely unfocused
      // keeps it moving.
      expect(MARQUEE_TRACK_CLASS[state]).toContain("verta-state-indicator");
      // And the sweep is the part that moves.
      expect(MARQUEE_SWEEP_CLASS[state]).toContain("verta-state-marquee");
    }
  });
});