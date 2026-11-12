// Acceptance for the tray's screenshot item: a capture with the window out of the way.
//
// The requirement was "it should also work when minimised, in the tray, or unfocused", and the
// finding behind it was that only the *trigger* was missing - the grab reads the screen, so it never
// needed the app to be in front, and a shortcut cannot be typed into a window that does not have the
// focus. The tray menu is where a window out of the way can still be asked.
//
// What is driven here, and why it is not a synthesised tray click: an icon the user has not pinned
// lives in the overflow flyout, so there is no window to click without opening the flyout (the same
// reason `tray-return.mjs` drives the commands rather than the icon). The tray item and the page's
// own button both end in `screenshot::begin`, so this probe hides the main window - the state the
// item exists for - starts the capture through that shared function's command, drags a selection on
// the overlay and saves it. The menu *item* itself is covered by the Rust test that every menu id
// has an action, and by the label round-trip here: `tray_set_labels` rebuilds the menu with the new
// argument, so a caller left behind would reject.
//
// What the image has to be: a file that exists and is not empty, the selection's own size at this
// screen's scale, and a live screen rather than a veil or a black frame - a uniform picture is what
// the grey overlay, or a failed grab, would look like.
//
// The probe deletes the file it caused and leaves the window visible again.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/tray-screenshot.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const { execFileSync } = await import("node:child_process");
const fs = await import("node:fs");

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connect = async (target) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
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
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 160)}`,
      );
    }
    return result.result.value;
  };
  return { socket, send, evaluate };
};

const targets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(
    (t) => t.type === "page",
  );
const findTarget = (list, match) =>
  list.find((t) => t.url.includes(match)) ?? null;

/** The PNG's pixels, as RGB, on a grid - read by the shell's own imaging, not by the page. */
const samplePixels = (path, keys) => {
  const lines = [
    "Add-Type -AssemblyName System.Drawing",
    `$img = [System.Drawing.Image]::FromFile('${path.replace(/'/g, "''")}')`,
    "$bmp = New-Object System.Drawing.Bitmap $img",
    "$out = @()",
  ];
  for (const [fx, fy] of keys) {
    lines.push(
      `$c = $bmp.GetPixel([int]($bmp.Width * ${fx}), [int]($bmp.Height * ${fy})); $out += "$($c.R),$($c.G),$($c.B)"`,
    );
  }
  lines.push("$bmp.Dispose(); $img.Dispose()", '$out -join " "');
  const file = `${process.env.TEMP}\\tray-shot-pixels.ps1`;
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
      { encoding: "utf8" },
    ).trim();
    return raw
      .split(/\s+/)
      .filter(Boolean)
      .map((triple) => triple.split(",").map(Number));
  } finally {
    fs.rmSync(file, { force: true });
  }
};

let main = null;
let overlay = null;
let saved = null;
try {
  const list = await targets();
  // The main page exactly, not "any page on tauri.localhost": the capture overlay is served from
  // the same origin, and taking it for the main window answers every question from the one window
  // that has no permissions (the first run of this probe did exactly that, and the ACL refusal it
  // reported was honest - it was talking to `screenshot.html`).
  const mainTarget =
    list.find((t) => t.url === "http://tauri.localhost/") ??
    list.find((t) => t.url.includes("tauri.localhost/") && !t.url.includes("screenshot"));
  if (!mainTarget) fail("no main window");
  main = await connect(mainTarget);

  // ---- The label round-trip: the menu is rebuilt with three items or this rejects -------------
  report.labels = await main.evaluate(`(() =>
    window.__TAURI_INTERNALS__.invoke("tray_set_labels", {
      show: "显示主窗口",
      screenshot: "截图",
      quit: "退出",
    }).then(() => "ok").catch((error) => "ERR " + String(error)))()`);
  if (report.labels !== "ok") fail(`tray_set_labels rejected: ${report.labels}`);

  // ---- Watch for the save, then put the window out of the way ---------------------------------
  await main.evaluate(`(() => {
    window.__probeShots = [];
    return window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "screenshot:saved",
      target: { kind: "Any" },
      handler: window.__TAURI_INTERNALS__.transformCallback((event) => {
        window.__probeShots.push(event.payload);
      }),
    }).then((stop) => { window.__probeStop = stop; return true; });
  })()`);

  await main.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:window|hide", { label: "main" }).catch(() => null)`,
  );
  await sleep(500);
  report.hidden = await main.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }).catch(() => null)`,
  );
  if (report.hidden !== false) {
    fail(`the main window is still visible (${report.hidden}); the case is a window out of the way`);
  }

  // ---- Start the capture through the function the tray item calls -----------------------------
  report.begin = await main.evaluate(
    `window.__TAURI_INTERNALS__.invoke("screenshot_begin").then(() => "ok").catch((error) => "ERR " + String(error))`,
  );
  if (report.begin !== "ok") fail(`screenshot_begin failed with the window hidden: ${report.begin}`);

  let overlayTarget = null;
  for (let attempt = 0; attempt < 60 && !overlayTarget; attempt += 1) {
    overlayTarget = findTarget(await targets(), "screenshot.html");
    if (!overlayTarget) await sleep(250);
  }
  if (!overlayTarget) fail("the overlay window never appeared");
  overlay = await connect(overlayTarget);
  await overlay.send("Page.bringToFront");

  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
    ready = await overlay.evaluate(
      `document.readyState === "complete" && Boolean(document.querySelector('[data-screenshot-ui="backdrop"]'))`,
    );
    if (!ready) await sleep(200);
  }
  if (!ready) fail("the overlay never drew its backdrop");

  // The overlay is one window, kept alive between captures, so it may still be holding the last
  // selection - a person's or an earlier run's - and a press *inside* a box moves it rather than
  // drawing a new one, which would look like a drag that did nothing. Escape is what clears it (the
  // same key a person presses), and the capture is armed again so the state is known.
  const staleBox = () =>
    overlay.evaluate(`Boolean(document.querySelector('[data-screenshot-ui="box"]'))`);
  if (await staleBox()) {
    report.clearedStale = true;
    await overlay.evaluate(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
    );
    await sleep(500);
    report.rearmed = await main.evaluate(
      `window.__TAURI_INTERNALS__.invoke("screenshot_begin").then(() => "ok").catch((error) => "ERR " + String(error))`,
    );
    if (report.rearmed !== "ok") fail(`re-arming after a stale selection failed: ${report.rearmed}`);
    for (let attempt = 0; attempt < 40 && (await staleBox()); attempt += 1) await sleep(200);
  }
  if (await staleBox()) fail("the overlay kept a selection after Escape and a fresh arm");
  await sleep(300);

  // ---- Drag a selection, with real mouse input -----------------------------------------------
  const dprValue = await overlay.evaluate(`window.devicePixelRatio`);
  const from = { x: 300, y: 240 };
  const to = { x: 900, y: 620 };
  await overlay.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 6; step += 1) {
    await overlay.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(from.x + ((to.x - from.x) * step) / 6),
      y: Math.round(from.y + ((to.y - from.y) * step) / 6),
      button: "left",
      buttons: 1,
    });
    await sleep(60);
  }
  await overlay.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(300);

  const selection = JSON.parse(
    await overlay.evaluate(`(() => {
      const box = document.querySelector('[data-screenshot-ui="box"]');
      const style = box ? box.style : null;
      return JSON.stringify({
        drawn: Boolean(style && style.width && style.width !== "0px"),
        width: style ? Math.round(Number.parseFloat(style.width)) : 0,
        height: style ? Math.round(Number.parseFloat(style.height)) : 0,
      });
    })()`),
  );
  report.selection = { ...selection, dragged: { from, to } };
  if (!selection.drawn || selection.width < 100 || selection.height < 100) {
    fail(`the drag drew a ${selection.width}x${selection.height} box`);
  }

  // ---- Save, and wait for the window that owns the toast to be told --------------------------
  const pressed = await overlay.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((node) =>
      /保存|^save$/i.test((node.getAttribute("aria-label") || node.getAttribute("title") || "").trim()),
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!pressed) fail("the overlay has no save button");

  for (let attempt = 0; attempt < 80 && !saved; attempt += 1) {
    const shots = JSON.parse(await main.evaluate(`JSON.stringify(window.__probeShots ?? [])`));
    saved = shots.find((shot) => shot && shot.path) ?? null;
    if (!saved) await sleep(250);
  }
  report.saved = saved;
  if (!saved) fail("no screenshot:saved reached the main window");

  // ---- What landed on disk ------------------------------------------------------------------
  const stat = fs.statSync(saved.path);
  report.file = { path: saved.path, bytes: stat.size };
  if (stat.size === 0) fail("the saved file is empty");
  const wanted = {
    width: Math.round(selection.width * dprValue),
    height: Math.round(selection.height * dprValue),
  };
  report.dpr = dprValue;
  if (saved.width !== wanted.width || saved.height !== wanted.height) {
    fail(
      `the file is ${saved.width}x${saved.height}, the selection ${selection.width}x${selection.height} at ${dprValue}x = ${wanted.width}x${wanted.height}`,
    );
  }

  // A grid of samples, because the picture has to be a screen: the overlay's veil, a black frame
  // and a single flat colour are what a capture that included the app would look like.
  const keys = [];
  for (let row = 1; row <= 6; row += 1) {
    for (let column = 1; column <= 8; column += 1) {
      keys.push([column / 9, row / 7]);
    }
  }
  const pixels = samplePixels(saved.path, keys);
  report.pixels = { samples: pixels.length, distinct: new Set(pixels.map(String)).size };
  if (pixels.length !== keys.length) {
    fail(`read ${pixels.length} of ${keys.length} sample pixels`);
  }
  const luminance = pixels.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
  report.pixels.darkest = Math.round(Math.min(...luminance));
  report.pixels.brightest = Math.round(Math.max(...luminance));
  if (report.pixels.distinct < 6) {
    fail(
      `the picture is flat (${report.pixels.distinct} distinct colours over ${pixels.length} samples) - a veil or a failed grab`,
    );
  }
  if (report.pixels.brightest < 6) fail("the picture is black");

  report.ok = true;
  console.log(
    `PASS: 主窗口隐藏（is_visible=${report.hidden}）时截图仍能开始：托盘菜单三项标签回填成功，` +
      `覆盖层拖出 ${selection.width}x${selection.height} 的框并保存，screenshot:saved 到达主窗口，` +
      `文件 ${stat.size} 字节、${saved.width}x${saved.height}（= 选区 × ${dprValue}），` +
      `采样 ${pixels.length} 点有 ${report.pixels.distinct} 种颜色（亮度 ${report.pixels.darkest}-${report.pixels.brightest}），不是灰幕也不是黑帧。`,
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
    // The file is this probe's own doing, in the user's Pictures: take it back out.
    if (saved?.path) fs.rmSync(saved.path, { force: true });
    if (main) {
      await main.evaluate(`(() => {
        if (window.__probeStop) return window.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", { event: "screenshot:saved", eventId: window.__probeStop });
        return null;
      })()`);
      // Back on screen, in front: the window was only out of the way for this run.
      await main.evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:window|show", { label: "main" }).catch(() => null)`,
      );
      await main.evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }).catch(() => null)`,
      );
    }
  } catch {
    // The window may be gone; what it left behind is reported above.
  }
  overlay?.socket.close();
  main?.socket.close();
}
