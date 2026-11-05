// Acceptance for "the screenshot does not contain the screenshot tool".
//
// The overlay hides itself before the grab, but hiding only asks the compositor: on a frame that is
// slow to drop, the veil, the selection's outline and its handles were still on screen when the
// pixels were read. The user's own saved image (`Verta-2026-11-05-161604.png`) has the 2px outline
// and the four corner handles around a PDF toolbar.
//
// So this probe selects a region on the overlay for real, saves it with Enter, and then reads the
// saved PNG's outermost pixels - where a border can only come from the overlay - and compares them
// against the outline colour the overlay was drawing at the time. It cleans up the file it created.
//
// Usage: node scripts/dev/probes/screenshot-border.mjs [--port=9222]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const SHOTS = join(homedir(), "Pictures", "Screenshots");

/** The receiver for one CDP target: `send`/`evaluate`, and a way to close it. */
const attach = async (url) => {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
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
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? "";
      throw new Error(`页面里报错了：${description}`);
    }
    return result.result.value;
  };
  return { send, evaluate, close: () => socket.close() };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let overlayPage = null;
let saved = null;
let created = null;

try {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const main = targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  if (!main) {
    console.error("主窗口没找到：应用起来了吗？");
    process.exit(1);
  }
  const shell = await attach(main.webSocketDebuggerUrl);

  const before = existsSync(SHOTS)
    ? new Set(readdirSync(SHOTS).filter((n) => n.startsWith("Verta-")))
    : new Set();

  // Arm the overlay exactly as the header button does.
  await shell.evaluate(`window.__TAURI_INTERNALS__.invoke("screenshot_begin")`);

  // The overlay is a webview of its own, so it has a target of its own.
  for (let i = 0; i < 40 && !overlayPage; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    overlayPage = list.find((t) => t.type === "page" && t.url.includes("screenshot.html"));
    if (!overlayPage) await sleep(250);
  }
  if (!overlayPage) throw new Error("截图窗口没有出现");
  const overlay = await attach(overlayPage.webSocketDebuggerUrl);
  await overlay.send("Page.bringToFront");

  // The overlay's webview is built on the first screenshot of a session, so its page is still booting
  // when the target appears: dragging before React has mounted hit nothing and produced no box.
  let mounted = false;
  for (let i = 0; i < 80 && !mounted; i++) {
    mounted = await overlay.evaluate(
      `!!document.querySelector('[data-screenshot-ui="backdrop"]')`,
    );
    if (!mounted) await sleep(250);
  }
  if (!mounted) throw new Error("截图窗口的页面在 20 秒内没有挂上");
  await sleep(400);

  // Drag a box out, the way a hand does, and let the selection settle so the handles show.
  const from = { x: 320, y: 300 };
  const to = { x: 1040, y: 470 };
  await overlay.evaluate(`(() => {
    window.__pointerSeen = 0;
    window.addEventListener("pointerdown", () => { window.__pointerSeen += 1; }, true);
    return true;
  })()`);
  await overlay.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse",
  });
  for (let i = 1; i <= 12; i++) {
    const at = {
      x: Math.round(from.x + ((to.x - from.x) * i) / 12),
      y: Math.round(from.y + ((to.y - from.y) * i) / 12),
    };
    await overlay.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: at.x, y: at.y, button: "left", buttons: 1, pointerType: "mouse",
    });
    await sleep(25);
  }
  await overlay.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse",
  });
  await sleep(600);

  const box = await overlay.evaluate(`(() => {
    const node = document.querySelector('[data-screenshot-ui="box"]');
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      outline: style.outlineColor,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      handles: document.querySelectorAll('[aria-label]').length,
    };
  })()`);
  if (!box) {
    const seen = await overlay.evaluate(`window.__pointerSeen ?? 0`);
    throw new Error(`拖出选框之后没有找到选框（页面收到 ${seen} 次 pointerdown）`);
  }
  if (!box.width || !box.height) throw new Error("选框是空的");

  // Enter saves, as if the tick were clicked.
  for (const type of ["rawKeyDown", "keyUp"]) {
    await overlay.send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await sleep(80);
  }

  let file = null;
  for (let i = 0; i < 60 && !file; i++) {
    await sleep(250);
    if (!existsSync(SHOTS)) continue;
    const fresh = readdirSync(SHOTS)
      .filter((n) => n.startsWith("Verta-") && !before.has(n))
      .sort();
    if (fresh.length > 0) file = join(SHOTS, fresh[fresh.length - 1]);
  }
  if (!file || !existsSync(file)) throw new Error("按了回车之后没有新图片落盘");
  created = file;
  saved = { file, bytes: statSync(file).size };

  // The overlay's outline lands within a pixel of the crop's own edge, so the outer ring is where a
  // border can only come from the tool. Read it with System.Drawing: Node has no PNG decoder.
  const ring = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Bitmap]::FromFile('${file}')
$w = $img.Width; $h = $img.Height
$target = [System.Drawing.Color]::FromArgb(0, 0, 0)
if ('${box.outline}' -match 'rgba?\(([0-9]+),\s*([0-9]+),\s*([0-9]+)') {
  $target = [System.Drawing.Color]::FromArgb([int]$matches[1], [int]$matches[2], [int]$matches[3])
}
$ring = 3; $samples = 0; $near = 0; $brightest = 0
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    if ($x -ge $ring -and $x -lt ($w - $ring) -and $y -ge $ring -and $y -lt ($h - $ring)) { continue }
    $p = $img.GetPixel($x, $y)
    $samples++
    $d = [math]::Abs($p.R - $target.R) + [math]::Abs($p.G - $target.G) + [math]::Abs($p.B - $target.B)
    if ($d -le 60) { $near++ }
    $lum = [int]$p.R + [int]$p.G + [int]$p.B
    if ($lum -gt $brightest) { $brightest = $lum }
  }
}
$img.Dispose()
[pscustomobject]@{ width = $w; height = $h; ringSamples = $samples; nearOutline = $near; brightest = $brightest } | ConvertTo-Json -Compress
`,
    ],
    { encoding: "utf8" },
  );

  const parsed = JSON.parse(ring.trim());
  const report = {
    selection: { width: box.width, height: box.height, outline: box.outline },
    saved,
    image: parsed,
  };
  if (parsed.nearOutline > 0) {
    console.error(
      `FAIL: 存下来的图里还有选框的边——外圈 ${parsed.ringSamples} 个像素中有 ${parsed.nearOutline} 个与选框描边同色。`,
    );
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      `PASS: 截出来的是屏幕本身——外圈 ${parsed.ringSamples} 个像素里没有一个与选框描边（${box.outline}）同色，图 ${parsed.width}×${parsed.height}、${saved.bytes} 字节。`,
    );
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  if (error instanceof Error) {
    console.error(`FAIL: ${error.message}`);
  }
  process.exitCode = 1;
} finally {
  // The probe produced a real screenshot in the user's Pictures folder; it is a test artifact.
  if (created) rmSync(created, { force: true });
}
