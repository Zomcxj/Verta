import { describe, expect, it } from "vitest";

import type { WireAuthStatusPayload } from "@/lib/native";
import { authView, hasScope, needsDeleteScope, tokenProblem } from "./auth";

const payload = (
  over: Partial<WireAuthStatusPayload>,
): WireAuthStatusPayload => ({
  kind: "ready",
  host: "github.com",
  login: "Zomcxj",
  state: "success",
  active: true,
  tokenSource: "keyring",
  gitProtocol: "https",
  scopes: ["repo", "read:org", "gist"],
  error: null,
  ...over,
});

describe("authView", () => {
  it("还没查出来时只说「在读」，别先喊没登录", () => {
    const view = authView(null);
    expect(view.loggedIn).toBe(false);
    expect(view.account).toBeNull();
    expect(view.hintKey).toBeNull();
    expect(view.detail).toBeNull();
  });

  it("登着就报账号、host、令牌来源与协议", () => {
    const view = authView(payload({}));
    expect(view.loggedIn).toBe(true);
    expect(view.account).toBe("Zomcxj");
    expect(view.host).toBe("github.com");
    expect(view.state).toBe("success");
    expect(view.tokenSource).toBe("keyring");
    expect(view.gitProtocol).toBe("https");
    expect(view.scopes).toEqual(["repo", "read:org", "gist"]);
    expect(view.hintKey).toBeNull();
    expect(view.detail).toBeNull();
  });

  it("一个 host 都没登：说清楚是「没登录」而不是「读不动」", () => {
    const view = authView(
      payload({
        kind: "none",
        host: null,
        login: null,
        state: null,
        active: false,
        tokenSource: null,
        gitProtocol: null,
        scopes: [],
      }),
    );
    expect(view.loggedIn).toBe(false);
    expect(view.account).toBeNull();
    expect(view.hintKey).toBe("remotes.auth.notLoggedIn");
    expect(view.detail).toBeNull();
  });

  it("没装 gh 与查不动分开说，并把原话带上", () => {
    const missing = authView(
      payload({ kind: "notInstalled", login: null, error: "找不到 gh 命令" }),
    );
    expect(missing.hintKey).toBe("remotes.auth.notInstalled");
    expect(missing.detail).toBe("找不到 gh 命令");
    expect(missing.loggedIn).toBe(false);

    const broken = authView(
      payload({ kind: "error", login: null, error: "gh 返回的登录态无法解析" }),
    );
    expect(broken.hintKey).toBe("remotes.auth.error");
    expect(broken.detail).toBe("gh 返回的登录态无法解析");
  });
});

describe("hasScope", () => {
  it("不分大小写、不在乎空格", () => {
    expect(hasScope(["repo", " delete_repo "], "delete_repo")).toBe(true);
    expect(hasScope(["repo"], "DELETE_REPO")).toBe(false);
  });
});

describe("needsDeleteScope", () => {
  it("没有 delete_repo 授权时提示去补", () => {
    expect(needsDeleteScope(["repo", "gist"])).toBe(true);
  });

  it("有授权就别啰嗦", () => {
    expect(needsDeleteScope(["repo", "delete_repo"])).toBe(false);
  });

  it("拿不到 scopes（空数组）时也当作缺：提示是建议，不是结论", () => {
    expect(needsDeleteScope([])).toBe(true);
  });
});

describe("tokenProblem", () => {
  it("空、中间有空白、太短都拦下", () => {
    expect(tokenProblem("")).toBe("empty");
    expect(tokenProblem("   ")).toBe("empty");
    expect(tokenProblem("ghp_aaaa ghp_bbbb")).toBe("space");
    expect(tokenProblem("ghp_short")).toBe("short");
  });

  it("前后空白是粘贴常态，放行", () => {
    expect(tokenProblem("  ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n")).toBeNull();
  });

  it("看着像 PAT 的放行，真伪交给 gh 判断", () => {
    expect(tokenProblem("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
    expect(
      tokenProblem(
        "github_pat_11ABCDEFG0abcdefghijkl_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      ),
    ).toBeNull();
  });
});
