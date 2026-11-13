// Acceptance for "a picture zooms continuously and drags", on the surface a diagram uses.
//
// Three stops are meant to be visible from the outside and are read here off the drawn box:
// `Fit` scales the picture to the pane (up as well as down), the magnification multiplies whichever
// stop is in force, and `1:1` with no magnification is the picture's own pixels. Then the drag: a
// picture bigger than its pane has to follow the left button, and the scrollport's own range has to
// be what stops it - a drag that runs past an edge would leave part of the picture somewhere no
// scroll reaches.
//
// The picture is a real one by default - the first image on the desktop, because a screenshot of a
// screen is what this pane is actually used for, and a photograph is what tells you whether the
// pixels landed where you expected. `--file=<path>` names another. With no image on the desktop the
// probe writes a solid PNG of a known size into a directory of its own under the system temp
// directory, so the arithmetic is still checkable, and removes it afterwards.
//
// Nothing on the machine is modified: the file is only read, no preference is touched, and the tab
// this run opened is closed again.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/image-zoom-pan.mjs [--port=9222] [--file=C:\path	o\picture.jpg]
import { deflateSync } from "node:zlib";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const TAG = Math.random().toString(36).slice(2, 8);
/** A picture of a known size, so the stops can be checked against arithmetic. */
const FALLBACK = { width: 1600, height: 1200 };
const DIR = mkdtempSync(join(tmpdir(), "verta-image-probe-"));

/** The desktop, as the shell sees it. */
const desktop = process.env.USERPROFILE
  ? join(process.env.USERPROFILE, "Desktop")
  : null;

/** The first picture on the desktop, or `null` when there is none. */
function pictureOnDesktop() {
  if (!desktop) return null;
  try {
    const name = readdirSync(desktop).find((entry) =>
      /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(entry),
    );
    return name ? join(desktop, name) : null;
  } catch {
    return null;
  }
}

const asked = process.argv.find((a) => a.startsWith("--file="))?.slice(7);
const SOURCE = asked ?? pictureOnDesktop();
/** The picture as this run opens it: a copy under a name of its own, so the tab is always fresh. */
const FIXTURE = SOURCE ? join(DIR, `picture-${TAG}${extname(SOURCE) || ".png"}`) : null;
// A real picture has no size this probe knows in advance; the size the browser reports is the one
// every check below is relative to, so only the fallback needs to be generated at a known size.
const GENERATED = FIXTURE === null;
const FILE = FIXTURE ?? join(DIR, `zoom-${TAG}.png`);
/** How the page identifies this run's picture, in `src` and in the tab strip. */
const NAME = FILE.split(/[\\/]/).pop();

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/** A solid-colour PNG of the given size: the smallest file that has a real `naturalWidth`. */
function solidPng(width, height, rgb = [40, 90, 160]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  // Each row: a filter byte, then three bytes per pixel.
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find(
    (t) => t.type === "page" && t.url.includes("tauri.localhost") && !t.url.includes("screenshot"),
  );
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

const VISIBLE = `(node) => !node.closest('[aria-hidden="true"]')`;

/**
 * The picture a name belongs to, the scrollport it is looked at through, and the pane above them.
 *
 * Found by `src` rather than by "the first picture on the page": more than one picture pane can be
 * on screen at once (a split, or a tab another run left behind), and reading the wrong one produces
 * a failure that says nothing about the picture this run opened.
 */
const pictureExpr = (name) => `(() => {
  const img = [...document.querySelectorAll('[data-slot="pan-zoom-surface"] img')]
    .find((n) => (n.currentSrc || n.src || "").includes(${JSON.stringify(name)}));
  if (!img) return null;
  const scroller = img.closest('[data-slot="pan-zoom-surface"]');
  return scroller ? { img, scroller, pane: scroller.parentElement } : null;
})()`;

/** The picture on screen, its drawn box, and the surface it scrolls in. */
const readPicture = (name = NAME) =>
  evaluate(`(() => {
    const found = ${pictureExpr(name)};
    if (!found) return JSON.stringify(null);
    const { img, scroller, pane } = found;
    const box = img.getBoundingClientRect();
    return JSON.stringify({
      natural: { w: img.naturalWidth, h: img.naturalHeight },
      // The border box, which is the size the component asked for: the stylesheet is border-box, so an
      // explicit width of 3072 is 3072 including the 1px border. Every check below is against this
      // number - it is the one imageScale computed and the one the pane has to fit.
      drawn: { w: Math.round(box.width), h: Math.round(box.height) },
      // What is drawn inside that border. Two pixels smaller in each axis than the declared size, which
      // is what the border costs; reported so a failure can be told from a box-model surprise.
      pixels: { w: img.clientWidth, h: img.clientHeight },
      style: { w: img.style.width, h: img.style.height },
      // What the header says the picture is, which is the size the component knows: without it the
      // failure reads as "the size is wrong" rather than "the size was never read".
      dims: ((pane.textContent || "").match(/\\d+\\s*x\\s*\\d+/) || [null])[0],
      // Both the control and the stop belong to *this* picture's header, not to whichever pane
      // happens to come first in the document.
      level: (pane.querySelector('[data-slot="diagram-zoom-level"]')?.textContent || "").trim(),
      fitStop: ([...pane.querySelectorAll("button")].find((b) => /^(原始大小|Original size|适应窗口|Fit to window)$/.test((b.innerText || "").trim()))?.innerText || "").trim(),
      scroll: {
        left: Math.round(scroller.scrollLeft),
        top: Math.round(scroller.scrollTop),
        maxLeft: Math.round(scroller.scrollWidth - scroller.clientWidth),
        maxTop: Math.round(scroller.scrollHeight - scroller.clientHeight),
      },
      room: {
        w: Math.round(scroller.clientWidth),
        h: Math.round(scroller.clientHeight),
      },
      // Where that room is on screen: a wheel has to be aimed at a point, and the content coordinate
      // under it is what the zoom has to hold still.
      roomLeft: Math.round(scroller.getBoundingClientRect().left),
      roomTop: Math.round(scroller.getBoundingClientRect().top),
      cursor: getComputedStyle(scroller).cursor,
      // The cursor's class list as well: "no grab cursor" and "the grab cursor was beaten by
      // something" are different failures and this is what tells them apart.
      cls: scroller.className,
      // Where to put a finger: the middle of the part of the picture that is actually on screen. A
      // 1:1 picture is wider than its pane, so the picture's own centre can be outside the window -
      // a press there lands on nothing.
      center: (() => {
        const room = scroller.getBoundingClientRect();
        const left = Math.max(box.left, room.left);
        const right = Math.min(box.right, room.right);
        const top = Math.max(box.top, room.top);
        const bottom = Math.min(box.bottom, room.bottom);
        return {
          x: Math.round((left + right) / 2),
          y: Math.round((top + bottom) / 2),
          visible: { w: Math.max(0, Math.round(right - left)), h: Math.max(0, Math.round(bottom - top)) },
        };
      })(),
    });
  })()`);

/** Presses a control in the picture's own header, by its slot or its label. */
const press = async (slotOrLabel, name = NAME) => {
  const pressed = await evaluate(`(() => {
    const found = ${pictureExpr(name)};
    if (!found || !found.pane) return false;
    const button = [...found.pane.querySelectorAll('[data-slot="${slotOrLabel}"]')].find(${VISIBLE})
      ?? [...found.pane.querySelectorAll("button")].filter(${VISIBLE})
        .find((b) => (b.innerText || "").trim() === ${JSON.stringify(slotOrLabel)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!pressed) return false;
  await sleep(320);
  return true;
};

/** A real pointer drag: press, several moves, release. */
const dragBy = async (fromX, fromY, dx, dy, steps = 6) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fromX, y: fromY, button: "none" });
  await sleep(40);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(40);
  for (let step = 1; step <= steps; step += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fromX + Math.round((dx * step) / steps),
      y: fromY + Math.round((dy * step) / steps),
      button: "left",
      buttons: 1,
    });
    await sleep(25);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: fromX + dx,
    y: fromY + dy,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(140);
};

const openedTabs = new Set();
const cleanup = () => rmSync(DIR, { recursive: true, force: true });
process.on("exit", cleanup);

try {
  // A copy rather than the file itself: opening the same path twice lands on the tab that is already
  // open, and whatever stop that tab was left on would be read as how a picture opens.
  if (GENERATED) writeFileSync(FILE, solidPng(FALLBACK.width, FALLBACK.height));
  else if (FIXTURE) copyFileSync(SOURCE, FILE);

  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(FILE)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail("the app has no IPC to hand a path to");
  const active = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(NAME)})`;
  if (!(await waitFor(active, 30000))) fail(`${NAME} never came forward as a tab`);
  const tabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tabId) openedTabs.add(tabId);

  const loaded = `(() => { const found = ${pictureExpr(NAME)}; const img = found && found.img; return !!img && img.complete && img.naturalWidth > 0; })()`;
  if (!(await waitFor(loaded, 20000))) fail("the picture never loaded");
  await sleep(400);

  // ---- Fit: the picture fills the room, scaled down from its own size ---------------------------
  const fitted = JSON.parse(await readPicture());
  report.fitted = fitted;
  report.picture = { source: SOURCE, opened: FILE, generated: GENERATED };
  const WIDTH = fitted.natural.w;
  const HEIGHT = fitted.natural.h;
  if (GENERATED && (WIDTH !== FALLBACK.width || HEIGHT !== FALLBACK.height)) {
    fail(`the fallback is ${FALLBACK.width}x${FALLBACK.height}, the picture reports ${WIDTH}x${HEIGHT}`);
  }
  if (WIDTH <= 0 || HEIGHT <= 0) fail("the picture reports no natural size");
  if (fitted.dims !== `${WIDTH} x ${HEIGHT}`) {
    // The header prints the size the component holds, which is the one the fit is computed from.
    fail(`the pane does not know how big the picture is: the header says ${fitted.dims}, the picture is ${WIDTH} x ${HEIGHT}`);
  }
  if (fitted.drawn.w > fitted.room.w + 1 || fitted.drawn.h > fitted.room.h + 1) {
    // The whole picture has to be inside the room at the fit stop, in both orientations: a picture
    // taller than it is wide is limited by the height, and reading only the width's ratio is what
    // left a tall one drawn at its own size and scrolled.
    fail(
      `the fit stop left the picture outside its room: drawn ${fitted.drawn.w}x${fitted.drawn.h} in ${fitted.room.w}x${fitted.room.h}`,
    );
  }
  if (
    Math.abs(fitted.drawn.w - fitted.room.w) > 2 &&
    Math.abs(fitted.drawn.h - fitted.room.h) > 2
  ) {
    // And it is fitted, not merely small: the fit is the smaller of the two ratios, so one axis comes
    // out at the room's own size. This is the half that "the picture is inside the room" cannot see,
    // and it is where a scale computed from a stale or unknown size shows up.
    fail(
      `the fit stop left the picture smaller than its room allows: drawn ${fitted.drawn.w}x${fitted.drawn.h} in ${fitted.room.w}x${fitted.room.h}`,
    );
  }
  if (fitted.level !== "100%") fail(`a picture does not open at 100%: the control reads ${fitted.level}`);

  // ---- The magnification multiplies whichever stop is in force ----------------------------------
  if (!(await press("diagram-zoom-in"))) fail("the picture has no zoom control");
  const zoomedIn = JSON.parse(await readPicture());
  report.zoomedIn = zoomedIn;
  if (zoomedIn.level !== "125%") fail(`one press should read 125%, the control reads ${zoomedIn.level}`);
  if (Math.abs(zoomedIn.drawn.w - fitted.drawn.w * 1.25) > Math.max(4, fitted.drawn.w * 0.04)) {
    fail(
      `the picture did not grow with the zoom: ${fitted.drawn.w} -> ${zoomedIn.drawn.w} at ${zoomedIn.level}`,
    );
  }
  if (!(await press("diagram-zoom-level"))) fail("the percentage is not a way back");
  const backToFit = JSON.parse(await readPicture());
  report.backToFit = backToFit;
  if (Math.abs(backToFit.drawn.w - fitted.drawn.w) > 2) {
    fail(`the percentage did not take the picture back: ${backToFit.drawn.w} vs ${fitted.drawn.w}`);
  }

  // ---- A magnification past the pane: the width grows with it, and the shape stays the shape -----
  // This is where a picture used to stretch rather than enlarge. The base layer caps every image at
  // its container's width, so the width stopped at the pane while the height kept going - the
  // picture came out distorted, and "zoom in" looked like "zoom in height only".
  await press("diagram-zoom-in");
  await press("diagram-zoom-in");
  const past = JSON.parse(await readPicture());
  report.past = past;
  if (past.level !== "156%") fail(`two presses from the fit stop should read 156%, the control reads ${past.level}`);
  if (past.drawn.w <= past.room.w) {
    fail(
      `a picture zoomed past its pane is still only as wide as the pane: drawn ${past.drawn.w} in ${past.room.w}`,
    );
  }
  const wanted = fitted.drawn.w * 1.5625;
  if (Math.abs(past.drawn.w - wanted) > Math.max(6, wanted * 0.04)) {
    fail(`the width did not grow with the zoom: ${fitted.drawn.w} -> ${past.drawn.w}, expected about ${Math.round(wanted)}`);
  }
  // The shape is the picture's own at every scale: a clamped width would show up here first.
  const wantedRatio = WIDTH / HEIGHT;
  const gotRatio = past.drawn.w / past.drawn.h;
  if (Math.abs(gotRatio - wantedRatio) > wantedRatio * 0.02) {
    fail(
      `the picture is distorted at ${past.level}: ${past.drawn.w}x${past.drawn.h} is ${gotRatio.toFixed(3)}, the picture is ${wantedRatio.toFixed(3)}`,
    );
  }

  // ---- 1:1 is the picture's own pixels ----------------------------------------------------------
  const oneToOneLabel = fitted.fitStop;
  if (!(await press(oneToOneLabel))) fail("the picture has no 1:1 stop");
  const actual = JSON.parse(await readPicture());
  report.actual = actual;
  // The declared size, not the content box: border-box means "set it to 3072" draws the picture across
  // 3070px plus a 1px frame, and the claim being checked is that 1:1 asks for the picture's own size.
  if (actual.drawn.w !== WIDTH || actual.drawn.h !== HEIGHT) {
    fail(
      `1:1 asked for ${actual.drawn.w}x${actual.drawn.h}, the picture is ${WIDTH}x${HEIGHT}`,
    );
  }

  // ---- And it drags, with the scroll range as the limit -----------------------------------------
  // The class the surface puts on itself is what is checked, plus the effect of the drag below: the
  // computed cursor can legitimately be overridden by whatever layer happens to be over the pane.
  if (!/cursor-grab|cursor-grabbing/.test(actual.cls || "")) {
    fail(
      `a picture bigger than its pane does not offer a drag: the surface is classed "${actual.cls}" and its cursor is ${actual.cursor}`,
    );
  }
  if (actual.center.visible.w < 20 || actual.center.visible.h < 20) {
    fail(`only ${actual.center.visible.w}x${actual.center.visible.h} of the picture is on screen, so there is nothing to drag`);
  }
  await dragBy(actual.center.x, actual.center.y, -200, -140);
  const dragged = JSON.parse(await readPicture());
  report.dragged = dragged;
  if (dragged.scroll.left - actual.scroll.left < 40 || dragged.scroll.top - actual.scroll.top < 20) {
    fail(
      `dragging 200x140 did not move the picture: ${JSON.stringify(actual.scroll)} -> ${JSON.stringify(dragged.scroll)}`,
    );
  }
  await dragBy(dragged.center.x, dragged.center.y, -6000, -6000);
  const pinned = JSON.parse(await readPicture());
  report.pinned = pinned;
  if (pinned.scroll.left !== pinned.scroll.maxLeft || pinned.scroll.top !== pinned.scroll.maxTop) {
    fail(
      `a drag past the edge did not stop at it: at (${pinned.scroll.left}, ${pinned.scroll.top}), the range ends at (${pinned.scroll.maxLeft}, ${pinned.scroll.maxTop})`,
    );
  }

  // ---- A wheel zoom keeps the point under the pointer where it is --------------------------------
  // The complaint this answers: zooming put the picture's top-left corner in view whatever the reader
  // was looking at, because the scrollport kept its offset (0, until the content overflows).
  // Back off the pinned corner first, so the anchor has room on both sides of it.
  await dragBy(pinned.center.x, pinned.center.y, 900, 700);
  const beforeWheel = JSON.parse(await readPicture());
  report.beforeWheel = beforeWheel;
  const wheelAt = {
    x: beforeWheel.roomLeft + Math.round(beforeWheel.room.w / 4),
    y: beforeWheel.roomTop + Math.round(beforeWheel.room.h / 4),
  };
  const heldX = beforeWheel.scroll.left + (wheelAt.x - beforeWheel.roomLeft);
  const heldY = beforeWheel.scroll.top + (wheelAt.y - beforeWheel.roomTop);
  await send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: wheelAt.x,
    y: wheelAt.y,
    deltaX: 0,
    deltaY: -120,
    // Alt = 1, Ctrl = 2, Meta = 4, Shift = 8: the chord the surface listens for.
    modifiers: 2,
  });
  await sleep(500);
  const wheeled = JSON.parse(await readPicture());
  report.wheeled = wheeled;
  if (wheeled.level !== "125%") {
    fail(`ctrl+wheel did not zoom: the control reads ${wheeled.level}`);
  }
  const ratio = 1.25;
  const gotX = (wheeled.scroll.left + (wheelAt.x - wheeled.roomLeft)) / ratio;
  const gotY = (wheeled.scroll.top + (wheelAt.y - wheeled.roomTop)) / ratio;
  if (Math.abs(gotX - heldX) > 6 || Math.abs(gotY - heldY) > 6) {
    fail(
      `the zoom did not hold the point under the pointer: it was looking at (${Math.round(heldX)}, ${Math.round(heldY)}) and now looks at (${Math.round(gotX)}, ${Math.round(gotY)})`,
    );
  }
  // The window itself must not have zoomed: a passive listener would have let the webview do it.
  if (wheeled.room.w !== beforeWheel.room.w || wheeled.room.h !== beforeWheel.room.h) {
    fail(
      `the pane changed size on a ctrl+wheel (${beforeWheel.room.w}x${beforeWheel.room.h} -> ${wheeled.room.w}x${wheeled.room.h}): the webview zoomed instead of the content`,
    );
  }
  // ---- A picture taller than it is wide: the other axis is the one that limits it ----------------
  // Run after the desktop picture so a failure here names the orientation.
  const tallFile = join(DIR, `tall-${TAG}.png`);
  writeFileSync(tallFile, solidPng(600, 1600));
  const tallAsked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(tallFile)}] }).then(() => true).catch(() => false)`,
  );
  if (!tallAsked) fail("the app has no IPC to hand a path to");
  const tallName = tallFile.split(/[\\/]/).pop();
  const tallActive = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(tallName)})`;
  if (!(await waitFor(tallActive, 30000))) fail(`${tallName} never came forward as a tab`);
  const tallTabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tallTabId) openedTabs.add(tallTabId);
  const tallLoaded = `(() => { const found = ${pictureExpr(tallName)}; const img = found && found.img; return !!img && img.complete && img.naturalWidth === 600; })()`;
  if (!(await waitFor(tallLoaded, 20000))) fail("the tall fixture never loaded");
  await sleep(400);
  const tall = JSON.parse(await readPicture(tallName));
  report.tall = tall;
  if (!tall) fail("the tall fixture is not on screen");
  if (tall.dims !== "600 x 1600") {
    fail(`the tall pane does not know how big its picture is: the header says ${tall.dims}`);
  }
  if (tall.drawn.h > tall.room.h + 1 || tall.drawn.w > tall.room.w + 1) {
    fail(
      `a picture taller than it is wide was not fitted: drawn ${tall.drawn.w}x${tall.drawn.h} in ${tall.room.w}x${tall.room.h}`,
    );
  }
  // Fitted means the *whole* picture is visible and the height is what the fit had to bring in.
  if (Math.abs(tall.drawn.h - tall.room.h) > 2) {
    fail(`the tall picture was not fitted to its room's height: ${tall.drawn.h} in ${tall.room.h}`);
  }
  // And it keeps its shape: 600x1600 stays 3:8 at every scale, the fit included.
  const tallRatio = tall.drawn.w / tall.drawn.h;
  if (Math.abs(tallRatio - 600 / 1600) > 0.02) {
    fail(
      `the tall picture is distorted: ${tall.drawn.w}x${tall.drawn.h} is ${tallRatio.toFixed(3)}, the picture is 0.375`,
    );
  }

  console.log(
    `PASS: 图片打开就适应窗口（${fitted.drawn.w}×${fitted.drawn.h}，原图 ${WIDTH}×${HEIGHT}）；放大一档到 ${zoomedIn.level} 时绘制 ${zoomedIn.drawn.w}px，点百分比回到 ${backToFit.drawn.w}px；继续放到 ${past.level} 宽度跟着长到 ${past.drawn.w}px（超过面板 ${past.room.w}px，长宽比仍与图一致）；切到「${oneToOneLabel}」后正好 ${actual.drawn.w}×${actual.drawn.h} 像素；左键拖动让滚动偏移从 (${actual.scroll.left}, ${actual.scroll.top}) 到 (${dragged.scroll.left}, ${dragged.scroll.top})，继续拖到头停在 (${pinned.scroll.left}, ${pinned.scroll.top}) = 可滚范围的尽头；ctrl+滚轮在指针处锚定放大到 ${wheeled.level}（指针下的内容点从 (${Math.round(heldX)}, ${Math.round(heldY)}) 到 (${Math.round(gotX)}, ${Math.round(gotY)})，窗口未被缩放）；竖图（${tall.natural.w}×${tall.natural.h}）在 ${tall.room.w}×${tall.room.h} 的面板里被适应成 ${tall.drawn.w}×${tall.drawn.h}；跑完已关掉本轮的标签。`,
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
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(el.getAttribute("data-tab-id"))) continue;
        // The close chip, not the first \`role="button"\` in the tab: that one is the file icon's
        // dropdown, and clicking it opens a menu instead of closing anything - which is how tabs from
        // earlier runs were still open, and how a probe ended up reading somebody else's pane.
        const chip =
          el.querySelector('[role="button"][aria-label]') ??
          el.querySelector('[role="button"][data-no-drag]:last-child');
        if (chip) chip.click();
      }
      return ids.length;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview still leaves the directory removed below, which is the part that matters.
  }
  cleanup();
  socket.close();
}
