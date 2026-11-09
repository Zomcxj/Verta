// Acceptance for reading a `.pptx` as the slides it holds.
//
// A deck is a box full of positioned shapes, so what goes wrong is placement and text: an EMU
// length taken for a pixel, a picture whose bytes the slide only names by relationship, a run whose
// weight and size live on the `rPr` beside it, and a list whose nesting is a paragraph property.
// Each phase below is one of those.
//
// The deck is built here rather than checked in, so the assertion and the thing asserted about are
// the same file.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/pptx-preview.mjs [--port=9222]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageParts, zip } from "./lib/officeZip.mjs";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-pptx-probe-"));
const FILE = join(DIR, "综合.pptx");

const fail = (message) => {
  throw new Error(message);
};

// ---------------------------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------------------------

/** 9 525 EMU is one pixel at 96 dpi, so every box below is a round number in pixels. */
const px = (value) => value * 9525;
/** A 16:9 slide: 1280 by 720 pixels. */
const SLIDE_WIDTH = px(1280);
const SLIDE_HEIGHT = px(720);

/** A 1x1 PNG, which is all the reader needs to see: its bytes and the type they are in. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

const PRESENTATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst><p:sldId id="256" r:id="rId10"/><p:sldId id="257" r:id="rId11"/><p:sldId id="258" r:id="rId12"/></p:sldIdLst>
<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/>
</p:presentation>`;

const PRESENTATION_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
<Relationship Id="rId12" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
</Relationships>`;

/** A shape with a box, and the body given. */
function shape({ x, y, w, h, rotation, fill, body }) {
  const rot = rotation === undefined ? "" : ` rot="${rotation}"`;
  const solid = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/></p:nvSpPr><p:spPr><a:xfrm${rot}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${solid}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/** The first slide: a bold title, a two level list, and a picture. */
const SLIDE_ONE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name="Root"/><p:cNvGrpSpPr/></p:nvGrpSpPr><p:grpSpPr/>
${shape({
  x: px(100),
  y: px(20),
  w: px(800),
  h: px(120),
  body: '<a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="4400" b="1"><a:latin typeface="Calibri"/></a:rPr><a:t>综合演示</a:t></a:r></a:p>',
})}
${shape({
  x: px(100),
  y: px(180),
  w: px(800),
  h: px(240),
  body:
    '<a:p><a:pPr lvl="0" algn="l"/><a:r><a:rPr sz="2000"><a:solidFill><a:srgbClr val="3366CC"/></a:solidFill></a:rPr><a:t>第一行</a:t></a:r></a:p>' +
    '<a:p><a:pPr lvl="1"/><a:buChar char="•"/><a:r><a:rPr sz="1800" i="1" u="sng"/><a:t>缩进的第二行</a:t></a:r><a:br/><a:r><a:t>a &amp; b</a:t></a:r></a:p>',
})}
<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture"/><p:cNvPicPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId20"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${px(100)}" y="${px(440)}"/><a:ext cx="${px(400)}" cy="${px(200)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
<p:pic><p:nvPicPr><p:cNvPr id="4" name="Metafile"/><p:cNvPicPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId21"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${px(700)}" y="${px(440)}"/><a:ext cx="${px(400)}" cy="${px(200)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>
</p:spTree></p:cSld></p:sld>`;

/** The second slide: a filled shape turned forty five degrees. */
const SLIDE_TWO = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name="Root"/></p:nvGrpSpPr>
${shape({
  x: px(200),
  y: px(200),
  w: px(400),
  h: px(200),
  rotation: 2700000,
  fill: "FFFF00",
  body: '<a:p><a:r><a:t>rotated</a:t></a:r></a:p>',
})}
</p:spTree></p:cSld></p:sld>`;

/** The third slide: nothing on it at all. */
const SLIDE_THREE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name="Root"/></p:nvGrpSpPr></p:spTree></p:cSld></p:sld>`;

const SLIDE_ONE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
<Relationship Id="rId21" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.wmf"/>
</Relationships>`;

/** A metafile: what a chart or an equation is stored as, and what no webview decodes. */
const METAFILE = Uint8Array.from([0x01, 0x00, 0x09, 0x00, 0x00, 0x03, 0x2a, 0x02]);

const PPTX = zip([
  ...packageParts(
    "ppt/presentation.xml",
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  ),
  ["ppt/presentation.xml", PRESENTATION],
  ["ppt/_rels/presentation.xml.rels", PRESENTATION_RELS],
  ["ppt/slides/slide1.xml", SLIDE_ONE],
  ["ppt/slides/_rels/slide1.xml.rels", SLIDE_ONE_RELS],
  ["ppt/slides/slide2.xml", SLIDE_TWO],
  ["ppt/slides/slide3.xml", SLIDE_THREE],
  ["ppt/media/image1.png", PNG],
  ["ppt/media/image2.wmf", METAFILE],
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

const VISIBLE = `[...document.querySelectorAll("[data-pptx-preview]")].find((el) => !el.closest('[aria-hidden="true"]'))`;

const openDeck = async () => {
  writeFileSync(FILE, PPTX);
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
    fail(`the deck did not open as slides - the pane says ${said}`);
  }
  await send("Page.bringToFront");
  await sleep(600);
};

try {
  report.fixture = `${FILE} (${PPTX.length} bytes)`;
  await openDeck();

  // ---- Every slide the deck lists is drawn, and the tool bar counts them ----
  const slides = await evaluate(`(${VISIBLE})?.querySelectorAll("[data-pptx-slide]").length ?? -1`);
  const pageLabel = await evaluate(
    `(${VISIBLE})?.querySelector("[data-pptx-page]")?.innerText?.trim() ?? null`,
  );
  report.slides = slides;
  report.page = pageLabel;
  if (slides !== 3) fail(`the deck drew ${slides} slides, not the three it lists`);
  if (!/1\s*(\/|of)\s*3/.test(pageLabel)) fail(`the page number reads ${JSON.stringify(pageLabel)}`);
  // A part that stopped mid-way is reported rather than drawn short; the fixture is well formed,
  // so a note here means the reader gave up on something it should have read.
  const cutShort = await evaluate(`(${VISIBLE})?.innerText?.includes("只显示开头部分") ?? false`);
  if (cutShort) fail("the deck reports itself as truncated, which a well formed fixture is not");

  // ---- The slide's own box is 1280 by 720, and every shape is placed inside it ----
  const box = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="0"]');
    if (!slide) return null;
    const rect = slide.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  })()`);
  report.slideBox = box;
  if (!box || Math.abs(box.width / box.height - 1280 / 720) > 0.02) {
    fail(`the slide box is ${JSON.stringify(box)}, not the 16:9 the file states`);
  }

  // ---- EMU became pixels: a shape 200 by 100px sits a tenth of the way across ----
  const placed = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="0"]');
    const slideRect = slide.getBoundingClientRect();
    const shape = slide.querySelectorAll('[data-pptx-shape]')[1];
    const rect = shape.getBoundingClientRect();
    return {
      widthRatio: Number(((rect.width / slideRect.width) * 1280).toFixed(1)),
      heightRatio: Number(((rect.height / slideRect.height) * 720).toFixed(1)),
      leftRatio: Number((((rect.left - slideRect.left) / slideRect.width) * 1280).toFixed(1)),
      topRatio: Number((((rect.top - slideRect.top) / slideRect.height) * 720).toFixed(1)),
    };
  })()`);
  report.placed = placed;
  // The body shape is 800 by 240 at (100, 180) in the slide's own pixels.
  if (placed.widthRatio !== 800 || placed.heightRatio !== 240) {
    fail(`the body shape is ${placed.widthRatio} by ${placed.heightRatio}px, not 800 by 240`);
  }
  if (Math.abs(placed.leftRatio - 100) > 2 || Math.abs(placed.topRatio - 180) > 2) {
    fail(`the body shape sits at (${placed.leftRatio}, ${placed.topRatio}), not (100, 180)`);
  }

  // ---- A run's weight, size and colour come off the rPr beside it ----
  // A computed length and a bounding rect are not in the same space: the pane may be drawn at a
  // zoom, which scales the rect and leaves the computed style alone. The slide's own width in the
  // unzoomed space is the scroller's content box, which is what the scale was computed from.
  const title = await evaluate(`(() => {
    const pane = ${VISIBLE};
    const scroller = pane.querySelector(".verta-doc-scroll");
    const slideSpace = scroller.clientWidth - 32;
    const slide = pane.querySelector('[data-pptx-slide="0"]');
    const shape = slide.querySelectorAll('[data-pptx-shape]')[0];
    const run = shape.querySelector("span");
    if (!run) return null;
    const style = getComputedStyle(run);
    return {
      text: shape.innerText.replace(/\\s+/g, " ").trim(),
      weight: style.fontWeight,
      color: style.color,
      size: parseFloat(style.fontSize),
      sizeInSlide: Number(((parseFloat(style.fontSize) / slideSpace) * 1280).toFixed(1)),
      align: getComputedStyle(shape.querySelector("div") ?? shape).textAlign,
      font: style.fontFamily,
    };
  })()`);
  report.title = title;
  if (title?.text !== "综合演示") fail(`the title reads ${JSON.stringify(title?.text)}`);
  if (Number(title.weight) < 600) fail(`the title is not bold: ${title.weight}`);
  // 44pt at 96 dpi is 58.67px, which is 44 * 4/3 in the slide's own space.
  if (Math.abs(title.sizeInSlide - 58.7) > 1) {
    fail(`the title's size is ${title.sizeInSlide}px in the slide's space, not 44pt`);
  }
  // A slide is white paper, so a run that names no colour is black ink and never the pane's own
  // foreground - on a dark theme that grey-ish near-white was what the text was drawn in.
  if (title.color !== "rgb(0, 0, 0)") {
    fail(`the title is drawn in ${title.color}, not black`);
  }
  if (title.align !== "center") fail(`the title is not centred: ${title.align}`);

  // ---- A list level is an indent, a bullet is drawn, and a break keeps its line ----
  const list = await evaluate(`(() => {
    const pane = ${VISIBLE};
    const slideSpace = pane.querySelector(".verta-doc-scroll").clientWidth - 32;
    const slide = pane.querySelector('[data-pptx-slide="0"]');
    const shape = slide.querySelectorAll('[data-pptx-shape]')[1];
    const paragraphs = [...shape.querySelectorAll("div")].filter((el) => el.style.textAlign !== "");
    const pads = paragraphs.map((el) =>
      Number(((parseFloat(getComputedStyle(el).paddingLeft) / slideSpace) * 1280).toFixed(1)),
    );
    const second = paragraphs[1];
    return {
      paragraphs: paragraphs.length,
      pads,
      second: second?.textContent ?? null,
      sizes: paragraphs.map((el) => {
        // The bullet, where there is one, is the first span and is not a run's own size.
        const spans = [...el.querySelectorAll("span")].filter((s) => !/^\u2022/.test(s.textContent));
        const span = spans[0] ?? el;
        return Number(((parseFloat(getComputedStyle(span).fontSize) / slideSpace) * 1280).toFixed(1));
      }),
    };
  })()`);
  report.list = list;
  if (list.paragraphs < 2) fail(`the body drew ${list.paragraphs} paragraphs, not two`);
  // The second paragraph is at outline level 1, which is half an inch in: 48px.
  if (Math.abs(list.pads[1] - 48) > 2) {
    fail(`the indented paragraph is ${list.pads[1]}px in, not 48`);
  }
  // The two paragraphs name their own sizes: 20pt then 18pt, which is 26.67 and 24 in the slide.
  if (Math.abs(list.sizes[0] - 26.7) > 1 || Math.abs(list.sizes[1] - 24) > 1) {
    fail(`the paragraph runs are ${JSON.stringify(list.sizes)}px in the slide's space, not 20pt then 18pt`);
  }
  if (!list.second.includes("•")) fail(`the bullet is not drawn: ${JSON.stringify(list.second)}`);
  if (!/a & b/.test(list.second)) fail(`the escaped run reads ${JSON.stringify(list.second)}`);
  if (!list.second.includes("\n")) fail(`the line break was lost: ${JSON.stringify(list.second)}`);

  // ---- A picture is drawn from the bytes its relationship names ----
  const picture = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="0"]');
    const img = slide?.querySelector("img");
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const slideRect = slide.getBoundingClientRect();
    return {
      source: img.src.slice(0, 22),
      bytes: img.src.length,
      widthRatio: Number(((rect.width / slideRect.width) * 1280).toFixed(1)),
    };
  })()`);
  report.picture = picture;
  if (!picture) fail("the picture on the first slide was not drawn");
  if (!picture.source.startsWith("data:image/png;base64,")) {
    fail(`the picture's source is ${picture.source}, not the picture's own bytes`);
  }
  if (Math.abs(picture.widthRatio - 400) > 2) {
    fail(`the picture is ${picture.widthRatio}px wide in the slide's space, not 400`);
  }

  // ---- A picture the webview cannot decode is named rather than left as a hole ----
  const undrawn = await evaluate(
    `(${VISIBLE})?.querySelector("[data-pptx-undrawn]")?.getAttribute("data-pptx-undrawn") ?? null`,
  );
  const undrawnSaid = await evaluate(
    `(${VISIBLE})?.innerText?.includes("未能显示") ?? false`,
  );
  // The metafile is on the first slide's rels and the slide has no `<img>` for it.
  const drawnPictures = await evaluate(
    `(${VISIBLE})?.querySelectorAll('[data-pptx-slide="0"] img').length ?? -1`,
  );
  report.undrawn = undrawn;
  if (undrawn !== "1") fail(`the deck reports ${JSON.stringify(undrawn)} pictures it could not draw, not one`);
  if (!undrawnSaid) fail("the pane drew a hole where the metafile is and said nothing about it");
  if (drawnPictures !== 1) fail(`the first slide drew ${drawnPictures} pictures, not the one it can decode`);

  // ---- A filled, rotated shape on the second slide ----
  const second = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="1"]');
    const shape = slide?.querySelector('[data-pptx-shape]');
    if (!shape) return null;
    const style = getComputedStyle(shape);
    return {
      background: style.backgroundColor,
      transform: style.transform,
      text: shape.innerText.trim(),
      kinds: slide.querySelectorAll('[data-pptx-shape]').length,
    };
  })()`);
  report.rotated = second;
  if (!second) fail("the second slide drew no shape");
  if (!second.background.startsWith("rgb(255, 255, 0)")) {
    fail(`the shape's fill is ${second.background}, not the yellow the file names`);
  }
  if (second.text !== "rotated") fail(`the second slide's shape reads ${JSON.stringify(second.text)}`);
  // 2 700 000 of a degree's 60 000ths is forty five degrees, which is a matrix with equal parts.
  const matrix = /matrix\(([^)]+)\)/.exec(second.transform);
  if (!matrix) fail(`the shape is not turned: transform ${second.transform}`);
  const [a, b] = matrix[1].split(",").map(Number);
  if (Math.abs(a - Math.SQRT1_2) > 0.01 || Math.abs(Math.abs(b) - Math.SQRT1_2) > 0.01) {
    fail(`the shape is not turned forty five degrees: ${second.transform}`);
  }

  // ---- A slide with nothing on it draws as an empty slide, not as a failure ----
  const empty = await evaluate(
    `(${VISIBLE})?.querySelector('[data-pptx-slide="2"]')?.querySelectorAll("[data-pptx-shape]").length ?? -1`,
  );
  report.emptySlide = empty;
  if (empty !== 0) fail(`the empty slide drew ${empty} shapes`);

  // ---- The zoom controls change the scale, and "fit width" puts it back ----
  const beforeZoom = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="0"]');
    return slide ? Math.round(slide.getBoundingClientRect().width) : -1;
  })()`);
  await evaluate(`(() => {
    const pane = ${VISIBLE};
    const buttons = [...pane.querySelectorAll("button")];
    buttons.find((el) => /放大|Zoom in/.test(el.innerText))?.click();
    return true;
  })()`);
  await sleep(400);
  const afterZoom = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="0"]');
    return slide ? Math.round(slide.getBoundingClientRect().width) : -1;
  })()`);
  await evaluate(`(() => {
    const pane = ${VISIBLE};
    const buttons = [...pane.querySelectorAll("button")];
    buttons.find((el) => /适应宽度|Fit width/.test(el.innerText))?.click();
    return true;
  })()`);
  await sleep(400);
  const afterFit = await evaluate(`(() => {
    const slide = (${VISIBLE})?.querySelector('[data-pptx-slide="0"]');
    return slide ? Math.round(slide.getBoundingClientRect().width) : -1;
  })()`);
  report.zoom = { beforeZoom, afterZoom, afterFit };
  if (afterZoom <= beforeZoom) fail(`zooming in did not widen the slide: ${beforeZoom} to ${afterZoom}`);
  if (Math.abs(afterFit - beforeZoom) > 3) {
    fail(`fit width did not return the slide to its fitted width: ${beforeZoom} then ${afterFit}`);
  }

  report.ok = true;
  console.log(
    "PASS: .pptx 当幻灯片读——按 sldIdLst 顺序逐张画；EMU 按 9525 换成像素（800x240@100,180 落位准确）；幻灯片盒子保持文件声明的 16:9；run 的加粗/字号(44pt)/字色/居中与段落缩进(lvl=1 → 48px)/项目符号/换行/转义字符都读对；图片按 slide 自己的 rels 找到 media 并以 data: URL 画出；画不出的图（WMF/EMF 等）不画但要报出张数；旋转 45°、纯色填充、空幻灯片、缩放与适应宽度都正确。",
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
