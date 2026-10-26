/**
 * Just the part of a tap this module reads.
 *
 * Structural rather than the plugin's own `ActionPerformed`: the plugin's shape carries a dozen
 * Android-only fields, and a payload that reaches this app from the shell is a plain object.
 */
export type NotificationTap = {
  readonly actionId: string;
  readonly notification?: {
    readonly extra?: Record<string, unknown>;
  } | null;
};

/**
 * The session a click on a system notification is about, or `null` when the click says nothing
 * usable.
 *
 * A click only comes back as a "tap" on the notification itself - a button on it is its own
 * action, and nothing here acts on one. The session rides in the payload that was stored with
 * the notification, and is read strictly: the payload crosses a JSON boundary on its way to
 * the shell and back, and a session id that came back as anything but a number is not one.
 * Reading a number out of it anyway ("12" being fine, but so would `null` become `0`) would
 * send the user to a session nobody named.
 */
export function tappedPty(action: NotificationTap): number | null {
  if (action.actionId !== "tap") return null;
  const ptyId = action.notification?.extra?.ptyId;
  if (typeof ptyId !== "number" || !Number.isFinite(ptyId)) return null;
  return ptyId;
}
