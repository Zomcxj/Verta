// Runs the REAL rule table against the live screens, so the answer is the engine's own verdict
// rather than a hand-written approximation. Uses the module the app already loaded, via the
// module registry the bundler exposes in dev.
(async () => {
  const tailOf = window.__vertaLeafScreenTail;
  if (typeof tailOf !== "function") return { why: "no hook" };
  // Vite serves modules by URL; import the rules directly so this is the same code the app runs.
  const rules = await import("/src/modules/terminal/lib/agentRules.ts");
  const state = await import("/src/modules/terminal/lib/agentState.ts");
  const out = [];
  for (const id of [5, 7, 23]) {
    let tail = null;
    try {
      tail = tailOf(id);
    } catch {
      continue;
    }
    if (!tail) continue;
    const family = rules.identifyAgent ? rules.identifyAgent(tail) : null;
    const table = family?.rules ?? rules.OPENCODE_RULES ?? null;
    if (!table) {
      out.push({ id, why: "no rule table exported", exports: Object.keys(rules).slice(0, 20) });
      continue;
    }
    const detection = state.evaluate(tail, table);
    out.push({
      id,
      tool: family?.tool ?? null,
      state: detection.state,
      rule: detection.rule,
      visibleTrailing: detection.visibleTrailing,
    });
  }
  return { out };
})();
