// Acceptance for the `.docx` reader's pages: a page is a real box that holds its own blocks, and the
// caret follows a block onto the next page.
//
// The sheets used to be a band of white painted behind one flowing column, lined up by a padding on
// the block that began each page - so a "page" could be cut through a paragraph and the caret never
// had to move. What is asserted here is the document half of the change: every block is inside the
// page it starts on, no block is drawn across a page break, each page is the section's own size with
// its margins, and typing at the end of a full page puts the new line (and the caret) on the page
// below.
//
// The fixture is an archive of its own under the system temp directory, opened by handing the app a
// path the way an "Open With" does. Nothing of the user's is opened, typed into or left behind: the
// directory and the tab this run opened are removed at the end.
//
// Usage: node scripts/dev/probes/docx-pages.mjs [--port=9222]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-docx-pages-"));
const NAME = "pages.docx";

/** How many paragraphs the fixture has: enough to run over at least three A4 pages. */
const PARAGRAPHS = 90;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
</w:styles>`;

/** One paragraph per line of the document, each long enough to wrap once at A4 width. */
const paragraph = (at) =>
  `<w:p><w:r><w:t xml:space="preserve">第 ${at} 段：这一页的正文由分页器搬到它开始的那一页里，块的边界就是页的边界。</w:t></w:r></w:p>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${Array.from({ length: PARAGRAPHS }, (_, at) => paragraph(at + 1)).join("\n")}
</w:body></w:document>`;

const report = {};
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
  console.error("app 起来了？没找到主窗口的 page 目标。");
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

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);

/** The panes of other tabs stay mounted, so only the visible one counts. */
const visiblePane = `[...document.querySelectorAll("[data-docx-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

/**
 * What the pagination drew, read off the live DOM: the pages, the blocks in each of them, and
 * whether any block is drawn across a break.
 */
const readPages = () =>
  evaluate(`(() => {
    const pane = ${visiblePane};
    if (!pane) return null;
    const pages = [...pane.querySelectorAll("[data-docx-page]")].map((node, index) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        index,
        number: Number(node.getAttribute("data-docx-page")),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        paddingTop: Math.round(Number.parseFloat(style.paddingTop) || 0),
        paddingLeft: Math.round(Number.parseFloat(style.paddingLeft) || 0),
        chrome: node.querySelectorAll("[data-docx-chrome]").length,
        blocks: [...node.querySelectorAll("[data-docx-editable]")].map((block) => {
          const box = block.getBoundingClientRect();
          return {
            text: (block.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 24),
            // A block that is not wholly inside its page is a block drawn across a page break.
            inside: box.top >= rect.top - 1 && box.bottom <= rect.bottom + 1,
          };
        }),
      };
    });
    return {
      pages,
      // Blocks the body holds itself rather than a page: none, once the document is paginated.
      stray: pane.querySelectorAll("[data-docx-body] > [data-docx-editable]").length,
      // The document's own order, page after page, as the reader would read it.
      texts: [...pane.querySelectorAll("[data-docx-page] [data-docx-editable]")].map((block) =>
        (block.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 12),
      ),
      paperPadding: Math.round(
        Number.parseFloat(getComputedStyle(pane.querySelector("[data-docx-paper]")).paddingLeft) || 0,
      ),
    };
  })()`);

/** Where the caret is: inside which block, and on which page. */
const readCaret = () =>
  evaluate(`(() => {
    const pane = ${visiblePane};
    const selection = window.getSelection();
    if (!pane || !selection || selection.rangeCount === 0) return null;
    const node = selection.anchorNode;
    const block = node && (node.nodeType === 1 ? node : node.parentElement)?.closest("[data-docx-editable]");
    if (!block || !pane.contains(block)) return null;
    const sheet = block.closest("[data-docx-page]");
    return {
      text: (block.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 24),
      page: sheet ? Number(sheet.getAttribute("data-docx-page")) : null,
      offset: selection.anchorOffset,
    };
  })()`);

const openedTabs = new Set();
const openFile = async (path) => {
  const name = path.split(/[\\/]/).pop();
  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(path)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail("the app has no IPC to hand a path to");
  const active = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(name)})`;
  if (!(await waitFor(active, 30000))) fail(`${name} was handed to the app and its tab never came forward`);
  const tabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tabId) openedTabs.add(tabId);
};

try {
  // ---- The fixture: a real archive, assembled as a folder and zipped by PowerShell. ----
  const parts = join(DIR, "parts");
  mkdirSync(join(parts, "_rels"), { recursive: true });
  mkdirSync(join(parts, "word"), { recursive: true });
  writeFileSync(join(parts, "[Content_Types].xml"), CONTENT_TYPES);
  writeFileSync(join(parts, "_rels", ".rels"), RELS);
  writeFileSync(join(parts, "word", "document.xml"), DOCUMENT);
  writeFileSync(join(parts, "word", "styles.xml"), STYLES);
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
  const documentPath = join(DIR, NAME);
  renameSync(zipPath, documentPath);
  report.fixtureDir = DIR;

  // ---- The document is cut into pages ----
  await openFile(documentPath);
  if (!(await waitFor(`!!(${visiblePane})`, 25000))) fail("the .docx never reached the reader");
  if (!(await waitFor(`${visiblePane}.querySelectorAll("[data-docx-page]").length > 1`, 25000))) {
    fail("the document was never cut into pages");
  }
  const cut = await readPages();
  report.cut = cut;
  console.log(`pages: ${cut?.pages.length}, stray blocks: ${cut?.stray}`);

  const sheets = cut?.pages ?? [];
  if (sheets.length < 3) fail(`a ${PARAGRAPHS}-paragraph document was cut into ${sheets.length} pages`);
  if (cut.stray !== 0) fail(`${cut.stray} blocks were left outside every page`);
  if (cut.paperPadding !== 0) {
    fail(`the paper carries ${cut.paperPadding}px of padding: the margins belong to the page`);
  }
  for (const sheet of sheets) {
    if (Math.abs(sheet.width - 794) > 3) fail(`page ${sheet.number} is ${sheet.width}px wide, not A4`);
    if (sheet.height < 1120) fail(`page ${sheet.number} is ${sheet.height}px tall, not A4`);
    if (Math.abs(sheet.paddingLeft - 96) > 3 || Math.abs(sheet.paddingTop - 96) > 3) {
      fail(`page ${sheet.number} has ${sheet.paddingTop}/${sheet.paddingLeft}px of margin, not 96`);
    }
    if (sheet.chrome !== 1) fail(`page ${sheet.number} carries ${sheet.chrome} page numbers, not one`);
    if (sheet.blocks.length === 0) fail(`page ${sheet.number} holds no blocks`);
    const crossing = sheet.blocks.filter((block) => !block.inside);
    if (crossing.length > 0) {
      fail(
        `page ${sheet.number} draws ${crossing.length} blocks across its own edge: ${JSON.stringify(crossing.slice(0, 3))}`,
      );
    }
  }
  // Every page is numbered, in order, and the numbers are the page's own.
  if (sheets.some((sheet, at) => sheet.number !== at + 1)) {
    fail(`the pages are numbered ${JSON.stringify(sheets.map((sheet) => sheet.number))}`);
  }
  // The document's paragraphs are all there, in order: moving them into pages must not lose or
  // reorder a single one.
  const expected = Array.from({ length: PARAGRAPHS }, (_, at) => `第 ${at + 1} 段`);
  if (JSON.stringify(cut.texts) !== JSON.stringify(expected)) {
    fail(
      `the blocks came out as ${JSON.stringify(cut.texts.slice(0, 5))}... (${cut.texts.length} of ${PARAGRAPHS})`,
    );
  }

  // ---- A line typed at the end of a full page lands on the page below, with the caret ----
  const lastOnFirstPage = await evaluate(`(() => {
    const pane = ${visiblePane};
    const first = pane.querySelector("[data-docx-page]");
    const blocks = [...first.querySelectorAll("[data-docx-editable]")];
    const block = blocks[blocks.length - 1];
    if (!block) return null;
    block.scrollIntoView({ block: "center" });
    // The caret goes to the very end of that paragraph, which is where a reader's Enter would be.
    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    pane.querySelector("[data-docx-body]").focus();
    return (block.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 12);
  })()`);
  report.lastOnFirstPage = lastOnFirstPage;
  if (!lastOnFirstPage) fail("the first page holds no paragraph to type after");

  // Enter, then the line itself: the browser creates the paragraph, the pane flattens and paginates.
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    key: "Enter",
    code: "Enter",
    text: "\r",
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  await sleep(200);
  await send("Input.insertText", { text: "跨页记号 carried across" });
  // The pane paginates a second after typing stops.
  await sleep(3000);

  const typed = await readCaret();
  const after = await readPages();
  report.typed = typed;
  report.after = { pages: after?.pages.length, stray: after?.stray };
  console.log(`caret after typing: ${JSON.stringify(typed)}, pages now ${after?.pages.length}`);

  if (!typed) fail("the caret is not in any paragraph of the document after typing");
  if (!typed.text.includes("跨页记号")) {
    fail(`the caret sits in ${JSON.stringify(typed.text)}, not in the line that was typed`);
  }
  if (typed.page !== 2) {
    fail(`the new line is on page ${typed.page}: a full first page must carry it to the second`);
  }
  if ((after?.pages.length ?? 0) < sheets.length) {
    fail(`the document was ${sheets.length} pages and is now ${after?.pages.length}`);
  }
  // And the line really is on the second page, in the DOM the reader scrolls.
  const placed = (after?.pages ?? [])[1]?.blocks.some((block) => block.text.includes("跨页记号"));
  if (!placed) fail("the typed line is not among the blocks of the second page");

  report.ok = true;
  console.log(
    "PASS: 每一页都是真盒子（A4 大小、1440 twips 页边距、页角页码），段落全部落在各自页内、没有一段被页缝切开；在第一页末尾回车加字后，新段落与光标一起落在第二页。",
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
