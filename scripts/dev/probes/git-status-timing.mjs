// Times the git_status command itself from the renderer, so the panel's 2-3 s can be split into
// "how long the back end takes" and "everything else".
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return { why: "no invoke" };
  const roots = ["F:/VibeCoding_workspace/Verta", "F:/VibeCoding_workspace/MemoPaws"];
  const out = [];
  for (const root of roots) {
    const started = performance.now();
    try {
      const status = await invoke("git_status", { repoRoot: root });
      out.push({
        root,
        ms: Math.round(performance.now() - started),
        changed: status?.changedFiles?.length ?? null,
      });
    } catch (error) {
      out.push({ root, error: String(error) });
    }
  }
  return out;
})();
