import { invoke, isTauri } from "@tauri-apps/api/core";
import { copyToClipboard } from "@/lib/clipboard";

export async function readTerminalClipboard(): Promise<string> {
  try {
    if (isTauri()) {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    }
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

export function writeTerminalClipboard(text: string): Promise<void> {
  return copyToClipboard(text);
}

/**
 * What a paste should put in the terminal: the clipboard's text, or, when the clipboard holds an
 * image instead, the path of that image written to a temporary PNG.
 *
 * The second half is what Windows Terminal does, and it is the only way a screenshot can reach an
 * agent: pasted bytes are text, so a picture has to travel as a path. Claude Code's Ctrl+V is exactly
 * that question ("attach the image on the clipboard"), and it can only be answered here.
 */
export async function pasteableTerminalText(): Promise<string> {
  const text = await readTerminalClipboard();
  if (text) return text;
  if (!isTauri()) return "";
  try {
    const path = await invoke<string | null>("clipboard_image_path");
    return path ?? "";
  } catch {
    // A clipboard with neither text nor image, or a write that failed: nothing to paste is not an
    // error to report, the same way an empty clipboard is not.
    return "";
  }
}
