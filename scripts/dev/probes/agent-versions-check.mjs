// Is the version-check command present in the running binary, and does it answer with every family
// of row the bell can draw?
//
// Run against a running window (dev or a compiled build):
//   node scripts/dev/webview-eval.mjs scripts/dev/probes/agent-versions-check.mjs --match=http://tauri.localhost/
//
// The families are: the two tools themselves, pi's npm extensions, pi's git packages (a checkout,
// compared by commit rather than by version) and opencode's plugin packages. A family with nothing
// installed contributes nothing - the question here is that the ones this machine has are listed,
// each with the tool it belongs to (the row's icon) and the comparison its row is to be read with.
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return { ok: false, why: "no __TAURI_INTERNALS__" };
  const started = performance.now();
  try {
    const result = await invoke("agent_versions_check");
    const components = result?.components ?? [];
    const family = (id) =>
      id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
    const count = (name) => components.filter((c) => family(c.id) === name).length;
    return {
      ok: true,
      ms: Math.round(performance.now() - started),
      components: components.map((c) => ({
        id: c.id,
        name: c.name,
        agent: c.agent,
        current: c.current,
        latest: c.latest,
        error: c.error,
        compare: c.compare,
      })),
      // A family of zero is a machine that has none of that kind, which is a different thing from a
      // row that failed; the counts say which of the two it is.
      families: {
        opencode: count("opencode"),
        pi: count("pi"),
        "pi-extension": count("pi-extension"),
        "pi-git": count("pi-git"),
        "opencode-plugin": count("opencode-plugin"),
      },
      // Every row must say how to read its two values and which tool it belongs to, or the bell
      // draws it without an icon.
      rowsWithoutCompare: components.filter((c) => !c.compare).map((c) => c.id),
      rowsWithoutAgent: components.filter((c) => !c.agent).map((c) => c.id),
      revisions: components
        .filter((c) => c.compare === "revision")
        .map((c) => ({
          id: c.id,
          current: c.current,
          latest: c.latest,
          // True when the checkout is behind the remote, which is what the bell counts.
          behind: Boolean(c.current && c.latest && c.current !== c.latest),
        })),
      // The rows the bell's badge counts, exactly as the renderer computes it: a released version
      // behind the published one, or a commit that is not the remote's.
      updatable: components
        .filter((c) => {
          if (!c.current || !c.latest) return false;
          if (c.compare === "revision") return c.current !== c.latest;
          const a = c.current.split(".").map(Number);
          const b = c.latest.split(".").map(Number);
          if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
          for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
            if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
          }
          return false;
        })
        .map((c) => `${c.name} ${c.current} → ${c.latest}`),
      errors: components.filter((c) => c.error).map((c) => `${c.id}: ${c.error}`),
    };
  } catch (error) {
    return {
      ok: false,
      ms: Math.round(performance.now() - started),
      error: String(error),
    };
  }
})();
