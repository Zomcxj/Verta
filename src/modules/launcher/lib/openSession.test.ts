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
    // 这条以前是漏的：本机会话不带环境（undefined），终端就去用「当前环境」，
    // 于是在 WSL 终端里点一个本机会话，命令是本机的、shell 是发行版的，
    // `chdir F:/...` 在 Linux 侧必然 ENOENT。
    const plan = planSessionOpen(session());
    expect(plan?.workspace).toEqual({ kind: "local" });
    expect(plan?.cwd).toBe("F:/VibeCoding_workspace/PasteLabel");
    expect(plan?.command).toContain("--session ses_1");
    // 本机形式：没有发行版那串 env PATH= 前缀。
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