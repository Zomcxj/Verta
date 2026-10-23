/**
 * Let the user pick a download directory, defaulting to the system Downloads folder.
 *
 * The dialog plugin loads on demand, only when "download" is actually clicked, keeping
 * it out of the startup graph. When the Downloads folder is unavailable it falls back
 * to the home directory, and if neither resolves the system decides.
 */
export async function pickDownloadDir(title: string): Promise<string | null> {
  const [{ open }, path] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/path"),
  ]);

  let defaultPath: string | undefined;
  try {
    defaultPath = await path.downloadDir();
  } catch {
    try {
      defaultPath = await path.homeDir();
    } catch {
      defaultPath = undefined;
    }
  }

  const picked = await open({
    directory: true,
    multiple: false,
    title,
    defaultPath,
  });
  return typeof picked === "string" ? picked : null;
}
