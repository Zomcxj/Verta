import { describe, expect, it } from "vitest";
import {
  openTabForSession,
  planSessionOpen,
  planSessionResume,
} from "./openSession";
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

describe("openTabForSession", () => {
  const tabs = [
    { kind: "terminal", id: 1, sessionId: "ses_a" },
    { kind: "editor", id: 2, sessionId: "ses_b" },
    { kind: "terminal", id: 3 },
    { kind: "block", id: 4, sessionId: "ses_c" },
  ];

  it("finds the terminal tab that resumed this session", () => {
    expect(openTabForSession(tabs, "ses_a")?.id).toBe(1);
  });

  it("does not match a tab that is not a terminal", () => {
    // An editor tab can carry the same property name for another reason; only a terminal holding
    // an agent can be the one a session is already running in.
    expect(openTabForSession(tabs, "ses_b")).toBeUndefined();
    expect(openTabForSession(tabs, "ses_c")).toBeUndefined();
  });

  it("says nothing for a session no tab has", () => {
    expect(openTabForSession(tabs, "ses_z")).toBeUndefined();
    expect(openTabForSession([], "ses_a")).toBeUndefined();
  });
});
describe("planSessionResume", () => {
  it("builds the same plan a session row would, from what the tab stored", () => {
    const plan = planSessionResume(
      "opencode",
      "ses_1",
      "F:/work/PasteLabel",
      { kind: "local" },
    );
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.cwd).toBe("F:/work/PasteLabel");
    expect(plan.command).toBe("opencode --session ses_1 'F:/work/PasteLabel'");
  });

  it("a distro leaf resumes under the distro's own rules", () => {
    const plan = planSessionResume("opencode", "ses_1", "/home/cxj/work", {
      kind: "wsl",
      distro: "Ubuntu",
    });
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.workspace).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(plan.command).toContain(
      "opencode --session ses_1 '/home/cxj/work'",
    );
  });

  it("an illegal session id refuses the whole plan", () => {
    expect(
      planSessionResume("pi", "ses_1; rm -rf /", "F:/work", { kind: "local" }),
    ).toBeNull();
  });
});
