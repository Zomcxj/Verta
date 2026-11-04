// Does the webview accept the URL the app builds for a local picture?
//
// The failure this guards, reported from the file list: opening a picture showed "could not read
// this image" and its path underneath. The app builds that URL with `convertFileSrc`, which on this
// platform answers `http://asset.localhost/<path>`, and the page's own policy allowed
// `https://asset.localhost` - so the request was refused before it reached the disk, and every
// picture, video, audio and PDF preview was affected the same way.
//
// So: find a real picture under the workspace, build its URL the way the editor does, and load it.
// A pass here is the mechanism working; the editor's own pane uses nothing else.
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return { ok: false, why: "no __TAURI_INTERNALS__" };
  const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp)$/i;

  const dir = await invoke("workspace_current_dir");
  let entries = [];
  try {
    entries = (await invoke("fs_read_dir", { path: dir, showHidden: false })) ?? [];
  } catch (error) {
    return { ok: false, dir, why: `读不了这个目录：${String(error)}` };
  }
  const name = entries
    .map((entry) => (typeof entry === "string" ? entry : (entry?.name ?? "")))
    .find((entry) => IMAGE.test(entry));
  if (!name) {
    return {
      ok: false,
      dir,
      why: "工作目录里没有图片，这条探针没法判",
      entries: entries.length,
    };
  }

  const separator = dir.includes("\\") ? "\\" : "/";
  const path = `${dir.replace(/[\\/]+$/, "")}${separator}${name}`;
  const src = window.__TAURI_INTERNALS__.convertFileSrc(path);
  const loaded = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ loaded: true, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () =>
      resolve({ loaded: false, why: "webview 拒绝了这个 URL（策略还是挡住了？）" });
    img.src = src;
  });
  return { ok: loaded.loaded, dir, name, src, ...loaded };
})();
