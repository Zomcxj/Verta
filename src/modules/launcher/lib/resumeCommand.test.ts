import { describe, expect, it } from "vitest";
import { newSessionCommand, resumeCommand } from "./resumeCommand";

describe("resumeCommand (opencode)", () => {
  it("passes the id and the directory", () => {
    expect(
      resumeCommand(
        {
          tool: "opencode",
          id: "ses_f183332f5ffeNGzvkzJ631PU71",
          cwd: "F:/work/example-project",
        },
        true,
      ),
    ).toBe(
      "opencode --session ses_f183332f5ffeNGzvkzJ631PU71 'F:/work/example-project'",
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

describe("resumeCommand (claude)", () => {
  it("resumes by id only, because Claude Code looks it up in the cwd's own project", () => {
    // Its transcripts live under `~/.claude/projects/<the cwd, flattened>/`, so the session is found
    // from the directory the terminal opened in - the same reason pi carries no directory.
    expect(
      resumeCommand(
        {
          tool: "claude",
          id: "b282aa01-3997-4af9-96d5-76c8aa9f9ded",
          cwd: "C:\\Users\\cxj\\Desktop\\dsh",
        },
        true,
      ),
    ).toBe("claude --resume b282aa01-3997-4af9-96d5-76c8aa9f9ded");
  });

  it("carries nothing for a distro, because its sessions are never inside one", () => {
    const command = resumeCommand(
      {
        tool: "claude",
        id: "b282aa01-3997-4af9-96d5-76c8aa9f9ded",
        cwd: "/home/cxj/work",
        distro: "Ubuntu-22.04",
      },
      false,
    );
    expect(command).toBe("claude --resume b282aa01-3997-4af9-96d5-76c8aa9f9ded");
    expect(command).not.toContain("env PATH");
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
    // On PATH inside a distro, `opencode` may be the Windows exe, which reads another store.
    const command = resumeCommand({
      tool: "opencode",
      id: "ses_1",
      cwd: "/home/cxj",
      distro: "Ubuntu-22.04",
    });
    expect(command).toMatch(/^env PATH="\$HOME\/\.opencode\/bin:.*opencode --session ses_1 /);
  });
});

describe("newSessionCommand", () => {
  it("starts the agent without a session id", () => {
    expect(newSessionCommand("opencode")).toBe("opencode");
    expect(newSessionCommand("pi")).toBe("pi");
    expect(newSessionCommand("claude")).toBe("claude");
    expect(newSessionCommand("opencode")).not.toContain("--session");
  });

  it("puts the distro's own installs ahead of PATH there too", () => {
    const command = newSessionCommand("opencode", "Ubuntu-22.04");
    expect(command).toMatch(/^env PATH="\$HOME\/\.opencode\/bin:.*opencode$/);
  });
});
