import type { WireAuthStatusPayload } from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";

/**
 * 登录态在界面上该怎么显示。
 *
 * 纯函数：从 gh 的结果推出「登没登、账号是谁、要不要提示什么」，组件只管画。
 */
export type AuthView = {
  loggedIn: boolean;
  /** 账号名；没登录 / 读不到时是 null。 */
  account: string | null;
  host: string | null;
  /** gh 给的状态原话（`success` / `failed`）。 */
  state: string | null;
  /** token 从哪来（`keyring` 等）。token 本身永远不到界面上。 */
  tokenSource: string | null;
  gitProtocol: string | null;
  scopes: string[];
  /** 只在没装 gh / 没登录 / 读不动时给的一句提示键；正常时是 null。 */
  hintKey: MessageKey | null;
  /** 失败时 gh 的原话。 */
  detail: string | null;
};

const EMPTY: AuthView = {
  loggedIn: false,
  account: null,
  host: null,
  state: null,
  tokenSource: null,
  gitProtocol: null,
  scopes: [],
  hintKey: null,
  detail: null,
};

export function authView(payload: WireAuthStatusPayload | null): AuthView {
  // 还没查出来：别说成「没登录」，那会让人白点一次登录。
  if (!payload) return EMPTY;

  if (payload.kind === "ready") {
    return {
      loggedIn: true,
      account: payload.login,
      host: payload.host,
      state: payload.state,
      tokenSource: payload.tokenSource,
      gitProtocol: payload.gitProtocol,
      scopes: payload.scopes,
      hintKey: null,
      detail: null,
    };
  }

  const hintKey: MessageKey =
    payload.kind === "none"
      ? "remotes.auth.notLoggedIn"
      : payload.kind === "notInstalled"
        ? "remotes.auth.notInstalled"
        : "remotes.auth.error";

  return {
    ...EMPTY,
    // `none` 是查清楚了的「没登」，没有原话；另外两种带上 gh 的原话。
    hintKey,
    detail: payload.kind === "none" ? null : payload.error,
  };
}

/** 这批授权里有没有某一项（不分大小写，顺手去掉空格）。 */
export function hasScope(scopes: string[], scope: string): boolean {
  const wanted = scope.trim().toLowerCase();
  return scopes.some((item) => item.trim().toLowerCase() === wanted);
}

/**
 * 要不要提示「缺 delete_repo 授权」。
 *
 * 拿不到 scopes（空数组）时也提示：这是建议去补一条授权，不是结论；补了也没坏处。
 */
export function needsDeleteScope(scopes: string[]): boolean {
  return !hasScope(scopes, "delete_repo");
}

/**
 * 粘贴的 token 在本地能不能过；不能过时给个理由。
 *
 * 和 Rust 侧 `auth::token_problem` 同一套规则（这边是为了即时反馈，不用等一次往返）：
 * 前后空白是粘贴常态先去掉，中间的空白、空串、短得不可能的拦下；真伪交给 gh。
 */
export function tokenProblem(token: string): "empty" | "space" | "short" | null {
  const trimmed = token.trim();
  if (!trimmed) return "empty";
  if (trimmed.split(/\s+/).length > 1) return "space";
  if (trimmed.length < 20) return "short";
  return null;
}
