// Photograph the terminal area right now, and say what the terminal model holds.
//
// Two different truths can disagree: what the renderer has painted (the canvas) and what
// the terminal model says is on screen. A stale capture and a canvas that stopped
// repainting look the same in one picture, so this prints both next to each other: the
// picture, and the model's own text for the same leaf.
//
// Usage: node scripts/dev/probes/terminal-shot.mjs --label=now
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? "shot";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = join(tmpdir(), `verta-shot-${label}`);
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

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
`;

const report = { label, dir };
try {
  await send("Page.bringToFront");
  await sleep(500);
  // An occluded window is not repainted, so nudge it with a real pointer move before
  // asking for a picture.
  for (let i = 0; i < 3; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 400 + i * 3,
      y: 300,
      buttons: 0,
    });
    await sleep(120);
  }
  await sleep(400);

  const state = JSON.parse(
    await pageEval(`
      ${MODULES}
      const area = document.querySelector("[data-terminal-area]");
      const box = area ? area.getBoundingClientRect() : null;
      const overlay = document.querySelector("[data-session-opening]");
      const active = document.querySelector("[data-terminal-tab]");
      const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
      const leaf = visible ? visible.leafId : null;
      return JSON.stringify({
        box: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
        overlay: overlay ? overlay.getAttribute("data-session-opening-variant") : null,
        tabOpacity: active ? getComputedStyle(active).opacity : null,
        areaOpacity: area ? getComputedStyle(area).opacity : null,
        leaf,
        screenFirst: leaf === null ? null : (api.leafScreenTail(leaf) ?? "").split(String.fromCharCode(10)).slice(0, 3).join(" | "),
        screenHasChild: leaf === null ? null : (api.leafScreenTail(leaf) ?? "").length,
        alt: leaf === null ? null : api.leafUsesAlternateScreen(leaf),
      });
    `),
  );
  report.state = state;

  if (state.box && state.box.w > 0) {
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      clip: {
        x: state.box.x,
        y: state.box.y,
        width: state.box.w,
        height: state.box.h,
        scale: 1,
      },
    });
    if (shot.result?.data) {
      report.shot = join(dir, "shot.png");
      writeFileSync(report.shot, Buffer.from(shot.result.data, "base64"));
    }
  }
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();