// Is the version-check command present in the running binary, and does it answer?
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return { ok: false, why: "no __TAURI_INTERNALS__" };
  const started = performance.now();
  try {
    const result = await invoke("agent_versions_check");
    return {
      ok: true,
      ms: Math.round(performance.now() - started),
      components: (result?.components ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        current: c.current,
        latest: c.latest,
        error: c.error,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: String(error),
    };
  }
})();
