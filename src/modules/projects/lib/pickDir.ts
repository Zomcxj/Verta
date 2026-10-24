/**
 * Let the user pick a project directory with the system's own dialog.
 *
 * The dialog plugin loads on demand, only when the picker is actually opened, so it stays
 * out of the startup graph. The dialog starts in the user's home directory; when even that
 * does not resolve the system decides. A cancelled dialog is a null, not an error.
 */
export async function pickProjectDir(title: string): Promise<string | null> {
  const [{ open }, path] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/path"),
  ]);

  let defaultPath: string | undefined;
  try {
    defaultPath = await path.homeDir();
  } catch {
    defaultPath = undefined;
  }

  const picked = await open({
    directory: true,
    multiple: false,
    title,
    defaultPath,
  });
  return typeof picked === "string" ? picked : null;
}
