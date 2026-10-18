import { describe, expect, it } from "vitest";
import { envForRoot, LOCAL_WORKSPACE, type WorkspaceEnv } from "./env";

const WSL: WorkspaceEnv = { kind: "wsl", distro: "Ubuntu-22.04" };

describe("envForRoot", () => {
  it("reads the distro out of a \\\\wsl.localhost root", () => {
    expect(envForRoot("\\\\wsl.localhost\\Ubuntu-22.04\\home\\cxj", WSL)).toEqual(
      { kind: "wsl", distro: "Ubuntu-22.04" },
    );
    expect(envForRoot("//wsl$/Debian/home/x", LOCAL_WORKSPACE)).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
  });

  it("treats drive letters and /mnt drives as this machine", () => {
    expect(envForRoot("C:\\Users\\x", WSL)).toEqual(LOCAL_WORKSPACE);
    expect(envForRoot("F:/VibeCoding_workspace/Verta", WSL)).toEqual(
      LOCAL_WORKSPACE,
    );
    expect(envForRoot("/mnt/c/Users/x", WSL)).toEqual(LOCAL_WORKSPACE);
  });

  it("keeps the distro it already had for a bare Linux path", () => {
    expect(envForRoot("/home/cxj", WSL)).toEqual(WSL);
    // /mnt/wsl 是 WSL 内部的挂载点，不是 Windows 盘，所以不算本机。
    expect(envForRoot("/mnt/wsl", WSL)).toEqual(WSL);
  });

  it("uses the remembered distro when a Linux path arrives without one", () => {
    expect(envForRoot("/home/cxj", LOCAL_WORKSPACE, "Debian")).toEqual({
      kind: "wsl",
      distro: "Debian",
    });
  });

  it("never guesses: an unreadable root leaves the environment alone", () => {
    expect(envForRoot("/home/cxj", LOCAL_WORKSPACE)).toEqual(LOCAL_WORKSPACE);
    expect(envForRoot("", WSL)).toEqual(WSL);
    expect(envForRoot(null, WSL)).toEqual(WSL);
    expect(envForRoot(undefined, LOCAL_WORKSPACE)).toEqual(LOCAL_WORKSPACE);
    expect(envForRoot("relative/dir", WSL)).toEqual(WSL);
  });
});