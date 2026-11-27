import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "./types";
import {
  defaultWorktreeBranch,
  resolveWorktreeRepo,
  workspaceForSession,
} from "./worktreeForSession";

const authorize = vi.fn(async () => "");
const resolveRepo = vi.fn<
  (cwd: string, env?: unknown) => Promise<{ repoRoot: string } | null>
>(async () => ({ repoRoot: "C:/proj/Verta" }));

vi.mock("@/lib/native", () => ({
  native: {
    workspaceAuthorize: (...args: unknown[]) => authorize(...(args as [])),
    gitResolveRepo: (cwd: string, env?: unknown) => resolveRepo(cwd, env),
  },
}));

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "b282aa01-3997-4af9",
    tool: "claude",
    title: "Fix login bug!",
    cwd: "C:/proj/Verta",
    updatedAtMs: 0,
    parentId: null,
    distro: null,
    ...over,
  };
}

describe("defaultWorktreeBranch", () => {
  it("slugs the session title under agent/", () => {
    expect(defaultWorktreeBranch(session({ title: "Fix login bug!" }))).toBe(
      "agent/fix-login-bug",
    );
  });

  it("falls back to the id when the title has no usable characters", () => {
    expect(
      defaultWorktreeBranch(session({ id: "b282aa01-3997", title: "！！" })),
    ).toBe("agent/b282aa01");
  });
});

describe("workspaceForSession", () => {
  it("takes the distro from the session, not from the path", () => {
    // A local session must not be opened in a distro shell, and the reverse.
    expect(workspaceForSession(session({ distro: "Ubuntu-22.04" }))).toEqual({
      kind: "wsl",
      distro: "Ubuntu-22.04",
    });
    expect(workspaceForSession(session({ distro: null }))).toEqual({
      kind: "local",
    });
  });
});

describe("resolveWorktreeRepo", () => {
  it("authorises the session's own folder before asking for the repository", async () => {
    // The list is read from the agents' own files, so a project that was never opened here
    // is still listed; without this the click fails with "outside the authorized workspace".
    const order: string[] = [];
    authorize.mockImplementationOnce(async () => {
      order.push("authorize");
      return "";
    });
    resolveRepo.mockImplementationOnce(async () => {
      order.push("resolve");
      return { repoRoot: "C:/proj/Verta" };
    });
    const resolved = await resolveWorktreeRepo(session({ cwd: "C:/proj/Verta/app" }));
    expect(resolved).toEqual({ repoRoot: "C:/proj/Verta" });
    expect(order).toEqual(["authorize", "resolve"]);
  });

  it("says there is no repository rather than failing silently", async () => {
    resolveRepo.mockResolvedValueOnce(null);
    expect(await resolveWorktreeRepo(session())).toEqual({
      error: "no-repository",
    });
  });

  it("hands the command's own sentence back when the resolve is refused", async () => {
    authorize.mockRejectedValueOnce(new Error("outside the authorized workspace"));
    expect(await resolveWorktreeRepo(session())).toEqual({
      error: "Error: outside the authorized workspace",
    });
  });
});
