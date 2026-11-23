// Which renderer is drawing the terminal, and what does a mosaic image actually look like?
//
// opencode draws an attached picture as a grid of half-block characters: the cell's foreground
// paints the upper half and its background the lower half. That makes the picture's colour the
// cell's own foreground/background pair, and anything that rewrites a cell's ink rewrites the
// picture.
//
// Reported as "本项目的做法输出的图片显示不对", with a side-by-side against another terminal where the
// same picture came out as a photograph. The report is about what reaches the screen, so the probe
// reads the screen: the renderer's name, and then the contrast between each cell's two halves over
// the picture's own rectangle. A photograph's neighbouring rows are a percent or two apart; ink
// that has been pushed until it clears a floor piles up at exactly that floor instead.
//
// Nothing is typed. An opencode session is resumed from the list, the picture is drawn by the
// program, and the tab is closed again at the end.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/terminal-image-mosaic.mjs [--port=9222] [--session=<id>]
import { execFileSync } from "node:child_process";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const wanted = process.argv.find((a) => a.startsWith("--session="))?.slice(10) ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no page target for the main window: is the app running with --remote-debugging-port?");

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
const json = (expression) =>
  evaluate(`JSON.stringify(${expression})`).then((raw) => JSON.parse(raw));
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => !!(${expression}))()`)) return true;
    await sleep(200);
  }
  return false;
};

/**
 * The report, in the order it is needed.
 *
 * `data-terminal-backend` is what `TerminalPane` writes on its host element, so the renderer is read
 * off the DOM rather than inferred from a preference: the preference says what was asked for, the
 * attribute says what is drawing.
 */
const report = { renderer: null, mosaic: null, verdict: null };

const backends = await json(
  `[...new Set([...document.querySelectorAll("[data-terminal-backend]")].map((el) => el.getAttribute("data-terminal-backend")))]`,
);
report.renderer = { fromDom: backends };

// A canvas is where both renderers draw; its presence says a GPU surface is attached rather than a
// DOM fallback, which is the distinction that decides whether `readableInk` runs at all.
report.renderer.canvases = await json(
  `[...document.querySelectorAll("canvas")].map((c) => ({ w: c.width, h: c.height, cls: c.className }))`,
);

/**
 * The picture, read off the screen.
 *
 * A screenshot is taken of the terminal's own rectangle and analysed in the page, because the pixels
 * are the only evidence of what a cell's two halves were drawn as. `Page.captureScreenshot` answers
 * base64 PNG, which an ImageBitmap decodes without a second dependency.
 */
const rect = await evaluate(`(() => {
  const el = document.querySelector("[data-terminal-backend]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
if (!rect || rect.w < 40 || rect.h < 40) fail(`the terminal has no usable rectangle: ${JSON.stringify(rect)}`);
report.mosaic = { rect };

const shot = await send("Page.captureScreenshot", {
  format: "png",
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
});
if (!shot.data) fail("Page.captureScreenshot answered nothing");

/**
 * Contrast between each cell's two halves, and how many cells sit at a floor.
 *
 * The cell height is not assumed: the row pitch is measured from the picture itself as the most
 * common distance between two changes down a column, so a different font size does not silently
 * sample the wrong rows.
 */
report.mosaic.cells = await evaluate(`(async () => {
  // The PNG is decoded here rather than in the page: a \`data:\` fetch is refused by the app's own
  // CSP, and the bytes are already in this process.
  const png = ${JSON.stringify(shot.data)};
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const w = bitmap.width, h = bitmap.height;
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const lum = (c) => {
    const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => { const hi = Math.max(a, b), lo = Math.min(a, b); return (hi + 0.05) / (lo + 0.05); };

  // Row pitch: the commonest run length down a few columns.
  const runs = new Map();
  for (const x of [Math.floor(w * 0.3), Math.floor(w * 0.5), Math.floor(w * 0.7)]) {
    let prev = at(x, 0), start = 0;
    for (let y = 1; y < h; y += 1) {
      const c = at(x, y);
      if (c[0] !== prev[0] || c[1] !== prev[1] || c[2] !== prev[2]) {
        const len = y - start;
        if (len >= 4 && len <= 40) runs.set(len, (runs.get(len) ?? 0) + 1);
        prev = c; start = y;
      }
    }
  }
  const pitch = [...runs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  if (!pitch) return { error: "no row pitch found: the pane holds no mosaic" };

  // Each cell: the upper half's colour against the lower half's.
  const ratios = [];
  let extremes = 0, cells = 0;
  for (let y = 0; y + pitch <= h; y += pitch) {
    const top = Math.min(pitch - 1, Math.floor(pitch / 2) - 1);
    const bottom = Math.min(pitch - 1, Math.floor(pitch / 2) + 1);
    for (let x = Math.floor(w * 0.05); x < Math.floor(w * 0.95); x += pitch) {
      const a = at(x, y + top), b = at(x, y + bottom);
      ratios.push(ratio(lum(a), lum(b)));
      cells += 1;
      const pure = (c) => (c[0] > 250 && c[1] > 250 && c[2] > 250) || (c[0] < 5 && c[1] < 5 && c[2] < 5);
      if (pure(a) || pure(b)) extremes += 1;
    }
  }
  const share = (test) => ratios.filter(test).length / ratios.length;
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    pitch,
    cells,
    belowFifteen: share((r) => r < 1.5),
    atFloor: share((r) => r >= 4.45 && r <= 4.9),
    aboveFive: share((r) => r > 5),
    extremes: extremes / cells,
    median: sorted[Math.floor(sorted.length / 2)],
  };
})()`);

const cells = report.mosaic.cells;
if (cells.error) fail(cells.error);

/**
 * The verdict.
 *
 * A photograph's two halves are a percent or two apart, so a real picture has almost nothing at any
 * particular contrast. Ink pushed until it clears a floor piles up at that floor and nothing gets
 * past it, which is what `readableInk` does with `INK_FLOOR`. Both signs together are the finding;
 * either alone could be a coincidence of this picture.
 */
report.verdict =
  cells.atFloor > 0.15 && cells.aboveFive < 0.05
    ? "ink-pushed-to-a-floor"
    : cells.extremes > 0.5
      ? "halves-collapsed-to-black-or-white"
      : "looks-like-a-photograph";

console.log(JSON.stringify(report, null, 1));
socket.close();
