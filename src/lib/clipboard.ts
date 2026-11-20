import { isTauri } from "@tauri-apps/api/core";

/**
 * Put text on the system clipboard.
 *
 * `navigator.clipboard` is not the clipboard in this webview: `writeText` resolves and writes
 * nothing (measured - the OS clipboard still held the sentinel that was set before the call), or it
 * rejects with "Document is not focused", and `readText` is not a function at all. The Tauri plugin is
 * the path that reaches the OS clipboard, and the capability it needs is already declared
 * (`clipboard-manager:allow-write-text`).
 *
 * The browser fallback is only for the non-Tauri preview, which is the one place `navigator.clipboard`
 * is a real clipboard. `readTerminalClipboard` keeps the same two paths for reading.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  if (!navigator.clipboard) throw new Error("Clipboard is unavailable");
  await navigator.clipboard.writeText(text);
}
