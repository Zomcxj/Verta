// Acceptance for the terminal's cell pitch: the glyph spacing is the font's, and the pane width
// never changes it.
//
// The renderer draws into a canvas the backing store keeps bigger than the grid on purpose
// (it reuses a nearby bigger canvas instead of reallocating the swapchain on every resize
// step). Nothing may tie the cell pitch to that canvas, or letter spacing and row height would
// follow the pane size as a divider is dragged. The check is a measurement of drawn pixels:
// a ruler of "|" strokes is written to the terminal's PTY (the app's own pty_write call, the
// same one the input path uses), the ruler is located in a screenshot, and the spacing of its
// strokes is measured. It runs once with the sidebar shown and once hidden, so the two pane
// widths are compared.
//
// Two things make that measurement robust, and both were learned from the ruler landing next to a
// shell prompt:
//   - the ruler is written long enough to wrap at least once, because the continuation row carries
//     only strokes (the prompt is on the row the typing started on) and the row height is small;
//   - the row is chosen by which row has the most *equally spaced* strokes, not by which row has the
//     most contrast. A shell prompt is high contrast and unevenly spaced, so a contrast rule picks
//     the prompt; the ruler's ~columns strokes at one pitch beat it on uniformity by a wide margin.
//
// The ruler line is cleared with Ctrl+C before the script returns. The shell it writes to is the
// terminal tab, which is found by looking for a mounted terminal surface rather than by its label,
// and the tab that was active is restored at the end.
//
// Usage: node scripts/dev/probes/terminal-cell-pitch.mjs [--port=9222] [--shots=<dir>]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback;
const SHOTS = arg("shots", null);

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) =>
    reject(new Error(String(e.message ?? e))),
  );
});
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(40);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};
const rectOf = (expression) =>
  evaluate(
    `(() => { const n = ${expression}; if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }; })()`,
  );

const SURFACE_STATE = `JSON.stringify((() => {
  const sessions = window.__vertaTerm ? window.__vertaTerm().ghosttySessions : [];
  const live = sessions.find((s) => s.visible && s.surface);
  const canvas = document.querySelector('canvas');
  const r = canvas && canvas.getBoundingClientRect();
  return {
    cols: live && live.surface.cols,
    rows: live && live.surface.rows,
    pty: live && live.pty,
    canvasWidth: canvas && canvas.width,
    canvasHeight: canvas && canvas.height,
    rect: r && { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
  };
})())`;

// The same call the input path makes: raw bytes plus the session in a header.
const writePty = (text) =>
  evaluate(`(async () => {
    const sessions = window.__vertaTerm().ghosttySessions;
    const target = sessions.find((s) => s.visible && s.pty) || sessions.find((s) => s.pty);
    if (!target) throw new Error('no terminal session with a PTY');
    const bytes = new TextEncoder().encode(${JSON.stringify(text)});
    await window.__TAURI_INTERNALS__.invoke('pty_write', bytes, {
      headers: { 'x-pty-id': String(target.pty) },
    });
    return 'ok';
  })()`);

// In-page measurement of one screenshot. Every row with ink is scored by how many of its stroke gaps
// share one width, and the best-scoring row wins: the ruler is one pitch repeated, a prompt is not.
const INSTALL_ANALYSER = [
  "window.__vertaCellPitch = async (b64, region) => {",
  "  const img = new Image();",
  "  img.src = 'data:image/png;base64,' + b64;",
  "  await img.decode();",
  "  const c = document.createElement('canvas');",
  "  c.width = img.width; c.height = img.height;",
  "  const ctx = c.getContext('2d', { willReadFrequently: true });",
  "  ctx.drawImage(img, 0, 0);",
  "  // The canvas can extend past the window, so clip the region to the screenshot.",
  "  const cx = Math.max(0, Math.min(region.x, img.width - 1));",
  "  const cy = Math.max(0, Math.min(region.y, img.height - 1));",
  "  const w = Math.max(1, Math.min(region.w, img.width - cx));",
  "  const h = Math.max(1, Math.min(region.h, img.height - cy));",
  "  const d = ctx.getImageData(cx, cy, w, h).data;",
  "  const MIN_INK = 40;",
  "  const lum = (i) => (d[i] + d[i + 1] + d[i + 2]) / 3;",
  "  const range = (from, to, at) => { let lo = 255, hi = 0; for (let i = from; i < to; i += 1) { const v = lum(at(i)); if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; };",
  "  // Row contrast, not brightness: a glass theme's vertical gradient is not text.",
  "  const rowRange = new Float64Array(h);",
  "  for (let y = 0; y < h; y += 1) rowRange[y] = range(0, w, (x) => (y * w + x) * 4);",
  "  let rowMax = 0; for (const v of rowRange) if (v > rowMax) rowMax = v;",
  "  if (!rowMax) return { reason: 'the region has no contrast at all' };",
  "  const scoreRow = (row) => {",
  "    const y0 = Math.max(0, row - 6), y1 = Math.min(h, row + 7);",
  "    const ink = new Float64Array(w);",
  "    for (let x = 0; x < w; x += 1) ink[x] = range(y0, y1, (y) => (y * w + x) * 4);",
  "    let max = 0; for (const v of ink) if (v > max) max = v;",
  "    // A row whose columns barely vary is background, not text: a glass theme's vertical gradient",
  "    // has pixel-level noise, and that noise is *perfectly* evenly spaced, so it would win a",
  "    // uniformity contest against any glyph. MIN_INK is the floor for calling a column inked.",
  "    if (max < MIN_INK) return null;",
  "    const peaks = [];",
  "    for (let x = 1; x < w - 1; x += 1) {",
  "      if (ink[x] >= ink[x - 1] && ink[x] > ink[x + 1] && ink[x] > max * 0.45) {",
  "        let num = 0, den = 0;",
  "        for (let k = -2; k <= 2; k += 1) { const v = ink[x + k] || 0; num += (x + k) * v; den += v; }",
  "        const centre = den > 0 ? num / den : x;",
  "        if (!peaks.length || centre - peaks[peaks.length - 1] > 3) peaks.push(centre);",
  "      }",
  "    }",
  "    const gaps = [];",
  "    for (let i = 1; i < peaks.length; i += 1) gaps.push(peaks[i] - peaks[i - 1]);",
  "    const STEP = 0.25;",
  "    const bins = new Map();",
  "    for (const gap of gaps) { const bin = Math.round(gap / STEP); bins.set(bin, (bins.get(bin) || 0) + 1); }",
  "    let bestBin = null, bestCount = 0;",
  "    for (const [bin, count] of bins) if (count > bestCount) { bestCount = count; bestBin = bin; }",
  "    const modal = gaps.filter((gap) => Math.abs(gap / STEP - bestBin) <= 2);",
  "    return {",
  "      textRow: cy + row,",
  "      contrast: Math.round(rowRange[row]),",
  "      strokes: peaks.length,",
  "      uniformGaps: bestCount,",
  "      pitch: modal.length ? modal.reduce((a, b) => a + b, 0) / modal.length : null,",
  "      topBins: [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([bin, count]) => ({ gap: bin * STEP, count })),",
  "      spread: modal.length ? Math.max(...modal) - Math.min(...modal) : null,",
  "    };",
  "  };",
  "  const scored = [];",
  "  for (let y = 0; y < h; y += 1) {",
  "    if (rowRange[y] < rowMax * 0.3) continue;",
  "    const scored1 = scoreRow(y);",
  "    if (scored1) scored.push(scored1);",
  "  }",
  "  if (!scored.length) return { reason: 'no row with ink', rowMax };",
  "  // Uniformity first, then stroke count: the ruler is a long run of equal gaps, and the wrapped",
  "  // continuation row carries nothing else.",
  "  scored.sort((a, b) => b.uniformGaps - a.uniformGaps || b.strokes - a.strokes);",
  "  const best = scored[0];",
  "  return { ...best, candidates: scored.length, runnerUp: scored[1] ? { uniformGaps: scored[1].uniformGaps, strokes: scored[1].strokes, contrast: scored[1].contrast } : null };",
  "};",
].join("\n");

const state = async () => JSON.parse(await evaluate(SURFACE_STATE));

const tabsOf = async () =>
  JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('[role=tablist] [data-tab-id]')].map((n) => { const r = n.getBoundingClientRect(); return { label: (n.innerText || '').trim().slice(0, 24), active: n.getAttribute('data-tab-active') === 'true', cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) }; }))`,
    ),
  );

const measure = async (label, shotsName) => {
  const before = await state();
  const columns = before.cols ?? 0;
  // Long enough to wrap: the row the typing starts on carries the prompt, the continuation row does
  // not, and that continuation row is what the search below finds.
  const strokes = Math.max(80, columns * 2);
  await writePty("\n");
  await sleep(400);
  await writePty("|".repeat(strokes));
  await sleep(1200);
  const surface = await state();
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await evaluate(INSTALL_ANALYSER);
  if (SHOTS) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      `${SHOTS}/${shotsName}.png`,
      Buffer.from(shot.data, "base64"),
    );
  }
  // The pane's own box, so the ruler's row is inside the region whatever the canvas size is.
  const pane = await rectOf("document.querySelector('canvas').parentElement");
  const region = {
    x: Math.round(pane.x) + 2,
    y: Math.round(pane.y) + 2,
    w: Math.round(pane.w) - 4,
    h: Math.round(pane.h) - 4,
  };
  const pitch = await evaluate(
    `window.__vertaCellPitch(${JSON.stringify(shot.data)}, ${JSON.stringify(region)})`,
  );
  await writePty("\u0003");
  await sleep(400);
  const perColumn = surface.cols ? surface.canvasWidth / surface.cols : null;
  report[label] = {
    ...surface,
    rulerStrokes: strokes,
    canvasPerColumn: perColumn,
    measured: pitch,
  };
  console.log(
    `${label}: cols=${surface.cols} canvas/${surface.cols}=${perColumn?.toFixed(3)} px  measured pitch=${pitch.pitch?.toFixed(3)} px (${pitch.uniformGaps} uniform gaps over ${pitch.candidates ?? 0} rows, row ${pitch.textRow})`,
  );
  return pitch;
};

try {
  const tabs = await tabsOf();
  const previousTab = tabs.find((t) => t.active)?.label ?? null;
  let surface = await state();

  // A terminal tab is one whose pane mounts a terminal surface, so each tab is tried until one has a
  // grid. Naming the tab is not an option: its title is the shell's cwd.
  for (const tab of tabs) {
    if (surface.cols) break;
    await clickAt(tab.cx, tab.cy);
    await sleep(2000);
    surface = await state();
  }
  if (!surface.cols) fail("没有终端标签页可切换，先开一个终端标签页");
  report.activeTab = previousTab;

  const narrow = await measure("narrow", "cell-pitch-narrow");
  const toggle = await rectOf(
    "[...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '显示/隐藏侧栏')",
  );
  if (!toggle) fail("没找到侧栏开关");
  await clickAt(toggle.cx, toggle.cy);
  await sleep(2500);
  const wide = await measure("wide", "cell-pitch-wide");
  await clickAt(toggle.cx, toggle.cy);
  await sleep(1500);

  if (narrow.pitch === null || wide.pitch === null) {
    fail(`没量到笔画间距：${JSON.stringify({ narrow, wide })}`);
  }
  for (const [label, measured] of [
    ["narrow", narrow],
    ["wide", wide],
  ]) {
    if (measured.uniformGaps < 20) {
      fail(
        `${label} 那行只找到 ${measured.uniformGaps} 个等距间隔（行 ${measured.textRow}，笔画 ${measured.strokes} 个），尺子没画全`,
      );
    }
  }
  // A cell is a whole number of device pixels.
  for (const [label, measured] of [
    ["narrow", narrow],
    ["wide", wide],
  ]) {
    const nearest = Math.round(measured.pitch);
    if (Math.abs(measured.pitch - nearest) > 0.15) {
      fail(`${label} 的间距 ${measured.pitch} 不是整数设备像素`);
    }
  }
  if (Math.abs(narrow.pitch - wide.pitch) > 0.25) {
    fail(
      `间距跟着窗格宽度变了：${narrow.pitch} -> ${wide.pitch}（画布每列是 ${report.narrow.canvasPerColumn} -> ${report.wide.canvasPerColumn}）`,
    );
  }

  report.ok = true;
  report.pitch = narrow.pitch;
  report.keptAcrossWidths = [narrow.pitch, wide.pitch];
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `PASS: 窗格从 ${report.narrow.cols} 列拉到 ${report.wide.cols} 列，间距都是 ${narrow.pitch.toFixed(3)} 设备像素`,
  );
  if (previousTab) {
    const back = (await tabsOf()).find((t) => t.label === previousTab);
    if (back && !back.active) await clickAt(back.cx, back.cy);
  }
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}
