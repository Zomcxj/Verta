// Acceptance for a Windows metafile in a document: a `.wmf` / `.emf` picture is **drawn**, not
// counted as one the pane could not draw.
//
// The fixture is built from two files Windows itself wrote - `%TEMP%\verta-mf\gdi.wmf` and `gdi.emf`,
// recorded by GDI drawing rectangles, an ellipse, a polygon, a polyline, text and a stretched bitmap
// - so what is drawn here is what Windows says those bytes are. The pane is screenshotted as well, to
// put beside the PNGs GDI+ rendered from the same two files.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/docx-metafile.mjs [--port=9222]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-metafile-probe-"));
const FILE = join(DIR, "metafiles.docx");
const SAMPLES = join(process.env.TEMP ?? tmpdir(), "verta-mf");
const WMF = join(SAMPLES, "gdi.wmf");
const EMF = join(SAMPLES, "gdi.emf");
const SHOT = join(DIR, "pane.png");

const report = {};
/** The tabs this run opened, which are the only ones it closes again. */
let opened = new Set();
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

// 9 525 EMU to the pixel, so a picture is asked for at the size Windows drew it.
const px = (value) => Math.round(value * 9525);

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Default Extension="wmf" ContentType="image/x-wmf"/><Default Extension="emf" ContentType="image/x-emf"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.wmf"/><Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.emf"/></Relationships>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t>WMF 下面：</w:t></w:r></w:p>
  <w:p><w:r><w:drawing><wp:inline><wp:extent cx="${px(463)}" cy="${px(178)}"/><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
  <w:p><w:r><w:t>EMF 下面：</w:t></w:r></w:p>
  <w:p><w:r><w:drawing><wp:inline><wp:extent cx="${px(463)}" cy="${px(178)}"/><a:graphic><a:graphicData><a:blip r:embed="rId6"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body></w:document>`;

/** The archive: Word's own parts plus the two metafiles, zipped by PowerShell. */
const build = () => {
  const parts = join(DIR, "parts");
  mkdirSync(join(parts, "_rels"), { recursive: true });
  mkdirSync(join(parts, "word", "_rels"), { recursive: true });
  mkdirSync(join(parts, "word", "media"), { recursive: true });
  writeFileSync(join(parts, "[Content_Types].xml"), CONTENT_TYPES);
  writeFileSync(join(parts, "_rels", ".rels"), RELS);
  writeFileSync(join(parts, "word", "_rels", "document.xml.rels"), DOCUMENT_RELS);
  writeFileSync(join(parts, "word", "document.xml"), DOCUMENT);
  copyFileSync(WMF, join(parts, "word", "media", "image1.wmf"));
  copyFileSync(EMF, join(parts, "word", "media", "image2.emf"));
  const zip = join(DIR, "archive.zip");
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${join(parts, "*")}' -DestinationPath '${zip}' -Force`,
    ],
    { stdio: "pipe" },
  );
  renameSync(zip, FILE);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
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
    throw new Error(
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 200)}`,
    );
  }
  return result.result.value;
};
const waitFor = async (expression, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const value = ${expression}; return value ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};

/**
 * The tabs that are open now.
 *
 * A probe must not close every tab it finds: the session it was run in is the user's, and the tabs
 * already open are theirs. Only the difference between two of these is the probe's to close.
 */
const tabIds = async () =>
  new Set(
    JSON.parse(
      (await evaluate(
        `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id")))`,
      )) || "[]",
    ),
  );

/** How a chip is pressed. The app's tab strip reacts to a press, not to a click. */
const PRESS = `const press = (node) => {
  const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  node.dispatchEvent(new PointerEvent("pointerdown", options));
  node.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0 }));
  node.dispatchEvent(new MouseEvent("click", { ...options, buttons: 0 }));
};`;

/**
 * Close the named tabs, each through its own close chip.
 *
 * The chip is a `span[role=button]` inside the tab trigger, and a bare `click` on it does nothing:
 * a press - `pointerdown`, `pointerup`, then `click` - is what the strip listens for. It is the last
 * labelled control in a tab, the dot that says the file is unsaved coming before it, so taking the
 * last one is taking the close chip.
 */
const closeTabs = async (ids) => {
  if (ids.size === 0) return;
  for (let round = 0; round < 12; round += 1) {
    const left = await evaluate(`(() => {
      ${PRESS}
      const ids = ${JSON.stringify([...ids])};
      let closed = 0;
      for (const tab of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(tab.getAttribute("data-tab-id"))) continue;
        const chip = [...tab.querySelectorAll("[aria-label]")].pop();
        if (!chip) continue;
        press(chip);
        closed += 1;
      }
      return closed;
    })()`);
    if (left === 0) return;
    // A close the app wants to ask about is confirmed by the last button of the dialog it puts up.
    await evaluate(`(() => {
      ${PRESS}
      const dialog = document.querySelector("[role=alertdialog]");
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll("button")];
      const confirm = buttons[buttons.length - 1];
      if (!confirm) return false;
      press(confirm);
      return true;
    })()`);
    await sleep(400);
  }
};

/**
 * Make a tab the one on screen.
 *
 * The status bar follows the tab that is current: with a document on screen it names that document's
 * folder, and the terminal that has just been opened is only asked about once it is the current tab.
 */
const activateTab = async (id) => {
  await evaluate(`(() => {
    ${PRESS}
    const tab = [...document.querySelectorAll("[data-tab-id]")].find(
      (el) => el.getAttribute("data-tab-id") === ${JSON.stringify(id)},
    );
    if (!tab) return false;
    press(tab);
    return true;
  })()`);
  await sleep(500);
};

const PANE = `[...document.querySelectorAll("[data-docx-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  for (const sample of [WMF, EMF]) {
    if (!existsSync(sample)) fail(`the sample ${sample} is missing (run %TEMP%\\mfgen2.ps1 first)`);
  }
  report.samples = { wmf: WMF, emf: EMF };
  build();
  report.fixture = FILE;

  const before = await tabIds();
  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(FILE)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail("the app has no IPC to hand a path to");
  if (!(await waitFor(`!!(${PANE})`, 30000))) fail("the .docx never reached the reader");
  // What opened it: the tab that was not there before this run.
  opened = new Set([...(await tabIds())].filter((id) => !before.has(id)));

  // ---- Both metafiles are drawn, and nothing is reported as undrawable ----
  const drawn = await evaluate(`(() => {
    const pane = ${PANE};
    const images = [...pane.querySelectorAll("[data-docx-image]")].map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        source: (node.getAttribute("src") || "").slice(0, 30),
        bytes: (node.getAttribute("src") || "").length,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        complete: node.complete === true && rect.width > 0,
      };
    });
    return {
      images,
      undrawn: [...pane.querySelectorAll("[data-docx-undrawn]")].map((node) =>
        Number(node.getAttribute("data-docx-undrawn")),
      ),
      notice: (pane.innerText || "").includes("未能显示"),
    };
  })()`);
  report.pane = drawn;
  if (drawn.images.length !== 2) {
    fail(`the pane drew ${drawn.images.length} pictures, not the two the document names`);
  }
  for (const image of drawn.images) {
    if (!image.source.startsWith("data:image/svg+xml;base64,")) {
      fail(`a metafile was not replayed into an SVG: ${JSON.stringify(image)}`);
    }
    if (!image.complete) fail(`a picture did not load: ${JSON.stringify(image)}`);
  }
  if (drawn.undrawn.length !== 0 || drawn.notice) {
    fail(`the pane still reports pictures it could not draw: ${JSON.stringify(drawn.undrawn)}`);
  }

  // ---- A screenshot of the pane, to put beside what Windows rendered from the same bytes ----
  const box = await evaluate(`(() => {
    const pane = ${PANE};
    const rect = pane.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  })()`);
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
  });
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  report.screenshot = SHOT;

  report.ok = true;
  console.log(
    `PASS: 文档里的 WMF/EMF 由 Rust 重放成 SVG 画出来了——两张图都是 data:image/svg+xml，且「未能显示」不再出现。截图：${SHOT}`,
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
    await closeTabs(opened);
  } catch {
    // The window may already be gone.
  }
  // The fixture goes, and the socket with it: an open debugger socket keeps node alive past the
  // result, which reads as a probe that hung.
  cleanup();
  socket.close();
}
