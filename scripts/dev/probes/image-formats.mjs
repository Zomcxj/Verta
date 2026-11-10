// Acceptance for the picture formats a pane draws: one table, and a bitmap is drawn instead of
// being called a binary file.
//
// Four panes had grown a list of extensions of their own and drifted apart. Measured before the
// change: the editor's main view knew `svg` and not `bmp`, the column beside it knew `bmp` and
// `avif` and not `svg`, so a `.bmp` opened as a file answered 二进制文件 while the sidebar was
// drawing a thumbnail of the same bytes, and an `.svg` could never be seen as a picture at all. The
// terminal's own list named `.bmp` too, and the mime it handed the webview for one was `image/png`,
// which is a broken picture rather than a bitmap.
//
// So this opens four files the way an "Open With" does (`verta:open-file`), one per line of the
// table, and asks the pane what it drew:
//
//   pixel.bmp    a real 2x2 24-bit bitmap, written byte by byte here - the main view has to draw it
//   logo.svg     a real SVG - the source in the editor, and a thumbnail beside it
//   picture.avif an AVIF's first box and no pixels - the pane has to take the picture path (the
//                format is in the table), and say it could not read it rather than call it binary
//   note.md      a Markdown file - the reference for *where* a switch sits: a picture's one stop
//                has to land in the same corner of the editor column, in the same kind of bar
//   sample.bin   bytes nothing can draw - the control: still 二进制文件, still no picture
//
// Two traps on this window that a probe can fall into and pass on nothing:
//
//   - the icons are `<img>` elements too (a Hugeicons glyph is a `data:image/svg+xml` URL), so "an
//     image is on screen" is true of the tab strip whatever was opened; only `asset.localhost`
//     sources are pictures of files here;
//   - every editor tab stays mounted, a hidden one is `visibility: hidden`, and `checkVisibility()`
//     ignores that property by default - so the ancestors are walked instead.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/image-formats.mjs [--port=9222]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-image-formats-"));
const BMP = join(DIR, "pixel.bmp");
const SVG = join(DIR, "logo.svg");
const AVIF = join(DIR, "picture.avif");
const BIN = join(DIR, "sample.bin");
const MD = join(DIR, "note.md");

const report = {};
/** The tabs this run opened, which are the only ones it closes again. */
const opened = new Set();
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/**
 * A real 2x2 24-bit bitmap: what a paint program writes, not a header with nothing behind it.
 *
 * Rows go bottom-up and each pixel is blue, green, red - the format's own order, so the bytes are
 * the bitmap rather than something that merely starts with `BM`.
 */
const bitmap = () => {
  const width = 2;
  const height = 2;
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  const rows = [
    [
      [0, 0, 255],
      [0, 255, 0],
    ],
    [
      [255, 0, 0],
      [255, 255, 255],
    ],
  ];
  rows.forEach((row, y) =>
    row.forEach((bgr, x) =>
      bgr.forEach((value, index) => pixels.writeUInt8(value, y * rowBytes + x * 3 + index)),
    ),
  );
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
};

/** A real SVG, 24 by 16, so its decoded size says whether the webview read it as a picture. */
const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="16" viewBox="0 0 24 16"><rect width="24" height="16" fill="#3b82f6"/><circle cx="12" cy="8" r="5" fill="#f59e0b"/></svg>\n`;

/**
 * An AVIF's own first box, with no pixels behind it.
 *
 * `00 00 00 20 ftyp avif` is the head the terminal's sniffer reads, so this is the format saying
 * what it is and nothing more: the pane has to take the picture path and say it could not read it.
 * Whether that box decodes is the webview's business, not this probe's.
 */
const avifHeader = () => {
  const box = Buffer.alloc(32);
  box.writeUInt32BE(32, 0);
  box.write("ftyp", 4, "ascii");
  box.write("avif", 8, "ascii");
  box.writeUInt32BE(0, 12);
  box.write("avifmif1", 16, "ascii");
  return box;
};

const build = () => {
  writeFileSync(BMP, bitmap());
  writeFileSync(SVG, SVG_TEXT);
  writeFileSync(AVIF, avifHeader());
  // A Markdown file, for the one thing a picture's switch has to agree with: where it sits.
  writeFileSync(MD, "# 一\n\n正文\n");
  // The control: a byte nothing here names, which has to stay a binary file.
  writeFileSync(BIN, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x7f]));
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// The main window, not whichever page carries the app's origin: a settings window is a page of the
// same origin and has none of the panes this probe reads.
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
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
 * What counts as on screen.
 *
 * Every editor tab stays mounted and a hidden one is `visibility: hidden`, so a probe that reads the
 * whole document sees the files it opened before this one too, including their pictures. The check
 * walks the ancestors for that one property rather than calling `checkVisibility()`, whose default
 * ignores `visibility` - which is exactly the property the editor uses to put a tab away.
 */
const VISIBLE = `const visible = (node) => {
  for (let el = node; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
  }
  return true;
};`;

/**
 * What the pane on screen is showing: the files it drew as pictures, its text, and its code.
 *
 * Only `http://asset.localhost/` sources count. The icons in this window are `<img>` elements too -
 * a Hugeicons glyph is a `data:image/svg+xml` URL - so "an image is on screen" is true of the tab
 * strip and the status bar whatever file was opened, and a probe that counted them would pass on
 * nothing at all. A picture of a file is the one the asset protocol answers.
 *
 * A pane's own text has to be read, not the document's: 二进制文件 is a sentence only the editor
 * writes, and the point of this probe is which sentence appears for which bytes.
 */
const readPane = async () =>
  JSON.parse(
    await evaluate(`(() => {
      ${VISIBLE}
      const pictures = [];
      let icons = 0;
      for (const img of [...document.querySelectorAll("img")].filter(visible)) {
        const src = img.getAttribute("src") || "";
        if (!src.startsWith("http://asset.localhost/")) {
          icons += 1;
          continue;
        }
        pictures.push({
          alt: img.getAttribute("alt"),
          src,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          complete: img.complete,
        });
      }
      return JSON.stringify({
        pictures,
        icons,
        text: (document.body.innerText || "").slice(0, 3000),
        code: [...document.querySelectorAll(".cm-content")]
          .filter(visible)
          .map((node) => node.textContent || "")
          .join("\\n")
          .slice(0, 3000),
      });
    })()`),
  );

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

/** Close the named tabs, each through its own close chip. */
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

/** Open a file the way an "Open With" does, and wait for the tab it opens. */
const openAndWait = async (path, label) => {
  const before = await tabIds();
  const emitted = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(path)}] }).then(() => true).catch((e) => String(e))`,
  );
  if (emitted !== true) fail(`the app refused to open ${label}: ${emitted}`);
  let fresh = new Set();
  for (let attempt = 0; attempt < 80 && fresh.size === 0; attempt += 1) {
    fresh = new Set([...(await tabIds())].filter((id) => !before.has(id)));
    if (fresh.size === 0) await sleep(250);
  }
  if (fresh.size === 0) fail(`${label} opened no tab`);
  for (const id of fresh) opened.add(id);
  await sleep(600);
  return [...fresh];
};

/** Where a view switch sits inside its editor column. */
const toggleCorner = async (findExpression) =>
  evaluate(`(() => {
    ${VISIBLE}
    const button = ${findExpression};
    const bar = button && button.parentElement;
    if (!bar) return null;
    const column = bar.offsetParent || bar.parentElement;
    if (!column) return null;
    const box = column.getBoundingClientRect();
    const rect = bar.getBoundingClientRect();
    return {
      top: Math.round(rect.top - box.top),
      right: Math.round(box.right - rect.right),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      stop: (button.innerText || "").trim(),
    };
  })()`);

/**
 * The same measurement, off `top` and `right` alone.
 *
 * A picture's bar is one stop wide and a Markdown file's is three, so the width is reported and not
 * compared: where the bar starts is what has to agree.
 */
const sameCorner = (a, b) => a && b && a.top === b.top && a.right === b.right;

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  build();
  report.fixture = DIR;

  // ---- A bitmap: drawn by the main view, not called a binary file ----
  await openAndWait(BMP, "a bitmap");
  if (
    !(await waitFor(
      `[...document.querySelectorAll("img")].some((img) => img.getAttribute("alt") === "pixel.bmp" && img.naturalWidth === 2)`,
      20000,
    ))
  ) {
    report.bitmapPane = await readPane();
    fail(`the 2x2 bitmap was not drawn: ${JSON.stringify(report.bitmapPane)}`);
  }
  const bitmapPane = await readPane();
  report.bitmap = {
    picture: bitmapPane.pictures.find((image) => image.alt === "pixel.bmp"),
    binary: bitmapPane.text.includes("二进制文件"),
  };
  if (bitmapPane.text.includes("二进制文件")) {
    fail("the bitmap is still called a binary file, which is the pane the table replaced");
  }
  const drawn = report.bitmap.picture;
  if (!drawn.complete || drawn.naturalWidth !== 2 || drawn.naturalHeight !== 2) {
    fail(`the bitmap did not decode to its own 2x2: ${JSON.stringify(drawn)}`);
  }
  if (!drawn.src.startsWith("http://asset.localhost/")) {
    fail(`the picture was not handed over through the asset protocol: ${drawn.src}`);
  }

  // ---- Where the switch sits: a Markdown file is the reference ----
  await openAndWait(MD, "a Markdown file");
  if (
    !(await waitFor(
      `[...document.querySelectorAll("button[aria-pressed]")].some((node) => (node.innerText || "").trim() === "源码")`,
      20000,
    ))
  ) {
    report.markdownPane = await readPane();
    fail(`the Markdown pane has no view switch to measure: ${JSON.stringify(report.markdownPane)}`);
  }
  const markdownCorner = await toggleCorner(
    `[...document.querySelectorAll("button[aria-pressed]")].filter(visible).find((node) => (node.innerText || "").trim() === "源码")`,
  );
  report.toggle = { markdown: markdownCorner };

  // ---- An SVG: its source in the editor, a drawing beside it ----
  await openAndWait(SVG, "an SVG");
  if (
    !(await waitFor(
      `[...document.querySelectorAll(".cm-content")].some((node) => (node.textContent || "").includes("<svg"))`,
      20000,
    ))
  ) {
    report.svgPane = await readPane();
    fail(`the SVG did not open as text: ${JSON.stringify(report.svgPane)}`);
  }
  const toggled = await evaluate(`(() => {
    ${PRESS}
    ${VISIBLE}
    const button = [...document.querySelectorAll('button[aria-label="显示预览"]')].find(visible);
    if (!button) return false;
    press(button);
    return true;
  })()`);
  if (!toggled) fail("the SVG pane offers no preview toggle, so nothing can be drawn beside it");
  // The one stop of a picture is in the same bar, in the same corner, as the Markdown switch: the
  // same choice used to live in the bottom right for a picture and the top right for a document.
  const svgCorner = await toggleCorner(
    `[...document.querySelectorAll('button[aria-label="隐藏预览"]')].filter(visible)[0]`,
  );
  report.toggle.svg = svgCorner;
  if (!sameCorner(markdownCorner, svgCorner)) {
    fail(
      `the picture's preview switch is not where the Markdown one is: ${JSON.stringify(svgCorner)} against ${JSON.stringify(markdownCorner)}`,
    );
  }
  // The column draws the file itself, so its `<img>` is the asset URL for this path - not one of the
  // window's icons, and not twenty-four pixels of anything else.
  if (
    !(await waitFor(
      `[...document.querySelectorAll("img")].some((img) => {
        const src = img.getAttribute("src") || "";
        return src.startsWith("http://asset.localhost/") && src.includes("logo.svg") && img.naturalWidth === 24 && img.naturalHeight === 16;
      })`,
      20000,
    ))
  ) {
    report.svgPane = await readPane();
    fail(`the SVG has no drawing beside its source: ${JSON.stringify(report.svgPane)}`);
  }
  const svgPane = await readPane();
  report.svg = {
    source: svgPane.code.includes("<svg"),
    thumbnail: svgPane.pictures.find((image) => image.src.includes("logo.svg")),
    binary: svgPane.text.includes("二进制文件"),
  };
  if (report.svg.binary) fail("the SVG is called a binary file");

  // ---- An AVIF: the picture path, not the binary one ----
  await openAndWait(AVIF, "an AVIF");
  await waitFor(
    `(document.body.innerText || "").includes("读不出这张图片") || [...document.querySelectorAll("img")].some((img) => img.getAttribute("alt") === "picture.avif")`,
    20000,
  );
  const avifPane = await readPane();
  const avifPicture = avifPane.pictures.find((image) => image.alt === "picture.avif");
  report.avif = {
    branch: avifPicture ? "drawn" : avifPane.text.includes("读不出这张图片") ? "read-failed" : "neither",
    picture: avifPicture ?? null,
    binary: avifPane.text.includes("二进制文件"),
  };
  if (report.avif.binary) {
    fail("the AVIF is called a binary file, so the format never reached the picture path");
  }
  if (report.avif.branch === "neither") {
    fail(`the AVIF got neither a picture nor a failed read: ${JSON.stringify(avifPane)}`);
  }

  // ---- The control: bytes nothing draws stay a binary file ----
  await openAndWait(BIN, "a binary file");
  if (!(await waitFor(`(document.body.innerText || "").includes("二进制文件")`, 20000))) {
    report.binPane = await readPane();
    fail(`a file with no picture in it is not reported as binary: ${JSON.stringify(report.binPane)}`);
  }
  const binPane = await readPane();
  report.control = {
    binary: binPane.text.includes("二进制文件"),
    pictures: binPane.pictures,
    icons: binPane.icons,
  };
  if (binPane.pictures.length !== 0) {
    fail(`bytes nothing can draw were drawn anyway: ${JSON.stringify(binPane.pictures)}`);
  }

  report.ok = true;
  console.log(
    "PASS: 图片格式是一张表——.bmp 主视图画出（2x2，asset 协议）不再报二进制；.svg 源码在编辑器、缩略图在旁边；.avif 走图片这条路（格式认了，字节是假的所以读不出）而不是二进制；无图字节仍报二进制；图片/SVG 的预览入口与 md 在同一个角（同一个 bar）。",
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
  cleanup();
  socket.close();
}
