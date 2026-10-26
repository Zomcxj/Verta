// Click a session in the list and photograph the terminal area, frame by frame, while
// the opening transition is up.
//
// The claim under test is visual: "during the animation you can still see the command
// that was typed into the terminal". Whether the terminal is hidden is a question about
// pixels, and the only honest answer is a picture of what was on screen at the time, so
// this captures the terminal area's own rectangle every 250 ms and keeps the frames
// where the transition layer was up.
//
// Usage: node scripts/dev/probes/session-opening-frames.mjs [--label=before]
// Frames land in %TEMP%\verta-opening-<label>\<n>.png, with the label and the frame's
// state printed as JSON.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? "run";
const rowIndex = Number(
  process.argv.find((a) => a.startsWith("--row="))?.slice(6) ?? "2",
);
/** Pick the row by its title instead of by position: the list re-sorts as sessions run. */
const rowTitle = process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = join(tmpdir(), `verta-opening-${label}`);
mkdirSync(dir, { recursive: true });

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (q) {
    pending.delete(m.id);
    q(m);
  }
});
const send = (method, params) =>
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result.result.value;
};

const PRESS = `
  window.__probe = window.__probe || {};
  window.__probe.press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
  var press = window.__probe.press;
`;

const STACK = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
`;

/** The terminal area's rectangle in CSS pixels, and what is up right now. */
const FRAME_STATE = `
  ${STACK}
  const area = document.querySelector("[data-terminal-area]");
  const box = area ? area.getBoundingClientRect() : null;
  const overlay = document.querySelector("[data-session-opening]");
  const active = document.querySelector("[data-terminal-tab]");
  const diagnostic = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
  const leaf = diagnostic ? diagnostic.leafId : null;
  return JSON.stringify({
    box: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
    overlay: overlay ? overlay.getAttribute("data-session-opening-variant") : null,
    activeTabOpacity: active ? getComputedStyle(active).opacity : "no-tab",
    areaOpacity: area ? getComputedStyle(area).opacity : "no-area",
    tabVisible: active ? getComputedStyle(active).visibility : "no-tab",
    leaf,
    tail: leaf === null ? null : (api.leafScreenTail(leaf) ?? "").split("\\n").slice(-3).join(" | "),
  });
`;

const report = { label, dir, frames: [] };
try {
  await send("Page.bringToFront");
  await sleep(600);

  // The sidebar has to be showing the session list for a row to click.
  report.launcher = await pageEval(`
    ${PRESS}
    const rail = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === "会话",
    );
    if (!rail) return "no-rail-button";
    press(rail);
    return "pressed";
  `);
  await sleep(2500);

  const rows = await pageEval(
    `return JSON.stringify([...document.querySelectorAll("button[data-session-id]")].map((r) => ({ id: r.getAttribute("data-session-id"), title: (r.getAttribute("title") || "").trim() })))`,
  );
  const listed = JSON.parse(rows);
  report.rowCount = listed.length;
  report.titles = listed.map((r) => r.title);
  const chosen = rowTitle
    ? listed.find((r) => r.title === rowTitle)
    : listed[rowIndex];
  report.target = chosen ? chosen.id : null;
  report.targetTitle = chosen ? chosen.title : null;
  if (!report.target) {
    throw new Error(`没有可点的会话行（--title=${rowTitle}）`);
  }

  // Nudge the page so an occluded window still repaints before the first capture.
  for (let i = 0; i < 2; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 400,
      y: 300,
      buttons: 0,
    });
    await sleep(150);
  }

  report.click = await pageEval(`
    ${PRESS}
    const row = document.querySelector('button[data-session-id="${report.target}"]');
    if (!row) return "no-row";
    press(row);
    return (row.getAttribute("title") || "").split("\\n")[0];
  `);

  const after = Date.now();
  for (let frame = 0; frame < 20; frame += 1) {
    await sleep(250);
    const state = JSON.parse(await pageEval(FRAME_STATE));
    const box = state.box;
    if (!box || box.w === 0) {
      report.frames.push({ frame, ms: Date.now() - after, state, shot: null });
      continue;
    }
    // A hidden window has its canvas dimmed and is not painted over; two synthesized
    // moves keep the frames coming.
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(box.x + 20 + frame),
      y: Math.round(box.y + 20),
      buttons: 0,
    });
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      clip: {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        scale: 1,
      },
    });
    const file = join(dir, `${String(frame).padStart(2, "0")}.png`);
    if (shot.result?.data) writeFileSync(file, Buffer.from(shot.result.data, "base64"));
    report.frames.push({
      frame,
      ms: Date.now() - after,
      state,
      shot: shot.result?.data ? file : null,
    });
  }
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();