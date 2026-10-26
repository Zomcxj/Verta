// Do the renderer's timers keep their cadence when the window is hidden in the tray?
//
// This is the one measurement the notifications plan rests on. The judge that turns a
// screen into "working / waiting on you / done" runs on a `setInterval` in the renderer, and
// the plan promises a notification within a couple of seconds of an agent finishing - while
// the user is somewhere else with Verta minimised to the tray. Chromium throttles timers in
// a page it considers hidden (and throttles them much harder after a few minutes), and a
// WebView2 is a Chromium: if the cadence collapses, the notification has to be driven from
// Rust instead, and the plan changes shape.
//
// So this records the heartbeat rather than reasoning about it: a `setInterval` that stamps
// itself, the document's visibility, and - alongside the timer - what the app's own judge has
// in the store at that moment. Timers and the judge are the two things that have to survive
// being hidden, and the second one is the one the user actually feels.
//
// Nothing here changes the app: it is a recorder bolted onto the running page, and the
// hidden window is brought back by `--stage=show` before anything else is done.
//
// Usage:
//   node scripts/dev/probes/renderer-throttle.mjs --stage=start
//   ... let it run, hidden or not ...
//   node scripts/dev/probes/renderer-throttle.mjs --stage=read
//   node scripts/dev/probes/renderer-throttle.mjs --stage=hide
//   node scripts/dev/probes/renderer-throttle.mjs --stage=show
//   node scripts/dev/probes/renderer-throttle.mjs --stage=stop
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const stage = arg("stage") ?? "read";

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (q) {
    pending.delete(m.id);
    q(m);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result.result.value;
};

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

const report = { stage };
try {
  await sleep(200);

  if (stage === "start") {
    report.installed = await pageEval(`
      ${MODULES}
      if (window.__beat) return "already";
      const beat = { log: [], marks: [], ticker: null, saw: null };
      // Painting is the other half of "is the page alive": a hidden window stops presenting
      // frames even if its timers keep their cadence, and the notification path has to know
      // which of the two it depends on.
      let frames = 0;
      const step = () => {
        frames += 1;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      beat.ticker = setInterval(() => {
        // Read the dot the app itself draws, not a module instance: a probe that imports
        // the module graph can end up holding a second copy of the store (its own module
        // URL) and then sees nothing the app wrote. The DOM is the app's own output.
        const chip = document.querySelector('[role=tab][data-tab-active="true"] [data-agent-state]');
        const chips = [...document.querySelectorAll("[role=tab] [data-agent-state]")].map((d) => d.getAttribute("data-agent-state"));
        beat.log.push({
          t: Math.round(performance.now()),
          wall: Date.now(),
          vis: document.visibilityState,
          focus: document.hasFocus(),
          // The app's own answer to "is anyone looking at this window?" - the attribute
          // globals.css pauses animations on. It is what the notification layer will
          // read, and it is fed by DOM focus/blur as well as Rust's focus event, so
          // whether hiding a window moves it is the fact this stage exists to measure.
          inactive: document.documentElement.hasAttribute("data-window-inactive"),
          dot: chip ? chip.getAttribute("data-agent-state") : null,
          dots: chips.length,
          frames,
        });
        if (beat.log.length > 20000) beat.log.splice(0, 10000);
      }, 250);
      window.__beat = beat;
      return "installed";
    `);
  }

  if (stage === "feed") {
    // Print a screen for the judge. The screens are pi's own, the ones its rules were
    // written from, and printing them is the cheapest honest way to produce one: what is
    // under test is whether the judge - a timer reading the terminal's model - keeps
    // running on a window nobody can see, and the dot the strip draws is what it looks
    // like from outside.
    const what = arg("what") ?? "working";
    const reuse = arg("leaf");
    const screens = {
      working: [
        "echo '── ⠋ Working ─────────────────────────────────────────────────────────'",
      ],
      blocked: [
        "echo '  Other (type your answer)'",
        "echo ' ↑↓ navigate  enter select  escape/ctrl+c cancel'",
      ],
    };
    const lines = screens[what];
    if (!lines) throw new Error(`未知的屏幕：${what}`);

    await send("Page.bringToFront");
    await sleep(200);
    let leaf = reuse === null ? null : Number(reuse);
    if (leaf === null) {
      const before = JSON.parse(
        await pageEval(`
          ${MODULES}
          const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
          return JSON.stringify({ leaf: visible ? visible.leafId : null });
        `),
      );
      // A fresh tab of this probe's own, so nothing of the user's is typed into.
      const keyboard = {
        key: "t",
        code: "KeyT",
        windowsVirtualKeyCode: 84,
        nativeVirtualKeyCode: 84,
        modifiers: 2,
      };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...keyboard, text: "" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...keyboard, text: "" });
      for (let i = 0; i < 30 && leaf === null; i += 1) {
        await sleep(250);
        const now = JSON.parse(
          await pageEval(`
            ${MODULES}
            const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
            return JSON.stringify({ leaf: visible ? visible.leafId : null });
          `),
        );
        if (now.leaf !== null && now.leaf !== before.leaf) leaf = now.leaf;
      }
      if (leaf === null) throw new Error("Ctrl+T 之后没看到新的终端叶子");
      // The terminal session only starts once the pane has been painted, so wait for the
      // pty before writing: writing into a leaf without one loses the command silently.
      for (let i = 0; i < 40; i += 1) {
        const pty = await pageEval(
          `${MODULES}
  return api.ptyIdForLeaf(${leaf});`,
        );
        if (pty !== null) break;
        await sleep(250);
      }
      report.pty = await pageEval(`${MODULES}
  return api.ptyIdForLeaf(${leaf});`);
      await sleep(800);
    }
    report.leaf = leaf;
    for (const line of lines) {
      await pageEval(
        `${MODULES}\n  return api.writeToSession(${leaf}, ${JSON.stringify(`${line}\r`)});`,
      );
      await sleep(600);
    }
    report.printed = lines;
    report.visibility = await pageEval(`return document.visibilityState;`);
    report.dotAfter = await pageEval(
      `const chip = document.querySelector('[role=tab][data-tab-active="true"] [data-agent-state]'); return chip ? chip.getAttribute("data-agent-state") : null;`,
    );
  }

  if (stage === "bye") {
    // Leave the tab by exiting its shell, which is what a person does: the tab then closes
    // itself and nothing of the probe's is left on the strip.
    const leaf = Number(arg("leaf"));
    if (!leaf) throw new Error("--leaf= 要给出要退出的终端");
    await pageEval(
      `${MODULES}\n  return api.writeToSession(${leaf}, ${JSON.stringify("exit\r")});`,
    );
    await sleep(1200);
    report.tabsLeft = await pageEval(
      `return JSON.stringify([...document.querySelectorAll("[role=tab]")].map((t) => (t.textContent || "").trim().slice(0, 18)));`,
    );
  }

  if (stage === "read") {
    report.summary = JSON.parse(
      await pageEval(`
        const beat = window.__beat;
        if (!beat) return JSON.stringify({ error: "not installed" });
        const log = beat.log;
        if (log.length === 0) return JSON.stringify({ ticks: 0 });
        const gaps = [];
        for (let i = 1; i < log.length; i += 1) gaps.push(log[i].t - log[i - 1].t);
        const sorted = [...gaps].sort((a, b) => a - b);
        const quantile = (q) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
        const byVis = {};
        for (let i = 1; i < log.length; i += 1) {
          const key = log[i].vis;
          byVis[key] = byVis[key] ?? { ticks: 0, sumGap: 0, maxGap: 0, frames: 0 };
          byVis[key].ticks += 1;
          byVis[key].sumGap += gaps[i - 1];
          byVis[key].maxGap = Math.max(byVis[key].maxGap, gaps[i - 1]);
          byVis[key].frames += Math.max(0, log[i].frames - log[i - 1].frames);
        }
        for (const key of Object.keys(byVis)) {
          byVis[key].medianGap = Math.round(byVis[key].sumGap / byVis[key].ticks);
          byVis[key].framesPerSecond = Number(
            (byVis[key].frames / (byVis[key].sumGap / 1000)).toFixed(1),
          );
        }
        const phases = [];
        let previous = null;
        for (const entry of log) {
          // inactive is part of the key, not just of the record: a transition that
          // changes only that field is exactly the one being looked for.
          const key = entry.dot + "|" + entry.vis + "|" + entry.focus + "|" + entry.inactive;
          if (key !== previous) {
            phases.push({
              wall: entry.wall,
              dot: entry.dot,
              vis: entry.vis,
              focus: entry.focus,
              inactive: entry.inactive,
            });
            previous = key;
          }
        }
        return JSON.stringify({
          ticks: log.length,
          firstWall: log[0].wall,
          lastWall: log[log.length - 1].wall,
          spanMs: log[log.length - 1].t - log[0].t,
          medianGapMs: quantile(0.5),
          p90GapMs: quantile(0.9),
          maxGapMs: sorted[sorted.length - 1],
          marks: beat.marks ?? [],
          byVisibility: byVis,
          phaseChanges: phases,
        });
      `),
    );
  }

  if (stage === "hide" || stage === "show") {
    // The tray path hides the window (Rust does it on a close with that preference on);
    // hiding it from here is the same thing for the renderer, without touching settings.
    report.window = await pageEval(`
      ${MODULES}
      const winUrl = urls.find((u) => u.includes("@tauri-apps_api_window"));
      const win = await import(winUrl);
      const w = win.getCurrentWindow();
      await w.${stage === "hide" ? "hide" : "show"}();
      // Hiding and showing are not the same as being on screen: Windows decides that, and a
      // window that another window covers is not painted at all. Read it back from Rust,
      // which is the side that knows, rather than trusting the call.
      const visible = await w.isVisible().catch(() => null);
      if ("${stage}" === "show") {
        // Raising the window matters as much as showing it: a window that another window
        // covers is not painted, and a pane that is not painted never starts its session,
        // so nothing under test would even exist.
        await w.setFocus().catch(() => {});
      }
      if (window.__beat) window.__beat.marks.push({ wall: Date.now(), what: "${stage}" });
      return JSON.stringify({ isVisible: visible });
    `);
    await sleep(500);
    report.visibilityAfter = await pageEval(`return document.visibilityState;`);
  }

  if (stage === "stop") {
    report.stopped = await pageEval(`
      if (window.__beat) {
        clearInterval(window.__beat.ticker);
        window.__beat = null;
        return "stopped";
      }
      return "was-not-running";
    `);
  }

  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();