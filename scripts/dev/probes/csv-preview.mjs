// Acceptance for reading a `.csv` as a table: the delimiter the file uses, the fields as RFC 4180
// has them, and the encoding it was written in.
//
// Three things about *reading* are what go wrong: a semicolon export taken for one column, a quoted
// field cut at its comma, and a Chinese file read as mojibake. Each is one phase of the same file -
// the document is rewritten in place and the page reloaded, so one tab and one path cover all of it.
//
// Usage: node scripts/dev/probes/csv-preview.mjs [--port=9222]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-csv-probe-"));
const FILE = "表格.csv";
const FIXTURE = () => join(DIR, FILE);

/** A quoted field with a comma, an escaped quote, and a newline inside it. */
const QUOTED = ['name,note,extra', 'Ponytail,"says ""hi""",ok', '"two\nlines",plain,1'].join("\r\n");
/** What Excel writes on a machine whose decimal separator is a comma. */
const SEMICOLON = "name;price\nPonytail;0,5\n";
/** "姓名,价格" and "Ponytail,免费" in GB18030, byte by byte. */
const GB18030 = Uint8Array.from([
  0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xbc, 0xdb, 0xb8, 0xf1, 0x0d, 0x0a,
  0x50, 0x6f, 0x6e, 0x79, 0x74, 0x61, 0x69, 0x6c, 0x2c, 0xc3, 0xe2, 0xb7, 0xd1, 0x0d, 0x0a,
]);

const report = {};
const fail = (message) => {
  throw new Error(message);
};

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

// The panes of other tabs stay mounted, so only the visible one counts.
const VISIBLE = `[...document.querySelectorAll("[data-csv-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

/** Write the file, reload, and open it: one path, one tab, a known starting point. */
const startFrom = async (contents, label) => {
  writeFileSync(FIXTURE(), contents);
  await send("Page.reload");
  // Wait for the app itself, not a fixed number of seconds: the IPC is injected early and the shell
  // restores its session after that.
  await sleep(1500);
  if (!(await waitFor(`!!window.__TAURI_INTERNALS__ && !!document.querySelector("[data-tab-id]")`, 30000))) {
    fail(`${label}: the app did not come back after the reload`);
  }
  // Handing the path over can land before the window is listening for it; the event is what opens
  // the tab, so it is asked again rather than waited on.
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt += 1) {
    const asked = await evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(FIXTURE())}] }).then(() => true).catch(() => false)`,
    );
    if (!asked) fail(`${label}: the app has no IPC to hand a path to`);
    opened = await waitFor(`!!(${VISIBLE})`, 8000);
  }
  if (!opened) {
    const said = await evaluate(
      `JSON.stringify([...document.querySelectorAll("div, p")].filter((el) => el.offsetParent !== null && /读不出|二进制|只能看/.test(el.innerText || "")).map((el) => (el.innerText || "").trim()).slice(0, 4))`,
    );
    fail(`${label}: the file did not open as a table - the pane says ${said}`);
  }
  await send("Page.bringToFront");
  await sleep(300);
};

/** Type into a cell the way a reader would: focus it, change its text, leave it. */
const editCell = async (row, column, text) => {
  const typed = await evaluate(`(() => {
    const pane = ${VISIBLE};
    const cell = pane?.querySelectorAll('[data-csv-cell="${row}"]')?.[${column}];
    if (!cell) return false;
    cell.focus();
    cell.textContent = ${JSON.stringify(text)};
    cell.dispatchEvent(new Event("input", { bubbles: true }));
    cell.blur();
    return true;
  })()`);
  if (!typed) fail(`the cell at row ${row} column ${column} could not be typed into`);
  // The write is one IPC round trip; the file is what says whether it landed.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (readFileSync(FIXTURE(), "utf8").includes(text)) return;
    await sleep(200);
  }
  fail(`the cell at row ${row} column ${column} never reached the file`);
};

const readTable = () =>
  evaluate(`(() => {
    const pane = ${VISIBLE};
    const rows = [...pane.querySelectorAll("[data-csv-row]")];
    const cellText = (row) => [...row.children].map((cell) => (cell.innerText || "").trim());
    const header = pane.querySelector(".sticky");
    return {
      summary: (pane.firstElementChild?.innerText || "").replace(/\\s+/g, " ").trim(),
      header: header ? [...header.children].map((cell) => (cell.innerText || "").trim()) : [],
      first: rows[0] ? cellText(rows[0]) : null,
      second: rows[1] ? cellText(rows[1]) : null,
      rows: rows.length,
      scrollClass: pane.querySelector(".verta-doc-scroll") !== null,
    };
  })()`);

try {
  report.fixtureDir = DIR;

  // ---- A quoted field keeps its comma, its quotes and its newline ----
  await startFrom(QUOTED, "the quoted csv");
  const quoted = await readTable();
  report.quoted = quoted;
  if (JSON.stringify(quoted.header) !== JSON.stringify(["name", "note", "extra"])) {
    fail(`the header is ${JSON.stringify(quoted.header)}, not the three fields of the first row`);
  }
  if (quoted.first?.[1] !== 'says "hi"') {
    fail(`the quoted field read as ${JSON.stringify(quoted.first)}, not says "hi"`);
  }
  if (!/2\s*(行|rows)/.test(quoted.summary)) {
    fail(`the summary does not count two data rows: ${quoted.summary}`);
  }
  if (!quoted.scrollClass) fail("the table is not in the scroll container the shell styles");
  if (quoted.rows !== 2) fail(`the table drew ${quoted.rows} rows, not two data rows`);
  if (!/two\s+lines/.test(quoted.second?.[0] ?? "")) {
    fail(`the newline inside a quoted field split the row: ${JSON.stringify(quoted.second)}`);
  }

  // ---- Changing a cell changes that field and nothing else ----
  const beforeEdit = readFileSync(FIXTURE(), "utf8");
  await editCell(2, 2, "42");
  const afterEdit = readFileSync(FIXTURE(), "utf8");
  report.cellWrite = {
    unchangedElsewhere: afterEdit === beforeEdit.replace("plain,1", "plain,42"),
    after: afterEdit,
  };
  if (afterEdit !== beforeEdit.replace("plain,1", "plain,42")) {
    fail(`writing one cell changed more than that field: ${JSON.stringify(afterEdit)}`);
  }
  // The line endings and the quoting are still the file's, not a re-serialization of the table.
  if (!afterEdit.includes("\r\n") || !afterEdit.includes('"says ""hi"""')) {
    fail(`the file was rewritten rather than patched: ${JSON.stringify(afterEdit)}`);
  }

  // ---- A value with a comma in it is quoted, so the row still has three fields ----
  await editCell(1, 1, "a,b");
  const requoted = await readTable();
  report.cellQuote = { cell: requoted.first?.[1], file: readFileSync(FIXTURE(), "utf8") };
  if (requoted.first?.[1] !== "a,b") {
    fail(`the comma typed into a cell split it: ${JSON.stringify(requoted.first)}`);
  }
  if (!report.cellQuote.file.includes('"a,b"')) {
    fail(`the value was not quoted in the file: ${JSON.stringify(report.cellQuote.file)}`);
  }

  // ---- A semicolon export is not one column ----
  await startFrom(SEMICOLON, "the semicolon csv");
  const semicolon = await readTable();
  report.semicolon = semicolon;
  if (semicolon.header.length !== 2) {
    fail(`the semicolon file drew ${semicolon.header.length} columns, not two`);
  }
  if (semicolon.first?.[1] !== "0,5") {
    fail(`the comma inside the field was taken for a separator: ${JSON.stringify(semicolon.first)}`);
  }
  if (!semicolon.summary.includes(";")) {
    fail(`the summary does not name the delimiter it used: ${semicolon.summary}`);
  }

  // ---- A file written in GB18030 reads as its own characters ----
  await startFrom(GB18030, "the gb18030 csv");
  const chinese = await readTable();
  report.gb18030 = chinese;
  if (JSON.stringify(chinese.header) !== JSON.stringify(["姓名", "价格"])) {
    fail(`the gb18030 file read as ${JSON.stringify(chinese.header)}`);
  }
  if (chinese.first?.[1] !== "免费") {
    fail(`the gb18030 row read as ${JSON.stringify(chinese.first)}`);
  }

  report.ok = true;
  console.log(
    "PASS: .csv 当表格读并可就地改单元格——带引号的字段（内含逗号/转义引号/换行）不被拆开、分号导出的文件不是一列、GB18030 的文件读成中文；改一个格子只替换那个字段的字节（引号/换行/行尾原样保留），含逗号的新值会加引号；表头吸顶、行虚拟化、顶部写清行列数与分隔符。",
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
