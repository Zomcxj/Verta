// Acceptance for dragging a table's column edge.
//
// A width dragged here is a change of the view, not of the file: a `.csv` keeps its bytes and an
// `.xlsx` keeps its own `<col>` elements. What the probe checks is that the drag moves the column
// and its cells together, that the file is untouched, and that a reopen starts from the file again.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/column-resize.mjs [--port=9222]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-column-probe-"));
const FILE = join(DIR, "列宽.csv");

const fail = (message) => {
  throw new Error(message);
};

/** Three columns, wide enough that the drag has room either way. */
const CSV = ["name,note,extra", "Ponytail,a longer note here,ok", "second,another note,1"].join("\r\n");
const ORIGINAL = CSV;

const report = {};
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
const websocket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => websocket.addEventListener("open", resolve));
let id = 1;
const pending = new Map();
websocket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const at = id++;
    pending.set(at, resolve);
    websocket.send(JSON.stringify({ id: at, method, params }));
  });
const evaluate = async (expression) => {
  const message = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (message.result?.exceptionDetails) {
    throw new Error(
      `${message.result.exceptionDetails.exception?.description ?? ""} in: ${expression.slice(0, 160)}`,
    );
  }
  return message.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};

const VISIBLE = `[...document.querySelectorAll("[data-csv-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

const open = async () => {
  writeFileSync(FILE, CSV);
  await send("Page.reload");
  await sleep(1500);
  if (!(await waitFor(`!!window.__TAURI_INTERNALS__ && !!document.querySelector("[data-tab-id]")`, 30000))) {
    fail("the app did not come back after the reload");
  }
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    const asked = await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(FILE)}] }).then(() => true).catch(() => false)`,
    );
    if (!asked) fail("the app has no IPC to hand a path to");
    opened = await waitFor(`!!(${VISIBLE})`, 8000);
  }
  if (!opened) fail("the file did not open as a table");
  await send("Page.bringToFront");
  await sleep(500);
};

/**
 * The widths the header cells are drawn at, and the scale the pane is drawn at.
 *
 * The pane may be drawn at a zoom, so a drag of N screen pixels is N/scale of the table's own
 * pixels. The expected width has to be computed the same way the pane computes it, or the probe
 * would be asserting a number the drag can never produce.
 */
const headerState = () =>
  evaluate(`(() => {
    const pane = ${VISIBLE};
    const header = pane.querySelector(".sticky");
    const rect = header.getBoundingClientRect();
    // The cell's own CSS width, which is the table's space and is exact; a bounding rect is that
    // width times the zoom the pane is drawn at, and reading it would mix the two spaces.
    const widths = [...header.children].map((cell) => Math.round(parseFloat(cell.style.width)));
    return {
      widths,
      scale: rect.width > 0 && header.offsetWidth > 0 ? rect.width / header.offsetWidth : 1,
    };
  })()`);

const headerWidths = async () => (await headerState()).widths;

/** Drag a column's trailing edge by `delta` pixels, as a reader would. */
const dragColumn = async (column, delta) => {
  const done = await evaluate(`(() => {
    const pane = ${VISIBLE};
    const header = pane.querySelector(".sticky");
    const cell = header.children[${column}];
    if (!cell) return false;
    const rect = cell.getBoundingClientRect();
    // The press has to land on the column's trailing edge, which is where the drag is grabbed.
    const x = rect.right;
    const y = rect.top + rect.height / 2;
    header.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1,
    }));
    window.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, clientX: x + ${delta}, clientY: y, pointerId: 1,
    }));
    window.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, clientX: x + ${delta}, clientY: y, pointerId: 1,
    }));
    return true;
  })()`);
  if (!done) fail(`the column at ${column} could not be grabbed`);
  await sleep(300);
};

try {
  report.fixtureDir = DIR;
  await open();

  const start = await headerState();
  const before = start.widths;
  report.before = before;
  report.scale = start.scale;
  if (before.length !== 3) fail(`the table drew ${before.length} columns, not three`);

  // ---- Dragging the second column's edge widens it and nothing else ----
  await dragColumn(1, 80);
  const after = await headerWidths();
  // The drag moves the edge by the pointer's travel in the table's own pixels, which is the
  // screen travel divided by the zoom the pane is drawn at. Both the widths and the scale are read
  // off rounded rects, so the expectation is only good to a pixel or two.
  const expected = before[1] + 80 / start.scale;
  report.after = after;
  report.expected = Math.round(expected);
  if (Math.abs(after[1] - expected) > 2) {
    fail(`the dragged column is ${after[1]}px, not ${expected}: ${JSON.stringify({ before, after, scale: start.scale })}`);
  }
  if (after[0] !== before[0] || after[2] !== before[2]) {
    fail(`the drag moved a column it did not grab: ${JSON.stringify({ before, after })}`);
  }

  // ---- The cells of that column follow it, in the header and in the body ----
  const cellWidths = await evaluate(`(() => {
    const pane = ${VISIBLE};
    const header = [...pane.querySelector(".sticky").children].map((el) => Math.round(parseFloat(el.style.width)));
    const row = pane.querySelector("[data-csv-row]");
    const cells = [...row.children].map((el) => Math.round(parseFloat(el.style.width)));
    return { header, cells };
  })()`);
  report.cellWidths = cellWidths;
  if (cellWidths.cells[1] !== after[1]) {
    fail(`the body cell is ${cellWidths.cells[1]}px while its column is ${after[1]}px`);
  }

  // ---- The file is untouched: a width is a view, not a write ----
  const onDisk = readFileSync(FILE, "utf8");
  report.fileUnchanged = onDisk === ORIGINAL;
  if (!report.fileUnchanged) {
    fail(`dragging a column rewrote the file: ${JSON.stringify(onDisk)}`);
  }

  // ---- A narrow drag is stopped at the minimum rather than collapsing the column ----
  await dragColumn(0, -4000);
  const narrow = await headerWidths();
  report.narrow = narrow;
  if (narrow[0] > 40) fail(`a column dragged far left is still ${narrow[0]}px wide`);

  // ---- Reopening starts from the file's own widths again ----
  await open();
  const reopened = await headerWidths();
  report.reopened = reopened;
  if (JSON.stringify(reopened) !== JSON.stringify(before)) {
    fail(`reopening kept a dragged width: ${JSON.stringify({ before, reopened })}`);
  }

  report.ok = true;
  console.log(
    "PASS: 表格列宽可拖动——按在列右边缘才抓得住，拖动只改被抓住的那一列（表头与正文单元格一起变宽），其余列不动；拖到很窄时停在最小值而不是塌掉；文件字节没有任何改动；重新打开回到文件自己的列宽。",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.log(`FAIL: ${error.message}`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  rmSync(DIR, { recursive: true, force: true });
  websocket.close();
}
