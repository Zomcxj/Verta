import type { WorkspaceEnv } from "@/modules/workspace";
import { describe, expect, it } from "vitest";
import {
  activeSpaceEnv,
  findActiveSpace,
  freshTabCwd,
  tabEnvironment,
} from "./activeSpace";
import type { Tab } from "@/modules/tabs";
import type { SpaceMeta } from "./store";

function space(over: Partial<SpaceMeta>): SpaceMeta {
  return {
    id: "s1",
    name: "Space",
    root: null,
    env: { kind: "local" },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("findActiveSpace", () => {
  it("returns the space matching activeId", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, "b")?.id).toBe("b");
  });

  it("falls back to the first space when activeId is null or unknown", () => {
    const spaces = [space({ id: "a" }), space({ id: "b" })];
    expect(findActiveSpace(spaces, null)?.id).toBe("a");
    expect(findActiveSpace(spaces, "missing")?.id).toBe("a");
  });

  it("returns null when there are no spaces", () => {
    expect(findActiveSpace([], "a")).toBeNull();
  });
});

describe("activeSpaceEnv", () => {
  it("restores the active space's WSL env", () => {
    const spaces = [
      space({ id: "a", env: { kind: "local" } }),
      space({ id: "b", env: { kind: "wsl", distro: "Ubuntu" } }),
    ];
    expect(activeSpaceEnv(spaces, "b")).toEqual({
      kind: "wsl",
      distro: "Ubuntu",
    });
  });

  it("restores the env of the fallback space when activeId is missing", () => {
    const spaces = [space({ id: "a", env: { kind: "wsl", distro: "Debian" } })];
    expect(activeSpaceEnv(spaces, null)).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
  });

  it("defaults to local when there are no spaces", () => {
    expect(activeSpaceEnv([], "a")).toEqual({ kind: "local" });
  });
});

describe("freshTabCwd", () => {
  const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu" };
  const local: WorkspaceEnv = { kind: "local" };

  it("prefers the restored home for any env", () => {
    expect(freshTabCwd(wsl, "/home/aj", "C:/Users/me", "C:/Users/me")).toBe(
      "/home/aj",
    );
    expect(freshTabCwd(local, "C:/Users/me", "C:/work", "C:/Users/me")).toBe(
      "C:/Users/me",
    );
  });

  it("leaves a brand-new tab's cwd to the backend, both on local and WSL", () => {
    // 后端按环境定：本机落桌面，WSL 落该发行版当前用户的 home。
    expect(freshTabCwd(local, null, "C:/work", "C:/Users/me")).toBeNull();
    expect(freshTabCwd(wsl, null, "C:/Users/me", "C:/Users/me")).toBeNull();
    expect(freshTabCwd(local, null, null, null)).toBeNull();
  });
});

describe("tabEnvironment", () => {
  const wsl: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu-22.04" };
  const local: WorkspaceEnv = { kind: "local" };
  const tab = (over: Partial<Extract<Tab, { kind: "terminal" }>>) =>
    ({
      id: 1,
      kind: "terminal",
      spaceId: "s1",
      title: "shell",
      paneTree: { kind: "leaf", id: 2 },
      activeLeafId: 2,
      ...over,
    }) as Tab;

  it("prefers the environment the leaf recorded", () => {
    const found = tab({
      paneTree: { kind: "leaf", id: 2, cwd: "/home/aj", workspace: wsl },
    });
    expect(tabEnvironment(found, local)).toEqual(wsl);
  });

  it("reads a restored Linux cwd as the distro, not as this machine", () => {
    // 空间一直在本机，但存下来的标签停在发行版里：不按 cwd 反推的话，终端会带着
    // Linux 路径去本机启动。
    const found = tab({ paneTree: { kind: "leaf", id: 2, cwd: "/home/aj" } });
    expect(tabEnvironment(found, wsl)).toEqual(wsl);
  });

  it("reads a restored Windows cwd as this machine", () => {
    const found = tab({
      paneTree: { kind: "leaf", id: 2, cwd: "C:/work" },
    });
    expect(tabEnvironment(found, wsl)).toEqual(local);
  });

  it("has no opinion without a cwd, and ignores non-terminal tabs", () => {
    expect(tabEnvironment(tab({}), wsl)).toBeNull();
    expect(
      tabEnvironment({ id: 3, kind: "editor", spaceId: "s1" } as Tab, wsl),
    ).toBeNull();
  });
});
