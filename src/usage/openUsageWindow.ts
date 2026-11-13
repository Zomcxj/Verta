import { invoke } from "@tauri-apps/api/core";

/**
 * Opens the usage window, or brings the one already open forward.
 *
 * The window is kept alive when closed (hidden), so a second open does not rebuild the webview on
 * top of a read that already walks every store on the machine.
 */
export async function openUsageWindow(): Promise<void> {
  await invoke("open_usage_window");
}
