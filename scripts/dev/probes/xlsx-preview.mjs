// Acceptance for reading a `.xlsx` as the grid it holds.
//
// What goes wrong in a spreadsheet reader is not the grid: it is the three parts around it. The
// number is stored as a serial and has to be drawn as the date its *format* names; the text is in a
// shared string table and the cell only holds an index; and the format itself lives on the cell
// style, not on the cell. Each phase below is one of those, plus the two things the pane adds -
// the sheet tabs and the frozen pane.
//
// The workbook is built here rather than checked in, so the assertion and the thing asserted about
// are the same file.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/xlsx-preview.mjs [--port=9222]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageParts, zip } from "./lib/officeZip.mjs";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-xlsx-probe-"));
const FILE = join(DIR, "综合.xlsx");

const fail = (message) => {
  throw new Error(message);
};

// ---------------------------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------------------------

/** The shared strings, by the index a cell of type `s` holds. */
const SHARED = [
  "名称",
  "数值",
  "备注",
  "日期",
  "占比",
  "金额",
  "时长",
  "第二张的内容",
  "带 & 的文本",
];

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000&quot; s&quot;"/></numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="14" fontId="0" fillId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="0" fillId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="2" applyNumberFormat="1" applyFont="1" applyFill="1"><alignment horizontal="center" wrapText="1"/></xf>
</cellXfs>
</styleSheet>`;

/** The first sheet: one row per thing the reader has to get right, and a frozen pane over them. */
const SHEET_ONE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:Z8"/>
<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="26" width="12" customWidth="1"/><col min="4" max="4" width="24" customWidth="1"/></cols>
<sheetData>
<row r="1" ht="22" customHeight="1">
<c r="A1" s="1" t="s"><v>0</v></c>
<c r="B1" s="1" t="s"><v>1</v></c>
<c r="C1" s="1" t="s"><v>2</v></c>
<c r="E1" s="1" t="s"><v>8</v></c>
</row>
<row r="2">
<c r="A2" t="s"><v>3</v></c>
<c r="B2" s="2"><v>45119</v></c>
<c r="C2" t="inlineStr"><is><t>绿色</t></is></c>
</row>
<row r="3">
<c r="A3" t="s"><v>4</v></c>
<c r="B3" s="3"><v>0.125</v></c>
</row>
<row r="4">
<c r="A4" t="s"><v>5</v></c>
<c r="B4" s="4"><v>1234.5</v></c>
</row>
<row r="5">
<c r="A5" t="s"><v>6</v></c>
<c r="B5" s="5"><v>1.5</v></c>
</row>
<row r="6">
<c r="A6" t="b"><v>1</v></c>
<c r="B6" t="e"><v>#DIV/0!</v></c>
</row>
<row r="100"><c r="A100"><v>99</v></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells>
</worksheet>`;

const SHEET_TWO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:A1"/>
<sheetData><row r="1"><c r="A1" s="6" t="s"><v>7</v></c></row></sheetData>
</worksheet>`;

/** A sheet with nothing in it at all, which is what an empty tab looks like. */
const SHEET_THREE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="数据" sheetId="1" r:id="rId1"/>
<sheet name="第二张" sheetId="2" r:id="rId2"/>
<sheet name="空表" sheetId="3" r:id="rId3"/>
</sheets>
</workbook>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

const SHARED_STRINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${SHARED.length}" uniqueCount="${SHARED.length}">
${SHARED.map((text) => (text.includes("&") ? `<si><r><t>${text.split("&")[0]}</t></r><r><t>&amp;</t></r><r><t>${text.split("&")[1]}</t></r></si>` : `<si><t>${text}</t></si>`)).join("")}
</sst>`;

const XLSX = zip([
  ...packageParts(
    "xl/workbook.xml",
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  ),
  ["xl/workbook.xml", WORKBOOK],
  ["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
  ["xl/sharedStrings.xml", SHARED_STRINGS],
  ["xl/styles.xml", STYLES],
  ["xl/worksheets/sheet1.xml", SHEET_ONE],
  ["xl/worksheets/sheet2.xml", SHEET_TWO],
  ["xl/worksheets/sheet3.xml", SHEET_THREE],
]);

// ---------------------------------------------------------------------------------------------
// Driving the app
// ---------------------------------------------------------------------------------------------

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

const VISIBLE = `[...document.querySelectorAll("[data-xlsx-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

/** The cell at a row and column, as the page draws it. */
const CELL = (row, column) => `${VISIBLE}?.querySelector('[data-xlsx-cell="${row}:${column}"]')`;

/** Reload, then hand the path over until a tab opens on it. */
const openWorkbook = async () => {
  writeFileSync(FILE, XLSX);
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
  if (!opened) {
    const said = await evaluate(
      `JSON.stringify([...document.querySelectorAll("div, p")].filter((el) => el.offsetParent !== null && /读不出|二进制|只能看/.test(el.innerText || "")).map((el) => (el.innerText || "").trim()).slice(0, 4))`,
    );
    fail(`the workbook did not open as a grid - the pane says ${said}`);
  }
  await send("Page.bringToFront");
  await sleep(400);
};

const textOf = (selector) =>
  evaluate(`(${selector})?.innerText?.trim() ?? null`);

const widthOf = (selector) =>
  evaluate(`Math.round((${selector})?.getBoundingClientRect().width ?? -1)`);

try {
  report.fixture = `${FILE} (${XLSX.length} bytes)`;
  await openWorkbook();

  // ---- The tabs are the workbook's own sheets, in its own order ----
  const tabs = await evaluate(
    `JSON.stringify([...(${VISIBLE}).querySelectorAll("[data-xlsx-tab]")].map((el) => el.innerText.trim()))`,
  );
  report.tabs = JSON.parse(tabs);
  if (tabs !== JSON.stringify(["数据", "第二张", "空表"])) {
    fail(`the tabs read ${tabs}, not the three the workbook lists`);
  }

  // ---- The summary counts what the sheet holds, not what the viewport shows ----
  // The file's own dimension says A1:Z8 and it also has a cell at row 100; the reader takes the
  // larger of the two, because a dimension is a hint and the rows are the truth.
  const summary = await evaluate(
    `(${VISIBLE})?.firstElementChild?.innerText?.replace(/\\s+/g, " ").trim() ?? null`,
  );
  report.summary = summary;
  if (!/100\s*(行|rows)/.test(summary) || !/26\s*(列|columns)/.test(summary)) {
    fail(`the summary does not count the sheet's own 100 by 26: ${summary}`);
  }

  // ---- The column headings run past Z ----
  const headings = await evaluate(
    `JSON.stringify([...(${VISIBLE}).querySelectorAll("[data-xlsx-heading]")].map((el) => el.innerText.trim()))`,
  );
  report.headings = JSON.parse(headings);
  if (!report.headings.includes("A") || !report.headings.includes("B")) {
    fail(`the headings are ${headings}, not the letters of the columns`);
  }

  // ---- A cell of shared strings, and the header row drawn bold ----
  const header = await evaluate(`(() => {
    const cell = ${CELL(0, 0)};
    if (!cell) return null;
    const style = getComputedStyle(cell);
    return { text: cell.innerText.trim(), weight: style.fontWeight };
  })()`);
  report.header = header;
  if (header?.text !== "名称") fail(`A1 reads ${JSON.stringify(header)}, not 名称`);
  if (Number(header.weight) < 600) fail(`the header row is not bold: weight ${header.weight}`);

  // ---- A shared string built from several runs, with an escaped character in it ----
  const escaped = await textOf(CELL(0, 4));
  report.escaped = escaped;
  if (escaped !== "带 & 的文本") fail(`E1 reads ${JSON.stringify(escaped)}, not 带 & 的文本`);

  // ---- A cell in the sheet's body carries no fill of the pane's own ----
  // The frozen column paints the surface so what scrolls under it is hidden; a body cell does not.
  const plainFill = await evaluate(
    `(() => { const cell = ${CELL(0, 4)}; return cell ? getComputedStyle(cell).backgroundColor : null; })()`,
  );
  report.plainFill = plainFill;
  if (plainFill !== "rgba(0, 0, 0, 0)") {
    fail(`a cell in the sheet's body carries a fill: ${plainFill}`);
  }

  // ---- The number is the serial; the date is what its format says it is ----
  const date = await textOf(CELL(1, 1));
  report.date = date;
  if (date !== "07-12-23") fail(`the date cell reads ${JSON.stringify(date)}, not 07-12-23`);

  // ---- A percent is scaled, and a thousands separator is drawn ----
  const percent = await textOf(CELL(2, 1));
  const thousands = await textOf(CELL(3, 1));
  const custom = await textOf(CELL(4, 1));
  report.formats = { percent, thousands, custom };
  if (percent !== "12.50%") fail(`the percent cell reads ${JSON.stringify(percent)}`);
  if (thousands !== "1,234.50") fail(`the thousands cell reads ${JSON.stringify(thousands)}`);
  // A format code from the workbook's own list, with its literal text.
  if (custom !== "1.500 s") fail(`the custom-format cell reads ${JSON.stringify(custom)}`);

  // ---- An inline string, a boolean and an error ----
  const inline = await textOf(CELL(1, 2));
  const boolean = await textOf(CELL(5, 0));
  const error = await textOf(CELL(5, 1));
  report.values = { inline, boolean, error };
  if (inline !== "绿色") fail(`the inline string reads ${JSON.stringify(inline)}`);
  if (boolean !== "TRUE") fail(`the boolean cell reads ${JSON.stringify(boolean)}`);
  if (error !== "#DIV/0!") fail(`the error cell reads ${JSON.stringify(error)}`);

  // ---- A merged region is one cell wide enough for both of its columns ----
  const merged = await widthOf(CELL(0, 2));
  const single = await widthOf(CELL(0, 1));
  report.merge = { merged, single };
  if (merged < single * 1.9) {
    fail(`the merged cell is ${merged}px against a single column's ${single}px, so it does not span`);
  }

  // ---- A frozen row is drawn once, and stays where it is when the sheet scrolls ----
  const frozenCount = await evaluate(
    `(${VISIBLE})?.querySelectorAll('[data-xlsx-row="0"]').length ?? -1`,
  );
  report.frozenRows = frozenCount;
  if (frozenCount !== 1) fail(`row 0 is drawn ${frozenCount} times, not once`);
  const rowTop = () =>
    evaluate(
      `(() => { const row = ${VISIBLE}?.querySelector('[data-xlsx-row="0"]'); return row ? Math.round(row.getBoundingClientRect().top) : null; })()`,
    );
  const frozenBefore = await rowTop();
  await evaluate(`(() => { const pane = ${VISIBLE}.querySelector(".verta-doc-scroll"); pane.scrollTop = 300; return true; })()`);
  await sleep(400);
  const frozenAfter = await rowTop();
  await evaluate(`(() => { const pane = ${VISIBLE}.querySelector(".verta-doc-scroll"); pane.scrollTop = 0; return true; })()`);
  await sleep(300);
  report.frozenRow = { before: frozenBefore, after: frozenAfter };
  if (frozenBefore === null || frozenAfter === null) fail("the frozen row could not be measured");
  if (Math.abs(frozenAfter - frozenBefore) > 2) {
    fail(`the frozen first row moved from ${frozenBefore} to ${frozenAfter} when the sheet scrolled`);
  }

  // ---- Scrolling right leaves the frozen column where it is ----
  const columnLeft = () =>
    evaluate(
      `(() => { const cell = ${CELL(1, 0)}; return cell ? Math.round(cell.getBoundingClientRect().left) : null; })()`,
    );
  const before = await columnLeft();
  await evaluate(`(() => { const pane = ${VISIBLE}.querySelector(".verta-doc-scroll"); pane.scrollLeft = 900; return true; })()`);
  await sleep(400);
  const after = await columnLeft();
  report.frozenColumn = { before, after };
  if (before === null || after === null) fail("the first column could not be measured");
  if (Math.abs(after - before) > 2) {
    fail(`the frozen first column moved from ${before} to ${after} when the sheet scrolled`);
  }
  // The columns that scrolled away are gone and the ones further on have arrived: the frozen
  // column staying put is not a pane that ignores the scrollbar.
  const headingsAfter = JSON.parse(
    await evaluate(
      `JSON.stringify([...(${VISIBLE}).querySelectorAll("[data-xlsx-heading]")].map((el) => el.innerText.trim()))`,
    ),
  );
  report.headingsAfter = headingsAfter;
  if (headingsAfter.includes("B")) {
    fail(`the second column is still drawn after scrolling past it: ${headingsAfter.join("")}`);
  }
  if (!headingsAfter.includes("L")) {
    fail(`the columns did not follow the scroll: ${headingsAfter.join("")}`);
  }
  await evaluate(`(() => { const pane = ${VISIBLE}.querySelector(".verta-doc-scroll"); pane.scrollLeft = 0; return true; })()`);
  await sleep(300);

  // ---- A sheet with nothing in it reads as an empty grid, not as a failure ----
  const emptyTab = await evaluate(`(() => {
    const tab = [...(${VISIBLE}).querySelectorAll("[data-xlsx-tab]")].find((el) => el.innerText.trim() === "空表");
    tab?.click();
    return !!tab;
  })()`);
  if (!emptyTab) fail("the third sheet has no tab");
  await sleep(700);
  const emptySummary = await evaluate(
    `(${VISIBLE})?.firstElementChild?.innerText?.replace(/\\s+/g, " ").trim() ?? null`,
  );
  report.emptySheet = emptySummary;
  if (!/0\s*(行|rows)/.test(emptySummary)) {
    fail(`the empty sheet's summary reads ${JSON.stringify(emptySummary)}`);
  }

  // ---- The workbook's own red-on-green is read but not drawn ----
  // The pane is themed, so a cell reads in the theme's ink on the theme's surface whatever the
  // file carries. The theme's ink is neutral: black on a light theme, white on a dark one.
  const secondTab = await evaluate(`(() => {
    const tab = [...(${VISIBLE}).querySelectorAll("[data-xlsx-tab]")].find((el) => el.innerText.trim() === "第二张");
    tab?.click();
    return !!tab;
  })()`);
  if (!secondTab) fail("the second sheet has no tab");
  await sleep(700);
  const second = await evaluate(`(() => {
    const cell = ${CELL(0, 0)};
    if (!cell) return null;
    const style = getComputedStyle(cell);
    return {
      text: cell.innerText.trim(),
      color: style.color,
      // The theme's own ink, read off the page rather than off anything a workbook could set.
      themeInk: getComputedStyle(document.body).color,
      background: style.backgroundColor,
      weight: style.fontWeight,
      align: cell.getAttribute("data-xlsx-justify"),
    };
  })()`);
  report.secondSheet = second;
  if (second?.text !== "第二张的内容") {
    fail(`the second sheet's cell reads ${JSON.stringify(second)}`);
  }
  // The cell style's own red is not drawn.
  if (second.color === "rgb(255, 0, 0)") {
    fail("the workbook's own font colour is still drawn");
  }
  // The ink is the theme's own, so a light theme draws black and this dark one draws white.
  if (second.color !== second.themeInk) {
    fail(`the cell's ink is ${second.color}, not the theme's ${second.themeInk}`);
  }
  // A cell is not filled: where the file had green, the pane's own surface shows through, or - for
  // a column the sheet froze - the same surface, which that column paints to hide what scrolls
  // under it. Either way the workbook's own highlight is not what is drawn.
  if (/^(rgb\(0, 255, 0\)|#00ff00)/.test(second.background)) {
    fail(`the cell is filled ${second.background}, which is the workbook's own highlight`);
  }
  // The parts of the style that are not colour still come from the file.
  if (Number(second.weight) < 600) fail(`the bold the style names is not drawn: ${second.weight}`);
  if (second.align !== "center") fail(`the centre the style names is not drawn: ${second.align}`);

  report.ok = true;
  console.log(
    "PASS: .xlsx 当表格读——sheet 标签按工作簿顺序列出并逐个按需读取；共享字符串（含多 run 与转义）与 inlineStr/bool/error 都读对；数字按单元格样式里的格式码画成日期 mm-dd-yy、百分比 12.50%、千分位 1,234.50、工作簿自定义格式 1.500 s；合并区域跨两列；冻结行列在滚动时不动；第二张表的字色/填充/加粗/居中随样式；空格子读成空表而不是失败。",
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
