import type { WireAuthStatusPayload } from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";

/**
 * How the login state should be displayed.
 *
 * Pure function: it derives "logged in or not, which account, any hint to show"
 * from gh's result, and the component only renders it.
 */
export type AuthView = {
  loggedIn: boolean;
  /** Account name; null when logged out or unreadable. */
  account: string | null;
  host: string | null;
  /** gh's own state word (`success` / `failed`). */
  state: string | null;
  /** Where the token comes from (`keyring`, etc.). The token itself never reaches the UI. */
  tokenSource: string | null;
  gitProtocol: string | null;
  scopes: string[];
  /** Hint key shown only when gh is missing / logged out / unreadable; null when fine. */
  hintKey: MessageKey | null;
  /** gh's own message on failure. */
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
  // Not queried yet: do not claim "logged out", which would send the user through a
  // pointless login.
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
    // `none` is a confirmed "logged out" with no message of its own; the other two
    // carry gh's words.
    hintKey,
    detail: payload.kind === "none" ? null : payload.error,
  };
}

/** Whether this scope set includes one entry (case-insensitive, whitespace trimmed). */
export function hasScope(scopes: string[], scope: string): boolean {
  const wanted = scope.trim().toLowerCase();
  return scopes.some((item) => item.trim().toLowerCase() === wanted);
}

/**
 * Whether to hint that the delete_repo scope is missing.
 *
 * It also hints when scopes are unavailable (empty array): this suggests granting
 * one more scope rather than asserting a fact, and granting it costs nothing.
 */
export function needsDeleteScope(scopes: string[]): boolean {
  return !hasScope(scopes, "delete_repo");
}

/**
 * Local check for a pasted token; returns the reason when it fails.
 *
 * Same rules as `auth::token_problem` on the Rust side (here for instant feedback
 * without a round trip): trim the leading/trailing whitespace that pasting brings,
 * then reject inner whitespace, empty strings, and impossibly short values. Whether
 * the token is genuine is gh's call.
 */
export function tokenProblem(token: string): "empty" | "space" | "short" | null {
  const trimmed = token.trim();
  if (!trimmed) return "empty";
  if (trimmed.split(/\s+/).length > 1) return "space";
  if (trimmed.length < 20) return "short";
  return null;
}
