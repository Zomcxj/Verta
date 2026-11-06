// Acceptance for the `.docx` reader: a Word file is drawn as its text, not called a binary file.
//
// The fixture is a real archive - built here with `Compress-Archive`, so the entries are spelled the
// way PowerShell spells them and the reader's tolerant entry matching is part of what is tested -
// holding a heading, a bold run, a numbered list, a table and an escaped entity. What it asserts is
// what a reader of the document would see: the heading as a heading, the bold run bold, the list as a
// list, the table's cells in a table, and `&` where the file says `&amp;`.
//
// A second, corrupt file is opened to check the other half: the pane has to say it could not read the
// document rather than draw nothing or throw.
//
// Both live in a directory of their own under the system temp directory, opened by handing the app the
// path the way an "Open With" does (`verta:open-file`) rather than by driving the file tree: the tree
// shows whatever folder the user is working in, and a fixture written into that folder puts probe
// files in their project. The directory and the tabs this opened are removed at the end.
//
// Usage: node scripts/dev/probes/docx-preview.mjs [--port=9222]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-docx-probe-"));
const GOOD = "兵器谱.docx";
const BROKEN = "broken.docx";
const TEXTY = "text-in-a-docx.docx";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:num w:numId="7"><w:abstractNumId w:val="9"/></w:num>
</w:numbering>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>终端智能体兵器谱</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">Tom &amp; Jerry </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>加粗的一段</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>第二项</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>名字</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>价格</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Ponytail</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>免费</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
</w:body></w:document>`;

const report = {};
// Failures are thrown rather than exited on, so the fixture is removed and the tabs closed on the way
// out.
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
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
const waitForValue = async (expression, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
};

/** Hands a path to the app the way an "Open With" does, and waits for its tab to come forward. */
const openedTabs = new Set();
const openFile = async (path, label) => {
  const name = path.split(/[\\/]/).pop();
  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(path)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail(`${label}: the app has no IPC to hand a path to`);
  const active = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(name)})`;
  if (!(await waitFor(active, 30000))) {
    report.tabs = await evaluate(
      `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()))`,
    );
    fail(`${label}: ${name} was handed to the app and its tab never came forward`);
  }
  const tabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tabId) openedTabs.add(tabId);
};

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);

/**
 * What the reader drew, read off the live DOM.
 *
 * The panes of other tabs stay mounted, so only the visible one counts - a probe that read the first
 * `[data-docx-preview]` in the document would be reading whichever document was opened last time.
 */
const visiblePane = `[...document.querySelectorAll("[data-docx-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;
const readDocument = () =>
  evaluate(`(() => {
    const pane = ${visiblePane};
    if (!pane) return null;
    const rows = [...pane.querySelectorAll("table tr")];
    return {
      text: (pane.innerText || "").replace(/\\s+/g, " ").trim(),
      headings: [...pane.querySelectorAll("h1, h2, h3")].map((h) => (h.innerText || "").trim()),
      // The body is one editable surface, so a list item is a block of its own rather than an li
      // inside an ol: a wrapper would put the paragraph two levels down and the writer reads
      // paragraphs back from the direct children. role=listitem and data-list carry what the element
      // no longer does.
      listItems: [...pane.querySelectorAll('[data-block="li"]')].map((li) => (li.innerText || "").trim()),
      listKind: [...pane.querySelectorAll('[data-block="li"]')].map((li) => (li.getAttribute("data-list") || "").replace("number", "ol").replace("bullet", "ul")),
      bold: [...pane.querySelectorAll("strong, .font-semibold")].map((b) => (b.innerText || "").trim()),
      cells: [...pane.querySelectorAll("table td")].map((td) => (td.innerText || "").trim()),
      rowCount: rows.length,
      saysBinary: (pane.parentElement?.innerText || "").includes("二进制文件"),
      scrollClass: pane.classList.contains("verta-doc-scroll"),
      scrollbarWidth: getComputedStyle(pane).scrollbarWidth,
      gutter: pane.offsetWidth - pane.clientWidth,
    };
  })()`);

try {
  // ---- The fixture: a real archive, assembled as a folder and zipped by PowerShell. ----
  const parts = join(DIR, "parts");
  mkdirSync(join(parts, "_rels"), { recursive: true });
  mkdirSync(join(parts, "word"), { recursive: true });
  writeFileSync(join(parts, "[Content_Types].xml"), CONTENT_TYPES);
  writeFileSync(join(parts, "_rels", ".rels"), RELS);
  writeFileSync(join(parts, "word", "document.xml"), DOCUMENT);
  writeFileSync(join(parts, "word", "numbering.xml"), NUMBERING);
  const goodPath = join(DIR, GOOD);
  // `Compress-Archive` writes only `.zip`, so the archive is built under that name and renamed: the
  // extension is the whole difference between the two.
  const zipPath = join(DIR, "archive.zip");
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${join(parts, "*")}' -DestinationPath '${zipPath}' -Force`,
    ],
    { stdio: "pipe" },
  );
  renameSync(zipPath, goodPath);
  writeFileSync(join(DIR, BROKEN), "this is not a zip at all\n");
  report.fixtureDir = DIR;

  // ---- The document ----
  await openFile(goodPath, "the document");
  if (!(await waitFor(`!!(${visiblePane})`, 25000))) {
    report.visible = await evaluate(
      `JSON.stringify([...document.querySelectorAll("p, div, button")].filter((el) => el.offsetParent !== null && /不支持预览|二进制文件/.test(el.innerText || "")).map((el) => (el.innerText || "").trim()).slice(0, 5))`,
    );
    fail("the .docx never reached the reader");
  }
  report.document = await readDocument();
  console.log(`reader drew:       ${JSON.stringify(report.document)}`);

  const drawn = report.document ?? {};
  if (drawn.saysBinary) fail("the pane still calls the document a binary file");
  if (!(drawn.headings ?? []).includes("终端智能体兵器谱")) {
    fail(`the heading did not come through as a heading: ${JSON.stringify(drawn.headings)}`);
  }
  if (!(drawn.text ?? "").includes("Tom & Jerry")) {
    fail(`the escaped entity came through as something else: ${JSON.stringify(drawn.text?.slice(0, 80))}`);
  }
  if (!(drawn.bold ?? []).includes("加粗的一段")) {
    fail(`the bold run is not drawn as bold: ${JSON.stringify(drawn.bold)}`);
  }
  if (JSON.stringify(drawn.listItems) !== JSON.stringify(["第一项", "第二项"])) {
    fail(`the list is not drawn as a list: ${JSON.stringify(drawn.listItems)}`);
  }
  if (!(drawn.listKind ?? []).includes("ol")) {
    fail(`the numbering said decimal but the list is ${JSON.stringify(drawn.listKind)}`);
  }
  if (
    drawn.rowCount !== 2 ||
    JSON.stringify(drawn.cells) !== JSON.stringify(["名字", "价格", "Ponytail", "免费"])
  ) {
    fail(`the table did not come through: ${drawn.rowCount} rows, cells ${JSON.stringify(drawn.cells)}`);
  }
  // A document is read top to bottom, so it gets the thin bar the shell hides everywhere else.
  if (!drawn.scrollClass || drawn.scrollbarWidth !== "thin") {
    fail(
      `the document pane does not wear the document scroll bar (class ${drawn.scrollClass}, width ${drawn.scrollbarWidth})`,
    );
  }

  // ---- A file that is not an archive: said so, not drawn ----
  await openFile(join(DIR, BROKEN), "the corrupt file");
  const said = await waitForValue(
    `(() => {
      const visible = [...document.querySelectorAll("div, p")].filter((el) => el.offsetParent !== null && !el.closest('[aria-hidden="true"]'));
      const node = visible.reverse().find((el) => /读不出这个 \\.docx|could not be read/.test(el.innerText || ""));
      return node ? (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 200) : null;
    })()`,
    (value) => typeof value === "string" && value.length > 0,
    25000,
  );
  report.brokenSaid = said;
  console.log(`corrupt file says: ${JSON.stringify(said)}`);
  if (!said) fail("a file that is not a docx drew nothing and said nothing");

  report.ok = true;
  console.log(
    "PASS: .docx 由 Rust 读成块并由前端绘制——标题成标题、加粗成粗体、编号列表成 ol、表格成 2×2 表格、&amp; 还原成 &；不是 ZIP 的文件给出「读不出这个 .docx」而不是空白或崩溃。",
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // Only the tabs this run opened, and only through their own close chip.
  try {
    await evaluate(`(() => {
      const ids = ${JSON.stringify([...openedTabs])};
      let closed = 0;
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(el.getAttribute("data-tab-id"))) continue;
        const chip = el.querySelector('[role="button"]');
        if (chip) {
          chip.click();
          closed += 1;
        }
      }
      return closed;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview still leaves the directory removed below, which is the part that matters.
  }
  cleanup();
  socket.close();
}
