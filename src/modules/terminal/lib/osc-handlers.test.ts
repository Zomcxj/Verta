import { describe, expect, it, vi } from "vitest";
import { parseOsc7, parseOsc52Clipboard } from "./osc-handlers";
import { GhosttySemanticEventRouter } from "@/modules/terminal/ghostty/core/GhosttySemanticEventRouter";
vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));

describe("terminal semantic boundaries", () => {
  it.each([
    ["file:///c/Users/leo/project", "C:/Users/leo/project"],
    ["file:///C:/Users/me/project", "C:/Users/me/project"],
    ["file://host/home/me/a%20b", "/home/me/a b"],
    // A shell that reports a Windows path spells the URI as `file://HOSTF:/dir`, with no
    // slash before the drive: the authority swallows the `F:`, and the path comes back
    // without it. Left alone, that value is stored and later resolved against whichever
    // drive the app happens to sit on.
    ["file://LAPTOP/f/VibeCoding_workspace/Verta", "F:/VibeCoding_workspace/Verta"],
    [
      "file://LAPTOP-F:/VibeCoding_workspace/Verta",
      "F:/VibeCoding_workspace/Verta",
    ],
    // The same report as our own bash rcfile sends, which percent-encodes the colon: the
    // authority is then `HOSTF%3A`, so the drive hides behind `%3A` instead of a literal
    // colon and the repair above does not see it. Measured on this machine (2026-11-01), the
    // URI a pane at `F:/VibeCoding_workspace/Verta` really sends, after which the tab's cwd
    // became `/VibeCoding_workspace/Verta` and the file tree answered "the system cannot
    // find the path specified".
    [
      "file://LAPTOP-7P186K9VF%3A/VibeCoding_workspace/Verta",
      "F:/VibeCoding_workspace/Verta",
    ],
    ["https://example.com/path", null],
  ])("normalizes cwd %s", (uri, expected) =>
    expect(parseOsc7(uri)).toBe(expected),
  );

  it("rejects cwd during command input and output, then accepts the local prompt", () => {
    const onCwd = vi.fn();
    const router = new GhosttySemanticEventRouter({ onCwd });
    router.handle({ type: "prompt-start" });
    router.handle({ type: "pwd", uri: "file:///home/me" });
    router.handle({ type: "prompt-end" });
    router.handle({ type: "pwd", uri: "file:///etc" });
    router.handle({ type: "end-of-input" });
    router.handle({ type: "pwd", uri: "file:///private" });
    router.handle({ type: "end-of-command", exitCode: 0 });
    router.handle({ type: "pwd", uri: "file:///home/me/project" });
    expect(onCwd.mock.calls).toEqual([["/home/me"], ["/home/me/project"]]);
  });

  it.each([
    ["c;SGVsbG8=", "Hello"],
    ["c;zrsg5pel5pys6Kqe", "λ 日本語"],
    ["p;SGVsbG8=", null],
    ["c;?", null],
    ["c;bad base64!", null],
    ["c;/w==", null],
  ])("validates clipboard payload %s", (payload, expected) =>
    expect(parseOsc52Clipboard(payload)).toBe(expected),
  );

  it("rejects oversized clipboard writes", () =>
    expect(parseOsc52Clipboard(`c;${"A".repeat(1_398_110)}`)).toBeNull());
});
