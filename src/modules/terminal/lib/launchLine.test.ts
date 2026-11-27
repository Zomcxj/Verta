import { describe, expect, it } from "vitest";
import {
  launchLineDisplayed,
  screenShowsLaunchLine,
  squeezeWhitespace,
} from "./launchLine";

/** The screen as a shell leaves it right after the app wrote a resume command. */
const ECHOED = [
  "cxj@LAPTOP MINGW64 ~",
  "$ pi --session 01a151cb-0123-72b0-a7a7-5fd13c054dd6",
  "",
].join("\n");

/** The same screen a second later, once pi has painted its own interface. */
const AFTER_AGENT = [
  "cxj@LAPTOP MINGW64 ~",
  "$ pi --session 01a151cb-0123-72b0-a7a7-5fd13c054dd6",
  "\u{1F17F} v1.4.0",
  "escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more",
  "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.",
].join("\n");

describe("squeezeWhitespace", () => {
  it("joins a wrapped command back into its characters", () => {
    const wrapped = ["opencode --session", "  x"].join("\n");
    expect(squeezeWhitespace(wrapped)).toBe("opencode--sessionx");
  });

  it("leaves text with no whitespace alone", () => {
    expect(squeezeWhitespace("pi")).toBe("pi");
  });
});

describe("screenShowsLaunchLine", () => {
  it("finds the echoed line on the screen it was written to", () => {
    expect(
      screenShowsLaunchLine(ECHOED, "pi --session 01a151cb-0123-72b0-a7a7-5fd13c054dd6"),
    ).toBe(true);
  });

  it("finds it when the shell wrapped the line", () => {
    const wrapped = [
      "cxj@LAPTOP MINGW64 D:/VsPro/Verta (main)",
      "$ opencode --session ses_ea4169406ffeIb3c7BzYXj2FRT",
      " 'D:/VsPro/Verta'",
    ].join("\n");
    expect(
      screenShowsLaunchLine(wrapped, "opencode --session ses_ea4169406ffeIb3c7BzYXj2FRT 'D:/VsPro/Verta'"),
    ).toBe(true);
  });

  it("keeps finding it after the agent has started painting below it", () => {
    // The banner does not make the command go away: pi paints on the normal screen.
    expect(
      screenShowsLaunchLine(AFTER_AGENT, "pi --session 01a151cb-0123-72b0-a7a7-5fd13c054dd6"),
    ).toBe(true);
  });

  it("says no once the agent's own screen has replaced it", () => {
    const tui = [
      "Build auto · minimax-m3.1-flash",
      "esc interrupt   ctrl+p commands",
      "",
    ].join("\n");
    expect(
      screenShowsLaunchLine(tui, "pi --session 01a151cb-0123-72b0-a7a7-5fd13c054dd6"),
    ).toBe(false);
  });

  it("does not count a mention in the middle of a row", () => {
    // A new session's command is just the tool's name, which its own output mentions.
    const prose = "Ask it how to use or extend Pi";
    expect(screenShowsLaunchLine(prose, "pi")).toBe(false);
  });

  it("is not fooled by an empty command", () => {
    expect(screenShowsLaunchLine(ECHOED, "")).toBe(false);
    expect(screenShowsLaunchLine(ECHOED, "   ")).toBe(false);
  });
});

describe("launchLineDisplayed", () => {
  it("says no on the alternate screen, whatever the text says", () => {
    // Measured on this machine: a resumed claude session shows the resume command *inside its own
    // conversation*, because that is what the reader had been asking about. The alternate screen is
    // a separate buffer, so the shell's echo is not being displayed - and reading a mention in the
    // agent's own transcript as the echo kept the cover up for the whole 60 s cap, reported as
    // "还是卡在加载动画".
    const transcript = [
      "● 关于这条命令 claude --resume b282aa01-3997-4af9-96d5-76c8aa9f9ded",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    expect(
      launchLineDisplayed(
        transcript,
        "claude --resume b282aa01-3997-4af9-96d5-76c8aa9f9ded",
        true,
      ),
    ).toBe(false);
  });

  it("says yes while the shell is still showing the echo", () => {
    expect(
      launchLineDisplayed(
        ECHOED,
        "pi --session 01a151cb-0123-72b0-a7a7-5fd13c054dd6",
        false,
      ),
    ).toBe(true);
  });

  it("says no when there is no screen to read", () => {
    expect(launchLineDisplayed(null, "pi", false)).toBe(false);
  });
});