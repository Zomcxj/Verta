// The session-start transition draws the *agent's* icon, not the app's logo.
//
// The claim is visual and it is about which mark is on screen while a session opens, so the check is
// what was actually rendered: the mark drawn inside the transition compared with the mark the same
// session's row carries in the list (both come from `AgentIcon` for the same tool, so a logo where an
// icon belongs, or a different agent's icon, shows up as inequality). A screenshot of the terminal
// area with the layer up is kept beside the numbers, because "which picture was in the middle" is not
// something a DOM read can be trusted to have answered on its own.
//
// Nothing is modified: no preference is touched, no session is written, and the tab and the agent
// process this run started are closed and ended again.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/session-opening-agent-icon.mjs [--port=9222] [--tool=claude] [--label=run]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const tool = process.argv.find((a) => a.startsWith("--tool="))?.slice(7) ?? "claude";
const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? "run";
const dir = join(tmpdir(), `verta-opening-icon-${label}`);
mkdirSync(dir, { recursive: true });

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) => reject(new Error(String(e?.message ?? e))));
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} in: ${expression.slice(0, 160)}`);
  }
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) return true;
    await sleep(200);
  }
  return false;
};

/** Processes that are this agent resuming this session, by executable as well as command line. */
const resumeProcesses = (id) => {
  const command = `(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe','node.exe','pi.exe','opencode.exe') -and $_.CommandLine -like '*${id}*' } | ForEach-Object { \"$($_.ProcessId)\" }) -join \" \"`;
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
};

/**
 * The mark a rendered icon is, with everything that is not the mark taken out.
 *
 * The drawing rather than the element: the list row's icon carries the list's own classes and the
 * transition's carries its own, and comparing the two as markup would fail on exactly the thing that
 * is supposed to differ. What has to be equal is the picture - its view box and its geometry.
 */
const MARK = `
  const mark = (svg) => svg === null ? null : JSON.stringify({
    viewBox: svg.getAttribute("viewBox"),
    strokeWidth: svg.getAttribute("stroke-width"),
    shapes: [...svg.querySelectorAll("path, circle, rect, polygon")].map((node) => [
      node.tagName.toLowerCase(),
      node.getAttribute("d") ?? node.getAttribute("points") ?? "",
    ]),
  });
`;

/** What the transition is drawing right now, or null when it is not up. */
const SAMPLE = `
  ${MARK}
  const overlay = document.querySelector("[data-session-opening]");
  if (!overlay) return JSON.stringify(null);
  const core = overlay.querySelector(".verta-session-opening-core");
  const svg = core ? core.querySelector("svg") : null;
  const img = core ? core.querySelector("img") : null;
  const box = (node) => {
    const r = node.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  // The layout size, not the painted one: the card is drawn inside the punch animation, which starts
  // at scale(0.62) and overshoots before it settles. A sample taken in the first frames therefore
  // measures 40x40 for a 64x64 card and 21x21 for a 34px mark - the animation, not the design.
  const layout = (node) => ({ w: node.clientWidth, h: node.clientHeight });
  return JSON.stringify({
    variant: overlay.getAttribute("data-session-opening-variant"),
    core: core ? layout(core) : null,
    // The mark is meant to float on the pane: a card behind it reads as a button that is not there.
    plate: core
      ? {
          background: getComputedStyle(core).backgroundColor,
          shadow: getComputedStyle(core).boxShadow,
        }
      : null,
    mark: mark(svg),
    icon: svg ? {
      css: Math.round(Number.parseFloat(getComputedStyle(svg).width)),
      painted: box(svg),
      color: getComputedStyle(svg).color,
    } : null,
    logo: img ? { src: img.getAttribute("src"), painted: box(img) } : null,
  });
`;

/** The tabs that were open before the press, so `finally` can close exactly what this run added. */
let tabsBefore = [];
let started = [];

try {
  const titles = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()))`,
    ),
  );
  report.openTabs = titles;

  // A session that is not already open: pressing a row whose tab exists only brings that tab forward,
  // and no transition is drawn for a terminal that is already there.
  const listed = JSON.parse(
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("agent_sessions_list", { tool: ${JSON.stringify(tool)}, distro: null }).then((p) => JSON.stringify(p.sessions.map((s) => ({ id: s.id, title: s.title, cwd: s.cwd })))).catch((error) => JSON.stringify({ error: String(error) }))`,
    ),
  );
  if (listed.error) fail(`agent_sessions_list(${tool}) failed: ${listed.error}`);
  report.sessions = listed.length;
  const candidate = listed.find((session) => !titles.includes(session.title));
  if (!candidate) {
    fail(
      `every ${tool} session is already open as a tab (${titles.join(", ")}), and a terminal that is already there is not covered`,
    );
  }
  report.pressing = candidate;

  // The list has to be on screen for a row to be pressed.
  const rowsShown = await evaluate(
    `document.querySelectorAll("[data-session-id]").length > 0`,
  );
  if (!rowsShown) {
    const pressed = await evaluate(`(() => {
      const rail = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.getAttribute("aria-label") || "").trim()));
      if (!rail) return false;
      rail.click();
      return true;
    })()`);
    if (!pressed) fail("no sessions rail button to open the list with");
    await sleep(1500);
  }
  const row = `document.querySelector('[data-session-id=${JSON.stringify(candidate.id)}]')`;
  if (!(await waitFor(row, 20000))) {
    fail(`the list has no row for ${candidate.id} (${candidate.title})`);
  }

  // The mark this session's own row carries: the reference the transition has to agree with. The
  // checkbox before the title draws a tick of its own, so the row's icons are taken without it - and
  // exactly one is expected, because a row with two marks would make the comparison a guess.
  report.rowMark = JSON.parse(
    await evaluate(`(() => {
      ${MARK}
      const row = ${row};
      const icons = [...row.querySelectorAll("svg")].filter((svg) => !svg.closest("[data-checked]"));
      return JSON.stringify({
        count: icons.length,
        mark: icons.length === 1 ? mark(icons[0]) : null,
        color: icons.length === 1 ? getComputedStyle(icons[0]).color : null,
      });
    })()`),
  );
  if (report.rowMark.count !== 1 || report.rowMark.mark === null) {
    // Also the case of an agent whose row draws the app's logo: then there is nothing to compare, and
    // saying "passed" would be a lie about a check that never ran.
    fail(
      `the row for ${candidate.id} carries ${report.rowMark.count} icons beside its checkbox, so there is no single mark to compare against`,
    );
  }

  // Sampled from before the press: the layer's first frames are the ones to read, and its animation
  // must not be mistaken for a mark that never settled.
  await evaluate(`(() => {
    // Reinstalled every run: the page keeps whatever a previous run left, and an old sampler's samples
    // are indistinguishable from this run's once they are in the same array.
    if (window.__iconProbe?.timer) clearInterval(window.__iconProbe.timer);
    window.__iconProbe = { samples: [], at: null };
    const tick = async () => {
      // The sampler returns JSON, so "the layer is not up" arrives as the string "null" - parsed
      // here rather than compared as text, or every frame before the layer appears counts as a
      // sample and the first one read is a null dressed up as one.
      const sample = JSON.parse(await (async () => { ${SAMPLE} })());
      if (sample === null) return;
      if (window.__iconProbe.samples.length === 0) window.__iconProbe.at = Date.now();
      window.__iconProbe.samples.push(sample);
    };
    window.__iconProbe.timer = setInterval(tick, 60);
    tick();
    return "installed";
  })()`);

  const tabIdsBefore = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id")))`,
    ),
  );
  // Recorded before the press, not after it succeded: a run that fails half-way still opened a tab,
  // and leaving it behind makes the next run unable to press that session at all.
  tabsBefore = tabIdsBefore;
  const pidsBefore = resumeProcesses(candidate.id);
  await evaluate(`(() => { const el = ${row}; el.scrollIntoView({ block: "center" }); el.click(); return true; })()`);

  // While it is up, and only while it is up: the layer is not on screen for long - the agent's own UI
  // takes it away, which is the whole point of it - so the picture is taken in the same loop as the
  // sampling rather than after it. A window that is not in front is not repainted; a synthesized move
  // keeps frames coming.
  const areaBox = JSON.parse(
    await evaluate(`(() => {
      const area = document.querySelector("[data-terminal-area]");
      if (!area) return JSON.stringify(null);
      const r = area.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    })()`),
  );
  report.shot = null;
  const deadline = Date.now() + 25000;
  let shots = 0;
  while (Date.now() < deadline) {
    const up = await evaluate(`!!document.querySelector("[data-session-opening]")`);
    const count = await evaluate(`window.__iconProbe.samples.length`);
    if (up && areaBox && areaBox.w > 0 && shots < 12) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: areaBox.x + 40 + shots,
        y: areaBox.y + 40,
        buttons: 0,
      });
      const shot = await send("Page.captureScreenshot", {
        format: "png",
        clip: { x: areaBox.x, y: areaBox.y, width: areaBox.w, height: areaBox.h, scale: 1 },
      });
      if (shot.data) {
        const file = join(dir, `transition-${String(shots).padStart(2, "0")}.png`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        report.shot = file;
        shots += 1;
      }
    }
    if (!up && count > 0) break;
    await sleep(120);
  }
  report.shots = shots;

  if (!(await evaluate(`window.__iconProbe.samples.length > 0`))) {
    const now = JSON.parse(await evaluate(`JSON.stringify({
      overlay: !!document.querySelector("[data-session-opening]"),
      transition: (document.querySelector("[data-session-opening-variant]") || {}).dataset ?? null,
      tabs: [...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()),
    })`));
    fail(
      `no transition was drawn for ${candidate.id} in 25s: ${JSON.stringify(now)} - with the animation set to "none" in Settings → Themes there is nothing to draw`,
    );
  }

  const samples = JSON.parse(await evaluate(`JSON.stringify(window.__iconProbe.samples)`));
  await evaluate(`clearInterval(window.__iconProbe.timer)`);
  report.samples = samples.length;
  report.first = samples[0];

  // ---- What the transition drew ----------------------------------------------------------------
  const drawn = samples.find((sample) => sample.mark !== null) ?? samples[0];
  report.drawn = drawn;
  if (drawn.logo !== null) {
    fail(
      `the transition drew the app's logo (/logo.png) while opening a ${tool} session, not the agent's own icon`,
    );
  }
  if (drawn.mark === null) {
    fail(`the transition drew no icon at all: ${JSON.stringify(drawn)}`);
  }
  if (drawn.mark !== report.rowMark.mark) {
    fail(
      `the transition's icon is not the one the session's own row carries: ${drawn.mark} against ${report.rowMark.mark}`,
    );
  }
  // The card and the mark inside it, by layout size: the icon is smaller than its card, big enough to
  // read as the point of the layer rather than as a decoration on it, and 34 is the number this was
  // designed at (a vector glyph fills its box, where the app's logo is a bitmap with padding of its
  // own, so the logo's 44 was not the same visual weight).
  if (!drawn.core || drawn.core.w !== 64 || drawn.core.h !== 64) {
    fail(`the icon's card is ${JSON.stringify(drawn.core)}, not the 64x64 the transition draws`);
  }
  if (!drawn.icon || drawn.icon.css !== 34) {
    fail(`the icon is drawn at ${JSON.stringify(drawn.icon?.css)}px, not the 34 the layer is designed at`);
  }
  // No card behind it: the icon sits on the pane like the animation around it.
  if (!drawn.plate || drawn.plate.background !== "rgba(0, 0, 0, 0)") {
    fail(
      `the mark is drawn on a card (${JSON.stringify(drawn.plate)}), not on the pane`,
    );
  }
  if (drawn.plate.shadow !== "none") {
    fail(`the mark's box paints a shadow: ${drawn.plate.shadow}`);
  }
  // And it is the foreground colour, unlike the muted one the list's rows use.
  if (drawn.icon.color === report.rowMark.color) {
    fail(
      `the transition's icon is drawn in the same muted colour as an ordinary list row (${drawn.icon.color})`,
    );
  }

  // ---- And the session did start behind it ------------------------------------------------------
  let alive = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(1500);
    alive = resumeProcesses(candidate.id).filter((pid) => !pidsBefore.includes(pid));
    if (alive.length > 0) break;
  }
  started = alive;
  report.started = alive;
  if (alive.length === 0) {
    fail(
      `no ${tool} process for ${candidate.id} appeared in 15s, so the transition was not covering a session start`,
    );
  }

  console.log(
    `PASS: 开会话的过渡层画的是 agent 自己的图标 —— ${tool} 会话「${candidate.title}」的图标（viewBox ${JSON.parse(drawn.mark).viewBox}）与它在会话行里的那个逐笔相同，盒子 ${drawn.core.w}×${drawn.core.h}（背景透明、无阴影）、图标布局 ${drawn.icon.css}px（开场动画第一帧的绘制尺寸是 ${drawn.icon.painted.w}px，属于 punch 的 0.62 缩放）、颜色 ${drawn.icon.color}（行里那个是淡的 ${report.rowMark.color}），没有 fallback 到 /logo.png；过渡层起来的同时 ${tool} 进程确实起来了（pid ${alive.join(", ")}）；截图 ${shots} 张，最后一张 ${report.shot ?? "没取到"}；跑完已关掉本轮开的标签并结束本轮起的进程。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  try {
    await evaluate(`(() => {
      if (window.__iconProbe?.timer) clearInterval(window.__iconProbe.timer);
      delete window.__iconProbe;
      return true;
    })()`);
  } catch {
    // A dead webview is not what this run is about.
  }
  try {
    // Everything that appeared since the press, closed again: this run opened it, and a session left
    // on screen is also a session the next run cannot open (a row whose tab exists is only brought
    // forward, with nothing to watch).
    report.closedTabs = JSON.parse(await evaluate(`(() => {
      const before = ${JSON.stringify(tabsBefore)};
      const opened = [...document.querySelectorAll("[data-tab-id]")]
        .map((el) => el.getAttribute("data-tab-id"))
        .filter((id) => !before.includes(id));
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!opened.includes(el.getAttribute("data-tab-id"))) continue;
        const chip =
          el.querySelector('[role="button"][aria-label]') ??
          el.querySelector('[role="button"][data-no-drag]:last-child');
        if (chip) chip.click();
      }
      return JSON.stringify(opened);
    })()`));
    await sleep(600);
  } catch {
    // A dead webview is not what this run is about.
  }
  try {
    if (started.length > 0) {
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Stop-Process -Id ${started.join(",")} -Force -ErrorAction SilentlyContinue`,
      ]);
    }
  } catch {
    // Already gone, which is the normal case: closing the terminal hangs up the shell.
  }
  socket.close();
}
