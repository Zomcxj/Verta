// At the moment the opening cover disappears, what is on the screen?
//
// The cover exists to hide one line: the command that was just typed into the terminal.
// So the only question that matters is what the screen looks like the instant the cover
// is gone, and that is what this records - the terminal model's own text, the renderer's
// alternate-screen flag, and a photograph of the pane immediately after and a moment
// later (a single early picture can be a stale frame while an occluded window is not
// being repainted).
//
// Usage: node scripts/dev/probes/session-opening-lift.mjs --title="名字" [--seconds=14]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? null;
const seconds = Number(
  process.argv.find((a) => a.startsWith("--seconds="))?.slice(10) ?? "14",
);
const label = process.argv.find((a) => a.startsWith("--label="))?.slice(8) ?? "lift";
const dir = join(tmpdir(), `verta-lift-${label}`);
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

const SAMPLE = `
  ${MODULES}
  const area = document.querySelector("[data-terminal-area]");
  const box = area ? area.getBoundingClientRect() : null;
  const overlay = document.querySelector("[data-session-opening]");
  const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
  const leaf = visible ? visible.leafId : null;
  const screen = leaf === null ? null : (api.leafScreenTail(leaf) ?? "");
  return JSON.stringify({
    overlay: overlay ? overlay.getAttribute("data-session-opening-variant") : null,
    box: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
    leaf,
    alt: leaf === null ? null : api.leafUsesAlternateScreen(leaf),
    bytes: leaf === null ? null : api.leafOutputBytes(leaf),
    // The launch line for a resumed session carries the session flag; that is the text
    // the cover exists to hide.
    launchLineOnScreen: screen === null ? null : /--session/.test(screen),
    firstLines: screen === null ? null : screen.split(String.fromCharCode(10)).filter((l) => l.trim().length > 0).slice(0, 3),
  });
`;

const shoot = async (box, file) => {
  if (!box) return null;
  for (let i = 0; i < 2; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(box.x + 20 + i),
      y: Math.round(box.y + 20),
      buttons: 0,
    });
    await sleep(80);
  }
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  });
  if (!shot.result?.data) return null;
  writeFileSync(file, Buffer.from(shot.result.data, "base64"));
  return file;
};

const report = { label, title, dir };
try {
  await send("Page.bringToFront");
  await sleep(600);
  await pageEval(`
    ${PRESS}
    const rail = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === "会话",
    );
    if (rail) press(rail);
    return "ok";
  `);
  await sleep(2500);
  report.open = await pageEval(`
    ${PRESS}
    const row = [...document.querySelectorAll("button[data-session-id]")].find(
      (r) => (r.getAttribute("title") || "").trim() === ${JSON.stringify(title)},
    );
    if (!row) return "no-row";
    press(row);
    return (row.getAttribute("title") || "").trim();
  `);
  if (report.open === "no-row") throw new Error(`找不到会话行 ${title}`);

  const started = Date.now();
  let before = null;
  let after = null;
  while (Date.now() - started < seconds * 1000) {
    const sample = JSON.parse(await pageEval(SAMPLE));
    if (sample.overlay !== null) {
      before = { ms: Date.now() - started, ...sample };
      await sleep(100);
      continue;
    }
    if (sample.leaf !== null) {
      after = { ms: Date.now() - started, ...sample };
      break;
    }
    await sleep(100);
  }
  report.lastFrameWithCover = before
    ? { ms: before.ms, launchLineOnScreen: before.launchLineOnScreen, alt: before.alt }
    : null;
  report.firstFrameWithoutCover = after
    ? {
        ms: after.ms,
        launchLineOnScreen: after.launchLineOnScreen,
        alt: after.alt,
        firstLines: after.firstLines,
      }
    : null;
  if (after?.box) {
    report.shotImmediately = await shoot(after.box, join(dir, "immediately.png"));
    await sleep(700);
    report.shotLater = await shoot(after.box, join(dir, "later.png"));
  }
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();