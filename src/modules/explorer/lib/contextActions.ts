import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyToClipboard as writeClipboard } from "@/lib/clipboard";

/**
 * Copy a path or a name, best-effort: a caller that cannot copy says nothing rather than turning a
 * successful operation into an error.
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboard(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  if (path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}
