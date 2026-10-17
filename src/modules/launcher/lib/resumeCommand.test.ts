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
