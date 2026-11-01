import { describe, expect, it } from "vitest";
import {
  AGENT_UI_INLINE_BYTES,
  AGENT_UI_INLINE_FLOOR_MS,
  AGENT_UI_PAINT_BYTES,
  AGENT_UI_SILENCE_MS,
  AGENT_UI_TIMEOUT_MS,
  type CoverTick,
  coverRuleFor,
} from "./coverRule";

/** A tick that no rule would fire on: nothing written, nothing on screen yet. */
const quiet: CoverTick = {
  elapsed: 0,
  bytes: 0,
  silentFor: 0,
  showsLaunch: false,
  hasOwnScreen: false,
  alt: false,
  echoed: false,
};

/** A tick that satisfies every rule's numbers, so only the screen decides. */
const everyRuleSatisfied: CoverTick = {
  elapsed: AGENT_UI_TIMEOUT_MS + 1,
  bytes: AGENT_UI_PAINT_BYTES + 10_000,
  silentFor: AGENT_UI_SILENCE_MS + 1_000,
  showsLaunch: false,
  hasOwnScreen: true,
  alt: true,
  echoed: true,
};

describe("the cover never lifts onto its own command", () => {
  it("keeps waiting when the command is on screen, whatever the numbers say", () => {
    // The invariant this file exists for. Every rule's thresholds are met at once and the only
    // difference is the command being displayed; the answer has to be "keep waiting". This is the
    // regression that was measured on this machine, lifting onto `$ opencode --session ...`.
    expect(coverRuleFor({ ...everyRuleSatisfied, showsLaunch: true })).toBeNull();
  });

  it("keeps waiting on the byte count alone while the command is displayed", () => {
    // pi's banner is several KB painted above a still-visible command line.
    expect(
      coverRuleFor({
        ...quiet,
        bytes: AGENT_UI_PAINT_BYTES + 5_000,
        elapsed: 900,
        showsLaunch: true,
      }),
    ).toBeNull();
  });

  it("keeps waiting after the output goes quiet, while the command is displayed", () => {
    // An agent loading its extensions is silent for longer than the silence window before it takes
    // the screen over.
    expect(
      coverRuleFor({
        ...quiet,
        bytes: AGENT_UI_INLINE_BYTES + 1_000,
        silentFor: AGENT_UI_SILENCE_MS + 900,
        elapsed: AGENT_UI_INLINE_FLOOR_MS + 1_000,
        hasOwnScreen: true,
        echoed: true,
        showsLaunch: true,
      }),
    ).toBeNull();
  });

  it("keeps waiting past the budget, while the command is displayed", () => {
    // The clock says nothing about the screen; the cover stays and the hard cap hands it back.
    expect(
      coverRuleFor({
        ...quiet,
        elapsed: AGENT_UI_TIMEOUT_MS + 5_000,
        bytes: 10_000,
        hasOwnScreen: true,
        echoed: true,
        showsLaunch: true,
      }),
    ).toBeNull();
  });
});

describe("each rule fires when the screen is free of the command", () => {
  it("lifts on the agent's own screen", () => {
    expect(
      coverRuleFor({
        ...quiet,
        elapsed: 2_000,
        hasOwnScreen: true,
        echoed: true,
      }),
    ).toBe("own-screen");
  });

  it("lifts on the alternate screen even before the echo was seen", () => {
    // A full-screen TUI takes the buffer over, so the shell's scrollback stops being displayed.
    expect(
      coverRuleFor({ ...quiet, elapsed: 2_000, alt: true, hasOwnScreen: true }),
    ).toBe("own-screen");
  });

  it("does not treat a bare shell prompt as the agent's own screen", () => {
    // The prompt is a screen of its own and arrives before the agent does. Without the echo or the
    // alternate screen the cover would lift on it.
    expect(
      coverRuleFor({ ...quiet, elapsed: 300, hasOwnScreen: true }),
    ).toBeNull();
  });

  it("lifts on silence once the frame is done", () => {
    expect(
      coverRuleFor({
        ...quiet,
        bytes: AGENT_UI_INLINE_BYTES + 100,
        silentFor: AGENT_UI_SILENCE_MS + 100,
        elapsed: AGENT_UI_INLINE_FLOOR_MS + 100,
      }),
    ).toBe("silence");
  });

  it("does not lift on silence before the floor", () => {
    // A branding flash: a real frame, then quiet, but too early to be the agent waiting on input.
    expect(
      coverRuleFor({
        ...quiet,
        bytes: AGENT_UI_INLINE_BYTES + 100,
        silentFor: AGENT_UI_SILENCE_MS + 100,
        elapsed: AGENT_UI_INLINE_FLOOR_MS - 100,
      }),
    ).toBeNull();
  });

  it("lifts on the byte count when the echo was never seen", () => {
    // The shell never echoed (a tool that reads the command from its own input), so the screen
    // cannot answer and the bytes do.
    expect(
      coverRuleFor({ ...quiet, bytes: AGENT_UI_PAINT_BYTES + 100, elapsed: 900 }),
    ).toBe("bytes-fallback");
  });

  it("does not lift on the byte count once the echo was seen", () => {
    // The command is on screen and nothing else counts.
    expect(
      coverRuleFor({
        ...quiet,
        bytes: AGENT_UI_PAINT_BYTES + 100,
        elapsed: 900,
        hasOwnScreen: false,
        echoed: true,
      }),
    ).toBeNull();
  });

  it("lifts on the budget once the command is gone", () => {
    expect(
      coverRuleFor({
        ...quiet,
        elapsed: AGENT_UI_TIMEOUT_MS + 1,
        bytes: 10_000,
        hasOwnScreen: true,
        echoed: true,
      }),
    ).toBe("own-screen");
  });
});

describe("no rule fires on an empty screen", () => {
  it("keeps waiting when nothing has been drawn at all", () => {
    // A cleared buffer with nothing painted: lifting here trades a command line for a blank pane.
    expect(coverRuleFor({ ...quiet, elapsed: AGENT_UI_TIMEOUT_MS + 1 })).toBeNull();
  });
});

describe("every rule agrees that the command must be gone", () => {
  it("for no combination of numbers does a rule fire while showsLaunch is true", () => {
    // Exhaustive over the thresholds that matter: crossing each one, with and without the command
    // on screen. This is the property, not an example of it.
    const elapsedValues = [0, 1_000, AGENT_UI_INLINE_FLOOR_MS, AGENT_UI_TIMEOUT_MS + 1];
    const byteValues = [0, AGENT_UI_INLINE_BYTES, AGENT_UI_PAINT_BYTES + 1];
    const silentValues = [0, AGENT_UI_SILENCE_MS + 1];
    const flags = [false, true];
    for (const elapsed of elapsedValues) {
      for (const bytes of byteValues) {
        for (const silentFor of silentValues) {
          for (const alt of flags) {
            for (const echoed of flags) {
              for (const hasOwnScreen of flags) {
                const tick: CoverTick = {
                  elapsed,
                  bytes,
                  silentFor,
                  showsLaunch: true,
                  hasOwnScreen,
                  alt,
                  echoed,
                };
                expect(
                  coverRuleFor(tick),
                  `fired on ${JSON.stringify(tick)}`,
                ).toBeNull();
              }
            }
          }
        }
      }
    }
  });
});
