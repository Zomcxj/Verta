(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const out = [];
  for (const tool of ["opencode", "pi"]) {
    try {
      const r = await invoke("agent_sessions_list", { tool });
      out.push(`${tool}: ${r.sessions.length} 条`);
      for (const s of r.sessions) {
        const flags = [s.parentId ? `parent=${s.parentId.slice(0, 12)}` : "", s.cwd ? "" : "no-cwd"].filter(Boolean).join(" ");
        out.push(`   [${s.title.slice(0, 34)}] id=${s.id.slice(0, 20)} ${flags}`);
      }
      if (r.warnings.length) out.push(`   warnings: ${r.warnings.length}`);
    } catch (e) {
      out.push(`${tool} 失败: ${String(e)}`);
    }
  }
  return out.join("\n");
})();
