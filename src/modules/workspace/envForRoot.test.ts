import { describe, expect, it } from "vitest";
import { envForPath, envForRoot, LOCAL_WORKSPACE, type WorkspaceEnv } from "./env";

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
    // /mnt/wsl is a mount point inside WSL, not a Windows drive, so it is not this machine.
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

describe("envForPath", () => {
  it("answers from the path, not from whatever the store still says", () => {
    // The environment and the file tree's root land in two steps, so the store still holds the
    // old one for a moment: a drive-letter path must still count as this machine, or the file
    // tree would go looking for it inside the distro.
    expect(envForPath("C:/Users/x", WSL)).toEqual(LOCAL_WORKSPACE);
    expect(envForPath("\\\\wsl.localhost\\Ubuntu-22.04\\home\\cxj", LOCAL_WORKSPACE)).toEqual(
      { kind: "wsl", distro: "Ubuntu-22.04" },
    );
  });

  it("falls back to the given environment when the path cannot say", () => {
    expect(envForPath("/home/cxj", WSL)).toEqual(WSL);
    expect(envForPath("/home/cxj", LOCAL_WORKSPACE)).toEqual(LOCAL_WORKSPACE);
    expect(envForPath(null, WSL)).toEqual(WSL);
  });
});