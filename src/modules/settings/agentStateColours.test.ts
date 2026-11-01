import { describe, expect, it } from "vitest";
import { DEFAULT_STATE_COLOURS, STATE_COLOUR_TOKENS } from "@/modules/terminal/agentStateColours";
import { DEFAULT_PREFERENCES, coerceAgentStateColours } from "./store";

describe("coerceAgentStateColours", () => {
  it("keeps a table it recognises, whole and unchanged", () => {
    const stored = {
      attention: "rose",
      working: "cyan",
      idle: "indigo",
      finished: "amber",
      background: "emerald",
      trailing: "sky",
    };
    expect(coerceAgentStateColours(stored)).toEqual(stored);
  });

  it("repairs one state at a time, and keeps the user's other five", () => {
    // The half of this that matters: a file with one bad entry must not take the other choices with
    // it. Only the entry that is not one of the hues goes back to the default.
    const repaired = coerceAgentStateColours({
      attention: "chartreuse",
      working: "cyan",
      trailing: 42,
    });
    expect(repaired.attention).toBe(DEFAULT_STATE_COLOURS.attention);
    expect(repaired.trailing).toBe(DEFAULT_STATE_COLOURS.trailing);
    expect(repaired.working).toBe("cyan");
    expect(repaired.idle).toBe(DEFAULT_STATE_COLOURS.idle);
  });

  it("fills in a state the stored table never heard of", () => {
    // A table written before a state existed, and a table written before this setting existed.
    expect(coerceAgentStateColours({ working: "cyan" })).toEqual({
      ...DEFAULT_STATE_COLOURS,
      working: "cyan",
    });
    expect(coerceAgentStateColours(undefined)).toEqual(DEFAULT_STATE_COLOURS);
  });

  it("draws the defaults for anything that is not a table at all", () => {
    // A hand-edited file, a value a future version wrote, a stray string or array: the markers still
    // have to draw, and the defaults are what every existing install already shows.
    for (const junk of [null, "cyan", 7, true, ["cyan"], []]) {
      expect(coerceAgentStateColours(junk)).toEqual(DEFAULT_STATE_COLOURS);
    }
  });

  it("starts on the colours the interface has always used", () => {
    expect(DEFAULT_PREFERENCES.agentStateColours).toEqual({
      attention: "sky",
      working: "orange",
      idle: "emerald",
      finished: "emerald",
      background: "orange",
      trailing: "purple",
    });
    // And every one of them is a colour the tables can draw.
    for (const token of Object.values(DEFAULT_PREFERENCES.agentStateColours)) {
      expect(STATE_COLOUR_TOKENS).toContain(token);
    }
  });
});
