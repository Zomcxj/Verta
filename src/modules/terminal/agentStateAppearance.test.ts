import { describe, expect, it } from "vitest";
import {
  DOT_CLASS,
  MARQUEE_SWEEP_CLASS,
  MARQUEE_TRACK_CLASS,
  STATE_COLOUR,
  agentStateLabelKey,
} from "./AgentStateDot";

/**
 * How a state is drawn, as data.
 *
 * The colour a state is drawn in is what the user reads from across the window, so it is pinned here
 * rather than measured on the screen first: a session list row and a tab chip have to agree about one
 * session, and that agreement is this table.
 */

const STATES = [
  "attention",
  "working",
  "idle",
  "finished",
  "background",
  "trailing",
] as const;

describe("the state appearance", () => {
  it("puts one colour on a state, and four colours exist", () => {
    expect(STATE_COLOUR.attention).toBe("sky-500");
    expect(STATE_COLOUR.working).toBe("orange-500");
    // A turn that ended and an agent sitting at its prompt are the same thing to the user now: the
    // question is only whether work is in flight, and a finished session says it stays.
    expect(STATE_COLOUR.finished).toBe("emerald-500");
    expect(STATE_COLOUR.idle).toBe("emerald-500");
    // A live process the window cannot see inside shares orange with a turn in flight.
    expect(STATE_COLOUR.background).toBe("orange-500");
    expect(new Set(Object.values(STATE_COLOUR)).size).toBe(4);
  });

  it("gives the state that is neither working nor at rest a colour of its own", () => {
    // Three attempts were drawn and each was decided by looking at it: a gradient from orange to
    // green read as khaki (the middle of those two hues is a brown, and on a six pixel dot it is
    // most of the marker), a hard stop inside the dot at 65% of its radius read as a green dot with
    // an orange middle (one pixel of ring on a six pixel dot is 58% of its area however the colours
    // are named), and an orange dot with one pixel of green around it was a ring and still not
    // what was asked for. On a marker this small two colours cannot both be read, so this state is
    // told apart by a colour of its own instead.
    expect(STATE_COLOUR.trailing).toBe("purple-500");
    expect(DOT_CLASS.trailing).toContain("bg-purple-500");
    expect(DOT_CLASS.trailing).not.toContain("ring-");
    expect(DOT_CLASS.trailing).not.toContain("gradient");
    // The row's bar is the same colour, the bed held back and the light full strength.
    expect(MARQUEE_TRACK_CLASS.trailing).toContain("bg-purple-500/25");
    expect(MARQUEE_SWEEP_CLASS.trailing).toContain("bg-purple-500");
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

  it("says something its own about the state that is neither working nor rest", () => {
    expect(agentStateLabelKey("trailing")).not.toBe(
      agentStateLabelKey("working"),
    );
    expect(agentStateLabelKey("trailing")).not.toBe(agentStateLabelKey("idle"));
    expect(agentStateLabelKey("trailing")).not.toBe(
      agentStateLabelKey("finished"),
    );
  });
});
describe("the background state", () => {
  it("is orange, like work in flight, because it is the same colour of news", () => {
    // A live process we cannot see inside: the vocabulary's orange already means "an agent is
    // here", and a second colour for a weaker reading of the same fact would be one colour too many.
    expect(STATE_COLOUR.background).toBe("orange-500");
  });

  it("says what was actually read, not what was guessed", () => {
    // `working` claims a turn is in flight. The process table cannot see that; it can only see that
    // an agent exists. Two states, two sentences, one colour.
    expect(agentStateLabelKey("background")).not.toBe(
      agentStateLabelKey("working"),
    );
    expect(agentStateLabelKey("background")).not.toBe(
      agentStateLabelKey("idle"),
    );
  });
});
