import { describe, expect, it } from "vitest";
import { planSessionOpen } from "./openSession";
import type { AgentSession } from "./types";

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "ses_1",
    tool: "opencode",
    title: "PasteLabel",
    cwd: "F:/VibeCoding_workspace/PasteLabel",
    updatedAtMs: 0,
    parentId: null,
    distro: null,
    ...over,
  };
}

describe("planSessionOpen", () => {
  it("keeps a host session on the host, whatever environment the app is in", () => {
    // This one used to slip through: a host session carries no environment (undefined), so the
    // terminal fell back to the "current environment", and clicking a host session in a WSL
    // terminal gave a host command in a distro shell, where `chdir F:/...` is an ENOENT.
    const plan = planSessionOpen(session());
    expect(plan?.workspace).toEqual({ kind: "local" });
    expect(plan?.cwd).toBe("F:/VibeCoding_workspace/PasteLabel");
    expect(plan?.command).toContain("--session ses_1");
    // The host form: no distro `env PATH=` prefix in front.
    expect(plan?.command.startsWith("opencode ")).toBe(true);
  });

  it("opens a distro session inside that distro, with the POSIX command", () => {
    const plan = planSessionOpen(
      session({
        cwd: "/home/cxj/workspace/token-monitor",
        distro: "Ubuntu-22.04",
      }),
    );
    expect(plan?.workspace).toEqual({ kind: "wsl", distro: "Ubuntu-22.04" });
    expect(plan?.command).toMatch(/^env PATH="\$HOME\/\.opencode\/bin:.*opencode --session ses_1 /);
  });

  it("refuses a session id that would have to be escaped into the command", () => {
    expect(planSessionOpen(session({ id: "ses_1; rm -rf /" }))).toBeNull();
  });
});