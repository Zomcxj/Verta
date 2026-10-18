import { describe, expect, it } from "vitest";
import { resumeCommand } from "./resumeCommand";

describe("resumeCommand (opencode)", () => {
  it("passes the id and the directory", () => {
    expect(
      resumeCommand(
        {
          tool: "opencode",
          id: "ses_f183332f5ffeNGzvkzJ631PU71",
          cwd: "F:/VibeCoding_workspace/GitShow",
        },
        true,
      ),
    ).toBe(
      "opencode --session ses_f183332f5ffeNGzvkzJ631PU71 'F:/VibeCoding_workspace/GitShow'",
    );
  });

  it("quotes a path with spaces", () => {
    expect(
      resumeCommand(
        { tool: "opencode", id: "ses_1", cwd: "C:/Users/费马 大定理/Desktop" },
        true,
      ),
    ).toBe("opencode --session ses_1 'C:/Users/费马 大定理/Desktop'");
  });

  it("quotes a path that contains a single quote", () => {
    expect(
      resumeCommand(
        { tool: "opencode", id: "ses_1", cwd: "F:/it's here" },
        true,
      ),
    ).toBe("opencode --session ses_1 'F:/it''s here'");
  });
});

describe("resumeCommand (pi)", () => {
  it("resumes by id only, because the terminal already has the cwd", () => {
    expect(
      resumeCommand(
        {
          tool: "pi",
          id: "01a147ad-023f-71ff-b404-bb337dea4b63",
          cwd: "F:\\VibeCoding_workspace\\WorkBuddy",
        },
        true,
      ),
    ).toBe("pi --session 01a147ad-023f-71ff-b404-bb337dea4b63");
  });
});

describe("resumeCommand (id validation)", () => {
  it("refuses an id that could break out of the command", () => {
    expect(() =>
      resumeCommand({ tool: "pi", id: "x; rm -rf /", cwd: "F:/x" }, true),
    ).toThrow();
  });

  it("refuses an id with a quote", () => {
    expect(() =>
      resumeCommand(
        { tool: "opencode", id: "x' || whoami", cwd: "F:/x" },
        true,
      ),
    ).toThrow();
  });
});

describe("resumeCommand (WSL)", () => {
  it("quotes a Linux path the POSIX way, whatever the host platform is", () => {
    const command = resumeCommand(
      {
        tool: "opencode",
        id: "ses_1",
        cwd: "/home/cxj/workspace/mem0_chat_fastapi",
        distro: "Ubuntu-22.04",
      },
      true,
    );
    expect(command).toContain("--session ses_1 '/home/cxj/workspace/mem0_chat_fastapi'");
  });

  it("puts the distro's own installs ahead of PATH", () => {
    // 发行版里 PATH 上的 opencode 可能是 Windows 那个 exe，读的是另一个库。
    const command = resumeCommand({
      tool: "opencode",
      id: "ses_1",
      cwd: "/home/cxj",
      distro: "Ubuntu-22.04",
    });
    expect(command).toMatch(/^env PATH="\$HOME\/\.opencode\/bin:.*opencode --session ses_1 /);
  });
});
