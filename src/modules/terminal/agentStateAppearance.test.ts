import { describe, expect, it } from "vitest";
import {
  DOT_MARKER_CLASS,
  MARQUEE_SWEEP_ANIMATION_CLASS,
  MARQUEE_TRACK_MARKER_CLASS,
  agentStateLabelKey,
} from "./AgentStateDot";
import {
  type AgentStateDot,
  DEFAULT_STATE_COLOURS,
  DOT_BG,
  MARQUEE_SWEEP_BG,
  MARQUEE_TRACK_BG,
  STATE_COLOUR_TOKENS,
} from "./agentStateColours";

/**
 * How a state is drawn, as data.
 *
 * The colour a state is drawn in is what the user reads from across the window, so it is pinned here
 * rather than measured on the screen first: a session list row and a tab chip have to agree about one
 * session, and that agreement is these tables read through the one preference they share.
 *
 * What each state's colour *is* is the user's choice now (Settings, under Themes), so what is pinned
 * is the colour every state starts on, and the shape that has to hold for every colour there is.
 */

const STATES: readonly AgentStateDot[] = [
  "attention",
  "working",
  "idle",
  "finished",
  "background",
  "trailing",
];

describe("the state appearance", () => {
  it("starts every state on the colour it has always had", () => {
    expect(DEFAULT_STATE_COLOURS.attention).toBe("sky");
    expect(DEFAULT_STATE_COLOURS.working).toBe("orange");
    // A turn that ended and an agent sitting at its prompt are the same thing to the user: the
    // question is only whether work is in flight, and a finished session says it stays.
    expect(DEFAULT_STATE_COLOURS.finished).toBe("emerald");
    expect(DEFAULT_STATE_COLOURS.idle).toBe("emerald");
    expect(DEFAULT_STATE_COLOURS.background).toBe("orange");
    // The state that is neither working nor at rest. Three attempts were drawn and each was decided
    // by looking at it: a gradient from orange to green read as khaki (the middle of those two hues
    // is a brown, and on a six pixel dot it is most of the marker), a hard stop inside the dot at 65%
    // of its radius read as a green dot with an orange middle (one pixel of ring on a six pixel dot
    // is 58% of its area however the colours are named), and an orange dot with one pixel of green
    // around it was a ring and still not what was asked for. On a marker this small two colours
    // cannot both be read, so this state is told apart by a colour of its own.
    expect(DEFAULT_STATE_COLOURS.trailing).toBe("purple");
    // Four colours in all, one of them the mix: that is what the interface has always spoken with.
    expect(new Set(Object.values(DEFAULT_STATE_COLOURS)).size).toBe(4);
  });

  it("gives every state a colour, and every colour a way to be drawn", () => {
    for (const state of STATES) {
      expect(STATE_COLOUR_TOKENS).toContain(DEFAULT_STATE_COLOURS[state]);
    }
    for (const token of STATE_COLOUR_TOKENS) {
      // Written out rather than assembled from the token: Tailwind reads class names out of the
      // source as text, so a hue that is not spelled out in a table does not exist in the built
      // stylesheet - and the row above would draw an invisible marker.
      for (const table of [DOT_BG, MARQUEE_TRACK_BG, MARQUEE_SWEEP_BG]) {
        expect(table[token]).toContain(`bg-${token}-500`);
      }
    }
  });

  it("draws the bar in the colour of its dot, held back to a quarter", () => {
    // The half of the agreement that can fail silently: two tables drifting apart would put a row
    // and a tab chip in two different colours for one session, and nothing on screen would say so.
    for (const token of STATE_COLOUR_TOKENS) {
      expect(MARQUEE_SWEEP_BG[token]).toBe(DOT_BG[token]);
      expect(MARQUEE_TRACK_BG[token]).toBe(`${DOT_BG[token]}/25`);
    }
  });

  it("draws every state as an indicator that breathes, whatever colour it is", () => {
    // The colour is the user's to choose; the animation is not. A marker that keeps moving says the
    // session is live, and the stylesheet stops every one of them at once when nobody can see the
    // window, so the two may not be tied to each other.
    expect(DOT_MARKER_CLASS).toContain("verta-state-breathe");
    expect(DOT_MARKER_CLASS).toContain("verta-state-indicator");
    expect(MARQUEE_TRACK_MARKER_CLASS).toContain("verta-state-indicator");
    expect(MARQUEE_SWEEP_ANIMATION_CLASS).toContain("verta-state-marquee");
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
  it("is orange by default, like work in flight, because it is the same colour of news", () => {
    // A live process we cannot see inside: the vocabulary's orange already means "an agent is
    // here", and a second colour for a weaker reading of the same fact would be one colour too many.
    expect(DEFAULT_STATE_COLOURS.background).toBe("orange");
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
