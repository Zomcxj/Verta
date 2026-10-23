import type { WireRepoPermissionPayload } from "@/lib/native";
import type { MessageKey } from "@/modules/i18n";

/**
 * Whether the write buttons show.
 *
 * **Unqueried states and failed lookups (gh missing / logged out / error) all return
 * true**: the buttons stay rendered, and GitHub rejects the click with its message
 * passed through. Hiding them instead would cut off a user who could have acted, with
 * no way to tell "no permission" from "could not check".
 */
export function canWrite(payload: WireRepoPermissionPayload | null): boolean {
  return payload ? payload.canWrite : true;
}

/**
 * Key for the "this repo is read-only for you" sentence; null when there is nothing
 * to say.
 *
 * The hint only appears once the backend has **confirmed** read-only. It stays quiet
 * when the check fails: the buttons are still there, and a hint would suggest they are
 * unclickable.
 */
export function readOnlyHintKey(
  payload: WireRepoPermissionPayload | null,
): MessageKey | null {
  if (payload?.kind !== "ready") return null;
  return payload.canWrite ? null : "remotes.permission.readOnly";
}
