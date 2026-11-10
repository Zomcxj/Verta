import { beforeEach, describe, expect, it } from "vitest";
import { IS_WINDOWS } from "@/lib/platform";
import {
  decideCwd,
  forgetRecalledCwds,
  needsShellTranslation,
  rememberCwd,
} from "./spelledCwd";

describe("asking the shell about a cwd", () => {
  beforeEach(() => {
    forgetRecalledCwds();
  });

  it("asks once per spelling and uses the answer from then on", () => {
    // The failing case this exists for: Git-Bash reports `/tmp/verta`, which nothing on the Windows
    // side can open, and it reports it again at every prompt.
    expect(decideCwd("/tmp/verta", true)).toEqual({ kind: "ask" });
    expect(rememberCwd("/tmp/verta", "C:/Users/cxj/AppData/Local/Temp/verta")).toBe(
      "C:/Users/cxj/AppData/Local/Temp/verta",
    );
    expect(decideCwd("/tmp/verta", true)).toEqual({
      kind: "use",
      cwd: "C:/Users/cxj/AppData/Local/Temp/verta",
    });
  });

  it("remembers a refusal instead of asking again", () => {
    // No Git install, or a `cygpath` that would not answer: the spelling stands, and the menu shows
    // the failure the filesystem gives rather than a wrong directory.
    expect(decideCwd("/usr/bin", true)).toEqual({ kind: "ask" });
    expect(rememberCwd("/usr/bin", null)).toBe("/usr/bin");
    expect(decideCwd("/usr/bin", true)).toEqual({ kind: "use", cwd: "/usr/bin" });
  });

  it("asks about nothing that is already a Windows path", () => {
    // The drive-in-disguise shape is repaired by the OSC 7 parser before this sees it, and a UNC path
    // is Windows' own spelling.
    expect(decideCwd("C:/Users/cxj", true)).toEqual({ kind: "use", cwd: "C:/Users/cxj" });
    expect(decideCwd("//server/share", true)).toEqual({ kind: "use", cwd: "//server/share" });
    expect(decideCwd("nonsense", true)).toEqual({ kind: "use", cwd: "nonsense" });
    expect(decideCwd("", true)).toEqual({ kind: "use", cwd: "" });
  });

  it("keeps one answer per spelling, not one per session", () => {
    // Two panes in the same directory ask once between them: the key is what the shell said.
    rememberCwd("/tmp/verta", "C:/Temp/verta");
    expect(decideCwd("/tmp/verta", true)).toEqual({ kind: "use", cwd: "C:/Temp/verta" });
    expect(decideCwd("/tmp/other", true)).toEqual({ kind: "ask" });
  });
});

describe("what a path is spelled as", () => {
  it("asks about a POSIX spelling, and about nothing else", () => {
    // `/tmp/verta` is where the directory is on a POSIX machine, so the platform decides; on Windows
    // it is a place only the shell can name. A drive, a UNC path and a relative path are never asked
    // about - `cygpath` would hand back a relative path unchanged.
    expect(needsShellTranslation("/tmp/verta")).toBe(IS_WINDOWS);
    expect(needsShellTranslation("C:/Users/cxj")).toBe(false);
    expect(needsShellTranslation("//server/share")).toBe(false);
    expect(needsShellTranslation("nonsense")).toBe(false);
    expect(needsShellTranslation("")).toBe(false);
  });
});
