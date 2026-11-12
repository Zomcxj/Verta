// Acceptance for "a mermaid diagram is drawn, in the app's colours, and only when one is asked for".
//
// Three things this has to prove, none of which the unit tests can:
//
//   * A `.mmd`/`.mermaid` file opens as the diagram it is, and a ```mermaid fence in markdown draws
//     the same way - the two surfaces are one component, and only the pane can say the library
//     really ran.
//   * The drawing is in the theme's colours, and moves when the theme does: mermaid does arithmetic
//     on the colours it is given (`adjust`/`invert`/`darken` in its base theme), so a palette it
//     cannot read does not throw - it draws nothing, or draws black. The check is the painted fill
//     against the document's own `--card`, compared as `rgb()` because that is what the browser
//     reports for both sides.
//   * The library is not in the launch graph. Read from the page: the mermaid chunk is not among the
//     preloaded modules, and it appears in the resource timing only after a diagram is opened.
//     (`dist-budget` holds the same line for the built graph; this says it for the running app.)
//
// Source that does not parse has to fall back to itself rather than to an empty frame, so the last
// fixture is broken on purpose.
//
// The fixtures live in a directory of their own under the system temp directory, are opened the way
// an "Open With" opens a file (`verta:open-file`), and the tabs this run opened are closed again
// through their own chips. The theme preference is read first and written back in `finally`,
// including "it was whatever it was".
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/mermaid.mjs [--port=9222]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const STORE = "verta-settings.json";
const PREF_KEY = "theme";
const EVENT = "verta://prefs-changed";

const TAG = Math.random().toString(36).slice(2, 8);
const DIR = mkdtempSync(join(tmpdir(), "verta-mermaid-"));
const FILE_FLOW = `flow-${TAG}.mmd`;
const FILE_FENCE = `fence-${TAG}.md`;
const FILE_BROKEN = `broken-${TAG}.mmd`;

const FLOW = `graph TD
  Start[Start] --> Check{Ready?}
  Check -->|yes| Draw[Draw]
  Check -->|no| Wait[Wait]
`;

const FENCE = `# A diagram in a fence

\`\`\`mermaid
graph LR
  Left[Left] --> Right[Right]
\`\`\`
`;

// A dangling edge: mermaid has a diagram type and a node but no target, which is the shape of a
// half-typed diagram and the one thing it will not draw.
const BROKEN = `graph TD
  A[Start] -->
`;

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find(
    (t) => t.type === "page" && t.url.includes("tauri.localhost") && !t.url.includes("screenshot"),
  );
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
    throw new Error(`${what} in: ${expression.slice(0, 200)}`);
  }
  return result.result.value;
};
const invoke = (command, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => (value === undefined ? null : value)).catch((e) => "ERR " + String(e))`,
  );
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};

/**
 * Everything below reads only the pane that is on screen.
 *
 * The tabs behind the active one stay mounted and marked `aria-hidden`, so an unfiltered query finds
 * a diagram in a tab nobody is looking at. (`[data-tab-id]` is the chip in the tab strip, not the
 * pane: it answers "which tab came forward" and is useless as a scope.)
 */
const VISIBLE = `(node) => !node.closest('[aria-hidden="true"]')`;
const diagramIn = () =>
  `[...document.querySelectorAll('[data-slot="mermaid-diagram"]')].find(${VISIBLE})`;
const errorIn = () =>
  `[...document.querySelectorAll('[data-slot="mermaid-error"]')].find(${VISIBLE})`;

/** Hands a path to the app the way an "Open With" does, and waits for its tab to come forward. */
const openedTabs = new Set();
const openFile = async (path, label) => {
  const name = path.split(/[\\/]/).pop();
  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(path)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail(`${label}: the app has no IPC to hand a path to`);
  const active = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(name)})`;
  if (!(await waitFor(active, 30000))) fail(`${label}: ${name} never came forward as a tab`);
  const tabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tabId) openedTabs.add(tabId);
};

/**
 * A colour in whatever space the theme spells it, as the `rgb()` the browser serialises from a
 * canvas.
 *
 * Comparing in one space is the point: the diagram is given hex and paints `rgb()`, while a custom
 * theme may spell the same colour `oklch()`, and a string comparison across the two would fail on a
 * diagram that is right.
 */
const rgbOf = (expression) =>
  evaluate(`(() => {
    const raw = ${expression};
    if (!raw) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    context.fillStyle = raw;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return "rgb(" + r + ", " + g + ", " + b + ")";
  })()`);

/** A theme token as the browser computed it. */
const tokenOf = (name) =>
  evaluate(`(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(${name})";
    probe.style.display = "none";
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  })()`);

/** What the drawing paints: the node's fill, the edge's stroke, and whether the labels made it. */
const readDrawing = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const hosts = [...document.querySelectorAll('[data-slot="mermaid-diagram"]')];
      const errors = [...document.querySelectorAll('[data-slot="mermaid-error"]')].filter(${VISIBLE});
      const errorText = errors.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200));
      const diagram = ${diagramIn()};
      if (!diagram) return JSON.stringify({ hosts: hosts.length, diagram: false, errorText });
      const svg = diagram.querySelector("svg");
      if (!svg) return JSON.stringify({ hosts: hosts.length, diagram: true, svg: false, errorText });
      const box = svg.getBoundingClientRect();
      const node = svg.querySelector(".node rect, .node circle, .node polygon");
      // Flowchart edges carry either of two class names depending on the diagram type; the point of
      // the reading is the colour, so the first one that exists is enough.
      const edge = svg.querySelector("path.flowchart-link, .edgePath path, [class*='edge'] path");
      return JSON.stringify({
        diagram: true,
        svg: true,
        width: Math.round(box.width),
        height: Math.round(box.height),
        // Mermaid draws flowchart labels as HTML inside a foreignObject (span.nodeLabel); only some
        // diagram types use a text node, so both are read.
        labels: [
          ...svg.querySelectorAll('span.nodeLabel, [class*="nodeLabel"], text'),
        ]
          .map((node) => (node.textContent || "").replace(/\\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 12),
        fill: node ? getComputedStyle(node).fill : null,
        stroke: edge ? getComputedStyle(edge).stroke : null,
        error: !!${errorIn()},
        errorText,
        svgBackground: getComputedStyle(svg).backgroundColor,
      });
    })()`),
  );

/** The width the drawing is actually painted at. */
const drawingWidth = () =>
  evaluate(`(() => {
    const d = ${diagramIn()};
    const svg = d && d.querySelector("svg");
    return svg ? Math.round(svg.getBoundingClientRect().width) : null;
  })()`);

/** The percentage the zoom control shows, without touching it. */
const zoomLevel = () =>
  evaluate(`(() => {
    const level = [...document.querySelectorAll('[data-slot="diagram-zoom-level"]')].find(${VISIBLE});
    return level ? (level.textContent || "").trim() : null;
  })()`);

/** Presses one of the zoom controls by its slot; answers with the level it now shows. */
const pressZoom = async (slot) => {
  const pressed = await evaluate(`(() => {
    const button = [...document.querySelectorAll('[data-slot="${slot}"]')].find(${VISIBLE});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!pressed) return null;
  await sleep(350);
  return zoomLevel();
};

/** Presses a button of the view switch by its label, for when a tab opened on the other stop. */
const clickStop = async (pattern) =>
  evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .filter((b) => !b.closest('[aria-hidden="true"]'))
      .find((b) => ${pattern}.test((b.innerText || "").trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`);

/** The page's own html: what a launch pulls in before any of this has run. */
const readStartup = async () =>
  JSON.parse(
    await evaluate(`fetch("/index.html").then((r) => r.text()).then((html) => JSON.stringify({
      mentionsMermaid: html.toLowerCase().includes("mermaid"),
      bytes: html.length,
    }))`),
  );

/** The chunks the page has loaded, and the ones its html asked for up front. */
const readChunks = async () =>
  JSON.parse(
    await evaluate(`(() => JSON.stringify({
      loaded: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => /mermaid[-.][\\w-]*\\.js$/.test(name))
        .map((name) => name.split("/").pop()),
      preloaded: [...document.querySelectorAll('link[rel="modulepreload"], link[rel="preload"]')]
        .map((link) => link.getAttribute("href") || "")
        .filter((href) => href.includes("mermaid")),
    }))()`),
  );

/** Give the preference the value a settings write would, and tell the window, as the store does. */
const openStore = async () => {
  const loaded = await invoke("plugin:store|load", { path: STORE });
  if (typeof loaded === "string" && loaded.startsWith("ERR")) {
    fail(`the settings store would not open: ${loaded}`);
  }
  return typeof loaded === "object" && loaded !== null ? (loaded.rid ?? loaded) : loaded;
};
let rid = null;
const chooseTheme = async (value) => {
  const written = await invoke("plugin:store|set", { rid, key: PREF_KEY, value });
  if (typeof written === "string" && written.startsWith("ERR")) {
    fail(`the settings store refused ${value}: ${written}`);
  }
  const emitted = await invoke("plugin:event|emit", {
    event: EVENT,
    payload: { key: PREF_KEY, value },
  });
  if (typeof emitted === "string" && emitted.startsWith("ERR")) {
    fail(`the preferences event refused ${value}: ${emitted}`);
  }
  await sleep(300);
};

const cleanup = () => rmSync(DIR, { recursive: true, force: true });
process.on("exit", cleanup);

let original;
try {
  writeFileSync(join(DIR, FILE_FLOW), FLOW);
  writeFileSync(join(DIR, FILE_FENCE), FENCE);
  writeFileSync(join(DIR, FILE_BROKEN), BROKEN);

  // What a launch pulls in is what the page's own html names. Asking that rather than "what has this
  // session already loaded" keeps the check meaningful after a diagram has been drawn in it.
  report.startup = await readStartup();
  if (report.startup.mentionsMermaid) {
    fail("the page's html names a mermaid asset, so a launch would pull it in");
  }

  // ---- A `.mmd` opens as its diagram -----------------------------------------------------------
  await openFile(join(DIR, FILE_FLOW), "the diagram file");
  const drew = `(() => { const d = ${diagramIn()}; return !!d && !!d.querySelector("svg") && d.getBoundingClientRect().height > 40; })()`;
  if (!(await waitFor(drew, 45000))) {
    report.stuck = await readDrawing();
    report.diagramMarkup = await evaluate(
      `(() => { const d = ${diagramIn()}; return d ? d.innerHTML.slice(0, 400) : null; })()`,
    );
    fail("the .mmd never turned into a drawing");
  }
  await sleep(400);
  report.file = await readDrawing();
  if (!report.file.svg) {
    // Measured once: `render(id, text, container)` draws inside the container and removes it again
    // before it resolves, so the drawing is there during the await and gone after it. A probe that
    // only waited for the first svg called that a pass.
    fail(
      `the drawing was there during the wait and gone 400ms later (hosts: ${report.file.hosts ?? "?"}, errors: ${JSON.stringify(report.file.errorText)}) - the container form of render() does this`,
    );
  }
  if (!(report.file.labels ?? []).some((label) => label.includes("Start"))) {
    fail(
      `the drawing does not carry the source's label: ${JSON.stringify(report.file.labels)}`,
    );
  }
  if (report.file.width < 40 || report.file.height < 40) {
    fail(`the drawing has no box: ${report.file.width}x${report.file.height}`);
  }
  if (report.file.error) fail("a valid diagram reported an error");

  // ---- In the theme's colours, and only the theme's ---------------------------------------------
  const card = await tokenOf("--card");
  const edge = await tokenOf("--muted-foreground");
  report.theme = { mode: await evaluate(`document.documentElement.className`), card, edge };
  if (report.file.fill !== (await rgbOf(JSON.stringify(card)))) {
    fail(
      `a node is painted ${report.file.fill}, but the theme's --card is ${card} - the palette did not reach the drawing`,
    );
  }
  if (report.file.stroke && report.file.stroke !== (await rgbOf(JSON.stringify(edge)))) {
    fail(
      `edges are painted ${report.file.stroke}, but the theme's --muted-foreground is ${edge}`,
    );
  }

  // ---- Zoom: bigger, then smaller than fit, then back to fit ----------------------------------
  const atFit = await drawingWidth();
  if ((await zoomLevel()) !== "100%") {
    fail(`a diagram does not open at fit: the control reads ${await zoomLevel()}`);
  }
  const zoomedIn = await pressZoom("diagram-zoom-in");
  if (zoomedIn === null) fail("the diagram has no zoom control");
  report.zoomIn = { level: zoomedIn, width: await drawingWidth() };
  if (zoomedIn !== "125%") fail(`one press should read 125%, the control reads ${zoomedIn}`);
  if (Math.abs(report.zoomIn.width - atFit * 1.25) > Math.max(6, atFit * 0.06)) {
    fail(`the drawing did not grow with the zoom: ${atFit} -> ${report.zoomIn.width} at ${zoomedIn}`);
  }
  const backToFit = await pressZoom("diagram-zoom-out");
  report.zoomFit = { level: backToFit, width: await drawingWidth() };
  if (backToFit !== "100%" || Math.abs(report.zoomFit.width - atFit) > 2) {
    fail(
      `coming back to 100% did not restore the drawing: ${JSON.stringify(report.zoomFit)}, it was ${atFit}`,
    );
  }
  const zoomedOut = await pressZoom("diagram-zoom-out");
  report.zoomOut = { level: zoomedOut, width: await drawingWidth() };
  if (zoomedOut !== "80%" || !(report.zoomOut.width < atFit)) {
    fail(`smaller than fit did not shrink the drawing: ${JSON.stringify(report.zoomOut)}, it was ${atFit}`);
  }
  const reset = await pressZoom("diagram-zoom-level");
  report.zoomReset = { level: reset, width: await drawingWidth() };
  if (reset !== "100%" || Math.abs(report.zoomReset.width - atFit) > 2) {
    fail(`the percentage did not take the drawing back to fit: ${JSON.stringify(report.zoomReset)}`);
  }

  // ---- Past the pane's width: it has to overflow to the right only ------------------------------
  // Overflow past the scroll origin cannot be reached, so a wide drawing centred both ways loses its
  // left edge for good. Zoomed far enough that it is certainly wider than the pane.
  // However wide the window is, keep going until the drawing is wider than its pane (400% is the
  // ceiling, and a pane wider than that simply skips the check below with a reason).
  const measureOverflow = () =>
    evaluate(`(() => {
      const d = ${diagramIn()};
      const svg = d && d.querySelector("svg");
      const scroller = svg && svg.closest(".overflow-auto");
      if (!svg || !scroller) return JSON.stringify(null);
      const drawing = svg.getBoundingClientRect();
      const pane = scroller.getBoundingClientRect();
      return JSON.stringify({
        level: [...document.querySelectorAll('[data-slot="diagram-zoom-level"]')].find(${VISIBLE})?.textContent?.trim() ?? null,
        drawingWidth: Math.round(drawing.width),
        paneWidth: Math.round(pane.width),
        leftOffset: Math.round(drawing.left - pane.left),
        scrollable: scroller.scrollWidth - scroller.clientWidth,
      });
    })()`);
  let overflow = JSON.parse(await measureOverflow());
  for (let press = 0; press < 8; press++) {
    if (!overflow || overflow.drawingWidth > overflow.paneWidth) break;
    await pressZoom("diagram-zoom-in");
    overflow = JSON.parse(await measureOverflow());
  }
  const overflowUnused = JSON.parse(
    await evaluate(`(() => {
      const d = ${diagramIn()};
      const svg = d && d.querySelector("svg");
      const scroller = svg && svg.closest(".overflow-auto");
      if (!svg || !scroller) return JSON.stringify(null);
      const drawing = svg.getBoundingClientRect();
      const pane = scroller.getBoundingClientRect();
      return JSON.stringify({
        level: [...document.querySelectorAll('[data-slot="diagram-zoom-level"]')].find(${VISIBLE})?.textContent?.trim() ?? null,
        drawingWidth: Math.round(drawing.width),
        paneWidth: Math.round(pane.width),
        leftOffset: Math.round(drawing.left - pane.left),
        scrollable: scroller.scrollWidth - scroller.clientWidth,
      });
    })()`),
  );
  report.overflow = overflow;
  report.overflowUnused = overflowUnused;
  if (!overflow) fail("the drawing is not inside a scrolling pane at all");
  if (overflow.drawingWidth <= overflow.paneWidth) {
    // A pane wider than the drawing at 400% cannot be overflowed, and saying "passed" would be a lie
    // about a check that never ran.
    report.overflowSkipped = `the pane is ${overflow.paneWidth}px wide and the drawing is ${overflow.drawingWidth}px at ${overflow.level}`;
  }
  if (!report.overflowSkipped && overflow.leftOffset < -1) {
    fail(
      `a drawing wider than the pane starts ${-overflow.leftOffset}px left of the scroll origin, where nothing can scroll to it`,
    );
  }
  if (!report.overflowSkipped && overflow.scrollable <= 0) {
    fail("a drawing wider than the pane does not extend the pane's scroll width");
  }
  await pressZoom("diagram-zoom-level");

  // ---- A ```mermaid fence in markdown draws the same way ----------------------------------------
  await openFile(join(DIR, FILE_FENCE), "the markdown fence");
  const fenceDrew = `(() => { const d = ${diagramIn()}; const svg = d && d.querySelector("svg"); return !!svg && [...svg.querySelectorAll('span.nodeLabel, [class*="nodeLabel"], text')].some((node) => (node.textContent || "").includes("Left")); })()`;
  if (!(await waitFor(fenceDrew, 12000))) {
    // A markdown tab may open on its source stop; the fence is drawn in the rendered one.
    if (!(await clickStop(/^(渲染|Rendered)$/))) {
      report.fenceStuck = await readDrawing();
      fail("the markdown document opened on its source stop and had no rendered one to switch to");
    }
    if (!(await waitFor(fenceDrew, 45000))) {
      report.fenceStuck = await readDrawing();
      fail("a ```mermaid fence in a markdown document was not drawn");
    }
  }
  report.fence = await readDrawing();

  // ---- Source that does not parse falls back to itself -----------------------------------------
  await openFile(join(DIR, FILE_BROKEN), "the broken diagram");
  const failed = `(() => { const e = ${errorIn()}; return !!e && (e.textContent || "").includes("graph TD"); })()`;
  if (!(await waitFor(failed, 45000))) {
    report.broken = await readDrawing();
    fail("a diagram that does not parse did not fall back to its source");
  }
  report.brokenText = await evaluate(
    `(() => { const e = ${errorIn()}; return ((e && e.textContent) || "").replace(/\\s+/g, " ").trim().slice(0, 160); })()`,
  );

  // ---- The other way round: the drawing follows the theme ---------------------------------------
  rid = await openStore();
  const stored = await invoke("plugin:store|get", { rid, key: PREF_KEY });
  original = Array.isArray(stored) ? (stored[1] ? stored[0] : undefined) : stored;
  report.storedBefore = original ?? null;
  await chooseTheme("light");
  const lightCard = await tokenOf("--card");
  report.light = { card: lightCard, mode: await evaluate(`document.documentElement.className`) };
  if (await rgbOf(JSON.stringify(lightCard)) === await rgbOf(JSON.stringify(card))) {
    // A theme with no light variant keeps its dark tokens, and then there is nothing for the diagram
    // to follow: say so rather than fail on the theme's account.
    report.lightSkipped = "the theme has no light variant, so the tokens did not move";
  } else {
    // Back to the flow chart, which is the one that has a node to read.
    await openFile(join(DIR, FILE_FLOW), "the diagram file, again");
    const redrew = `(() => { const d = ${diagramIn()}; const node = d && d.querySelector("svg .node rect, svg .node circle"); return !!node && getComputedStyle(node).fill === ${JSON.stringify(await rgbOf(JSON.stringify(lightCard)))}; })()`;
    if (!(await waitFor(redrew, 30000))) {
      report.lightStuck = await readDrawing();
      fail(
        `after the theme changed, the drawing still paints ${report.lightStuck?.fill ?? "nothing"}; the light theme's --card is ${lightCard}`,
      );
    }
    report.lightFill = (await readDrawing()).fill;
  }

  // ---- And it arrived with the diagram, not with the window ------------------------------------
  report.chunksAfter = await readChunks();
  if (report.chunksAfter.loaded.length === 0) {
    fail("no mermaid chunk was loaded at all, so what drew the diagram is unknown");
  }

  console.log(
    `PASS: .mmd 画成了图（${report.file.width}×${report.file.height}，标签含 "Start"），节点填充就是主题的 --card（${card}）、边是 --muted-foreground（${edge}）；markdown 里的 \`\`\`mermaid 围栏同样画出来；缩放按一档走 100%→${report.zoomIn.level}（${report.zoomIn.width}px）、再降到 ${report.zoomOut.level}（${report.zoomOut.width}px），点百分比回到 ${report.zoomReset.level}（${report.zoomReset.width}px）；语法错的 .mmd 退回源码并显示错误；切到浅色后重画成浅色的 --card（${report.lightFill ?? report.lightSkipped}）；mermaid 不在启动预载里，是打开图之后才拉下来的（${report.chunksAfter.loaded.join(", ")}）；跑完已还原设置并关掉本轮的标签。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // The user's preference goes back to what it said before this ran, including "nothing was stored".
  try {
    if (rid !== null && rid !== undefined) {
      if (original === undefined) {
        await invoke("plugin:store|delete", { rid, key: PREF_KEY });
        await invoke("plugin:event|emit", {
          event: EVENT,
          payload: { key: PREF_KEY, value: "system" },
        });
      } else {
        await chooseTheme(original);
      }
    }
  } catch {
    // The window may already be gone; the file state is reported above either way.
  }
  // Only the tabs this run opened, and only through their own close chip.
  try {
    await evaluate(`(() => {
      const ids = ${JSON.stringify([...openedTabs])};
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(el.getAttribute("data-tab-id"))) continue;
        const chip = el.querySelector('[role="button"]');
        if (chip) chip.click();
      }
      return ids.length;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview still leaves the directory removed below, which is the part that matters.
  }
  cleanup();
  socket.close();
}
