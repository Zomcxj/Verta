/**
 * 让用户选下载目录，默认落在系统的下载文件夹。
 *
 * 对话框插件按需加载：只在下一次真的点「下载」时才进启动图之外的那一块。
 * 拿不到下载目录时退回主目录，两者都拿不到就让系统自己决定。
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
