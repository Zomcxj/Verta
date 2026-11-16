// Are 极简, 浮雕 and 石板 actually three different-looking shapes?
//
// The report was "三者太像", and the honest way to answer it is to look at the same corner three times at
// the same magnification, with the numbers beside it. So this switches `shapeId` the way the picker does
// (the store, then the `verta://prefs-changed` event the store emits), reads the computed border and
// box-shadow of a real pane, and writes two magnified crops of that pane - its top-left corner and its
// bottom-left - into a directory, one set per shape.
//
// It changes nothing: the user's own shape is written back at the end, including "there was none".
//
// Usage:
//   pnpm tauri dev            (or a release build with --remote-debugging-port=9222)
//   node scripts/dev/probes/shape-edge-zoom.mjs [--port=9222] [--out=<dir>] [--scale=4]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const scale = Number(process.argv.find((a) => a.startsWith("--scale="))?.slice(8) ?? "4");
const outDir =
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
  `${process.env.TEMP ?? "."}\\verta-shape-zoom`;

const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(outDir, { recursive: true });

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(
  (t) =>
    t.type === "page" &&
    (t.url.endsWith("1420/") || t.url === "http://tauri.localhost/"),
);
if (!page) fail("no app page on the debug port: is the app running with --remote-debugging-port?");
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
const invoke = (command, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => (value === undefined ? null : value)).catch((e) => "ERR " + String(e))`,
  );

const STORE = "verta-settings.json";
const PREF_KEY = "shapeId";
const EVENT = "verta://prefs-changed";
const SHAPES = ["minimal", "emboss", "slab"];

let rid = null;
const openStore = async () => {
  const loaded = await invoke("plugin:store|load", { path: STORE });
  if (typeof loaded === "string" && loaded.startsWith("ERR")) {
    fail(`the settings store would not open: ${loaded}`);
  }
  rid = loaded;
};

/**
 * What the leftmost pane is painted with, and where its corners are on screen.
 *
 * The leftmost region is the one whose left edge is the window's own under 无界, so the corner crop
 * lands on the sheet's edge rather than on a seam between two panes.
 */
const readPane = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const wrap = document.querySelector('[data-shell]');
      const pane = wrap ? wrap.querySelector(".verta-pane") : null;
      if (!pane) return JSON.stringify({ found: false });
      const box = pane.getBoundingClientRect();
      const style = getComputedStyle(pane);
      return JSON.stringify({
        found: true,
        region: wrap.getAttribute("data-shell"),
        edgeLeft: wrap.hasAttribute("data-edge-left"),
        border: style.borderTopWidth + " " + style.borderTopColor,
        borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].join("/"),
        shadow: style.boxShadow,
        radius: style.borderTopLeftRadius,
        box: { x: box.x, y: box.y, w: box.width, h: box.height },
      });
    })()`),
  );

const writeShape = async (value) => {
  const written = await invoke("plugin:store|set", { rid, key: PREF_KEY, value });
  if (typeof written === "string" && written.startsWith("ERR")) {
    fail(`the settings store refused ${value}: ${written}`);
  }
  await invoke("plugin:event|emit", { event: EVENT, payload: { key: PREF_KEY, value } });
  await sleep(300);
};

/** One magnified crop of the page, in CSS pixels, saved next to the others. */
const shoot = async (name, clip, scaleOverride = scale) => {
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { ...clip, scale: scaleOverride },
  });
  const path = `${outDir}\\${name}.png`;
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  return path;
};

let original;
try {
  await openStore();
  const stored = await invoke("plugin:store|get", { rid, key: PREF_KEY });
  original = Array.isArray(stored) ? (stored[1] ? stored[0] : undefined) : stored;
  report.storedBefore = original ?? null;

  const shapes = [];
  const files = [];
  for (const shape of SHAPES) {
    await writeShape(shape);
    const pane = await readPane();
    if (!pane.found) fail("no pane on screen to measure");
    report[shape] = pane;
    shapes.push({ shape, pane });
    // A little past the corner, so the crop shows the window's own edge, the pane's edge and the
    // surface beside them: 26 CSS px is enough for a 3px band and the radius.
    const corner = 26;
    files.push(
      await shoot(`${shape}-top-left`, {
        x: Math.max(0, pane.box.x - 3),
        y: Math.max(0, pane.box.y - 3),
        width: corner,
        height: corner,
      }),
    );
    files.push(
      await shoot(`${shape}-bottom-left`, {
        x: Math.max(0, pane.box.x - 3),
        y: Math.max(0, pane.box.y + pane.box.h - corner + 3),
        width: corner,
        height: corner,
      }),
    );
    // And the same corner at 100%, because a difference that only exists at 4x is not a difference
    // anybody sees: this is the width a person actually looks at the shape with.
    files.push(
      await shoot(
        `${shape}-corner-100pct`,
        { x: 0, y: Math.max(0, pane.box.y - 22), width: 360, height: 96 },
        1,
      ),
    );
  }
  report.files = files;

  // Same surface, three recipes: the numbers have to differ, and by more than rounding.
  const style = (name) => shapes.find((entry) => entry.shape === name)?.pane;
  report.sameBox = new Set(shapes.map((entry) => JSON.stringify(entry.pane.box))).size === 1;
  report.shadowsDiffer = new Set(shapes.map((entry) => entry.pane.shadow)).size === 3;
  report.bordersDiffer =
    new Set(shapes.map((entry) => entry.pane.border)).size >= 2;

  console.log(`放大 ${scale}× 的角落在 ${outDir}`);
  for (const { shape, pane } of shapes) {
    console.log(
      `${shape.padEnd(8)} border ${pane.borderWidths.padEnd(20)} shadow ${pane.shadow.slice(0, 90)}`,
    );
  }
  console.log(
    `同一块区域（几何一致 ${report.sameBox ? "是" : "否"}）、三种阴影互不相同：${report.shadowsDiffer ? "是" : "否"}、边框至少两档：${report.bordersDiffer ? "是" : "否"}`,
  );
  console.log(JSON.stringify({ outDir, files }, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // The user's own shape, exactly as it was found - including "nothing was stored".
  if (rid !== null) {
    try {
      if (original === undefined) await invoke("plugin:store|delete", { rid, key: PREF_KEY });
      else await writeShape(original);
    } catch {
      // Called out in the report rather than swallowed: a probe that leaves the shape changed is worse
      // than one that fails.
      console.error("the stored shape could not be put back");
    }
  }
  socket.close();
}
