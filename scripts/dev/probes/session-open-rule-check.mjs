// Re-evaluates the cover's own trace against both rules: the old one (bytes + silence + floor)
// and the new one (same, plus the launch line must be gone). Reports which ticks each would end
// on, so the fix can be judged from measurements instead of from the loop.
(async () => {
  const trace = window.__vertaOpenTrace ?? [];
  const ticks = trace.filter((entry) => entry.t !== undefined && !entry.exit);
  const exits = trace.filter((entry) => entry.exit);
  const fires = (rule) => ticks.filter(rule).map((tick) => tick.t);
  const oldRule = (x) => x.bytes >= 512 && x.silentFor >= 500 && x.t >= 1500;
  const newRule = (x) => oldRule(x) && !x.showsLaunch;
  return {
    tickCount: ticks.length,
    exits,
    oldRuleFiresAt: fires(oldRule),
    // Every tick where the old rule would have lifted while the command was still on screen.
    oldRuleFiresWithLaunchVisible: ticks
      .filter((x) => oldRule(x) && x.showsLaunch)
      .map((x) => ({ t: x.t, screenTail: (x.screenTail ?? "").slice(-90) })),
    newRuleFiresAt: fires(newRule),
    // The tick the code actually chose, and whether the command was still displayed there.
    actualExit: exits[exits.length - 1] ?? null,
  };
})();
