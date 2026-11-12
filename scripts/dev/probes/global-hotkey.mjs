// Acceptance for the screenshot's *global* hotkey: the window out of the way, and the chord still
// starts a capture.
//
// The window listener (`useGlobalShortcuts`) hears keys only while the window has the focus, which is
// the operating system's rule rather than a bug in the page - so the chord is registered with the
// system instead (`RegisterHotKey`), and the system delivers it wherever the keyboard is. What this
// probe proves, state by state:
//
//   hidden      the main window is not on screen at all (`plugin:window|hide`), and the chord still
//               arms the overlay;
//   minimised   the same, with the window minimised instead of hidden;
//   unfocused   the window is on screen but another one of the app's own windows has the focus, and
//               this is the state a *whole* capture is completed in - file, size and pixels.
//
// Arming is what each of the three states proves: the chord the system delivers, with the window out
// of the way, is the thing that was missing. The drag is driven once, from the third state, because
// while the main window is hidden the browser stops delivering most of a synthesised move sequence to
// the overlay - the first move lands, the rest are dropped - and that is a property of the automation
// rather than of the app. A capture started this way completes like any other, and `tray-screenshot.mjs`
// covers a full one with the window hidden.
//
// The keystroke is real: `SendKeys` goes through the system's input queue, which is the only way to
// reach a global hotkey - a key event synthesised in the page would never leave the page. The chord
// it sends is the one the user's own settings hold for `screenshot.capture`, read from the store, and
// what is watched for is the overlay's own `screenshot:armed` message rather than a window that may
// merely have been left open by an earlier run.
//
// The probe registers the chord itself (so the chord tested is the chord held), restores the user's
// binding and window at the end, and deletes the screenshot it caused.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/global-hotkey.mjs [--port=9222]
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
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) => t.type === "page");
const mainTarget = async () => {
  const list = await targets();
  // `http://tauri.localhost/` exactly: the capture overlay is served from the same origin.
  return (
    list.find((t) => t.url === "http://tauri.localhost/") ??
    list.find((t) => t.url.includes("tauri.localhost/") && !t.url.includes("screenshot") && !t.url.includes("settings"))
  );
};
const overlayTarget = async () =>
  (await targets()).find((t) => t.url.includes("screenshot.html")) ?? null;

/** The chord, as the keystroke `SendKeys` spells: `%` is Alt, `^` Ctrl, `+` Shift. */
const sendKeys = (chord) => {
  const modifier = `${chord.alt ? "%" : ""}${chord.ctrl ? "^" : ""}${chord.shift ? "+" : ""}`;
  if (!modifier) fail("the chord has no modifier to send");
  const file = `${process.env.TEMP}\\verta-sendkeys.ps1`;
  fs.writeFileSync(
    file,
    [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.SendKeys]::SendWait('${modifier}${chord.key.toLowerCase()}')`,
    ].join("\n"),
    "utf8",
  );
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file], {
      encoding: "utf8",
      timeout: 15000,
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
};

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
  const file = `${process.env.TEMP}\\verta-hotkey-pixels.ps1`;
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  try {
    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
      { encoding: "utf8" },
    )
      .trim()
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
let userBinding = null;
try {
  main = await connect((await mainTarget()) ?? fail("no main window"));

  // ---- The chord the user's own settings hold ------------------------------------------------
  const stored = await main.evaluate(`(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:store|load", { path: "verta-settings.json" })
      .then((r) => {
        const handle = typeof r === "object" && r !== null ? (r.rid ?? r) : r;
        return window.__TAURI_INTERNALS__.invoke("plugin:store|get", { rid: handle, key: "shortcuts" });
      })
      .then((row) => {
        const value = Array.isArray(row) ? (row[1] ? row[0] : null) : row;
        return JSON.stringify(value?.["screenshot.capture"]?.[0] ?? null);
      })
      .catch(() => null))()`);
  userBinding = JSON.parse(stored) ?? { alt: true, key: "a" };
  report.binding = userBinding;

  const register = (chord) =>
    main.evaluate(`(() =>
      window.__TAURI_INTERNALS__.invoke("screenshot_set_global_hotkey", { chord: ${JSON.stringify(chord)} })
        .then(() => "ok")
        .catch((error) => "ERR " + String(error)))()`);

  // A chord this cannot express has to be refused, or the refusal below would mean nothing.
  report.refused = await register({ alt: false, ctrl: false, shift: false, meta: false, key: "a" });
  if (!String(report.refused).startsWith("ERR")) {
    fail(`a bare key was accepted as a global hotkey: ${report.refused}`);
  }
  report.registered = await register(userBinding);
  if (report.registered !== "ok") {
    fail(`the system refused the user's own chord (${JSON.stringify(userBinding)}): ${report.registered}`);
  }

  // ---- The overlay, kept open so its own arming message can be counted ------------------------
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("screenshot_begin").catch(() => null)`);
  let armed = 0;
  for (let attempt = 0; attempt < 60 && !armed; attempt += 1) {
    const target = await overlayTarget();
    if (target) overlay = await connect(target);
    if (overlay) {
      armed = await overlay.evaluate(`(() => {
        if (window.__probeArmed !== undefined) return window.__probeArmed;
        window.__probeArmed = 0;
        window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
          event: "screenshot:armed",
          target: { kind: "Any" },
          handler: window.__TAURI_INTERNALS__.transformCallback(() => { window.__probeArmed += 1; }),
        }).catch(() => null);
        return window.__probeArmed;
      })()`);
    }
    if (!armed && !overlay) await sleep(250);
    if (!overlay) await sleep(250);
  }
  if (!overlay) fail("the overlay window never appeared, so there is nothing to listen on");
  // Armed once by that first capture: put it away again and take a reading of the counter.
  await overlay.evaluate(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  await sleep(600);
  const armedBefore = await overlay.evaluate(`window.__probeArmed ?? 0`);
  report.armedBefore = armedBefore;

  /** Fire the chord for real, and answer whether the overlay was armed by it. */
  const fireAndWait = async (label) => {
    const before = await overlay.evaluate(`window.__probeArmed ?? 0`);
    sendKeys(userBinding);
    let after = before;
    for (let attempt = 0; attempt < 30 && after === before; attempt += 1) {
      await sleep(200);
      after = await overlay.evaluate(`window.__probeArmed ?? 0`);
    }
    return { before, after, armed: after > before, label };
  };

  // ---- Hidden ---------------------------------------------------------------------------------
  await main.send("Page.bringToFront");
  await main.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:window|hide", { label: "main" }).catch(() => null)`,
  );
  await sleep(500);
  report.hiddenVisible = await main.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }).catch(() => null)`,
  );
  if (report.hiddenVisible !== false) fail("the main window is still visible for the hidden case");
  report.states = {};
  report.states.hidden = await fireAndWait("hidden");
  if (!report.states.hidden.armed) {
    fail(`the chord did not arm the overlay while the window was hidden: ${JSON.stringify(report.states.hidden)}`);
  }

  // Put it away again; the states below are each a fresh arming.
  await overlay.evaluate(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  await sleep(500);

  // ---- Minimised ------------------------------------------------------------------------------
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|show", { label: "main" }).catch(() => null)`);
  await sleep(300);
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|minimize", { label: "main" }).catch(() => null)`);
  await sleep(700);
  report.states.minimised = await fireAndWait("minimised");
  if (!report.states.minimised.armed) {
    fail(`the chord did not arm the overlay while the window was minimised: ${JSON.stringify(report.states.minimised)}`);
  }
  await overlay.evaluate(
    `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
  );
  await sleep(500);

  // ---- On screen but not focused ---------------------------------------------------------------
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|unminimize", { label: "main" }).catch(() => null)`);
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }).catch(() => null)`);
  await sleep(400);
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("open_settings_window", { tab: "general" }).catch(() => null)`);
  let settings = null;
  for (let attempt = 0; attempt < 40 && !settings; attempt += 1) {
    const target = (await targets()).find((t) => t.url.includes("settings.html"));
    if (target) settings = await connect(target);
    else await sleep(250);
  }
  if (!settings) fail("the settings window never opened, so nothing else could take the focus");
  await settings.send("Page.bringToFront");
  await sleep(500);
  report.states.unfocused = await fireAndWait("unfocused");
  if (!report.states.unfocused.armed) {
    fail(`the chord did not arm the overlay while another window had the focus: ${JSON.stringify(report.states.unfocused)}`);
  }

  // ---- A whole capture, started by the chord ---------------------------------------------------
  await sleep(400);
  const dpr = await overlay.evaluate(`window.devicePixelRatio`);
  const clearBox = async () => {
    if (await overlay.evaluate(`Boolean(document.querySelector('[data-screenshot-ui="box"]'))`)) {
      await overlay.evaluate(
        `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`,
      );
      await sleep(400);
      await main.evaluate(`window.__TAURI_INTERNALS__.invoke("screenshot_begin").catch(() => null)`);
      await sleep(700);
    }
  };
  await clearBox();
  const drag = async () => {
    const from = { x: 320, y: 260 };
    const to = { x: 920, y: 640 };
    await overlay.send("Page.bringToFront");
    await overlay.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      await overlay.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(from.x + ((to.x - from.x) * step) / 6),
        y: Math.round(from.y + ((to.y - from.y) * step) / 6),
        button: "left",
        buttons: 1,
      });
      await sleep(120);
    }
    await overlay.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(400);
    return JSON.parse(
      await overlay.evaluate(`(() => {
        const box = document.querySelector('[data-screenshot-ui="box"]');
        const style = box ? box.style : null;
        return JSON.stringify({
          width: style ? Math.round(Number.parseFloat(style.width)) : 0,
          height: style ? Math.round(Number.parseFloat(style.height)) : 0,
        });
      })()`),
    );
  };
  let selection = await drag();
  // The browser stops delivering a synthesised move sequence to a window it has decided is behind
  // something else; a second attempt from a cleared overlay is what makes this leg reliable rather
  // than flaky.
  for (let attempt = 0; attempt < 2 && selection.width < 100; attempt += 1) {
    await clearBox();
    selection = await drag();
  }
  report.selection = selection;
  if (selection.width < 100 || selection.height < 100) {
    fail(`the drag drew a ${selection.width}x${selection.height} box`);
  }
  await main.evaluate(`(() => {
    window.__probeShots = [];
    return window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
      event: "screenshot:saved",
      target: { kind: "Any" },
      handler: window.__TAURI_INTERNALS__.transformCallback((event) => { window.__probeShots.push(event.payload); }),
    }).then((stop) => { window.__probeStop = stop; return true; });
  })()`);
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
    saved = shots.find((shot) => shot?.path) ?? null;
    if (!saved) await sleep(250);
  }
  report.saved = saved;
  if (!saved) fail("the capture the chord started never saved");
  const stat = fs.statSync(saved.path);
  report.file = { path: saved.path, bytes: stat.size, width: saved.width, height: saved.height };
  if (stat.size === 0) fail("the saved file is empty");
  if (saved.width !== Math.round(selection.width * dpr) || saved.height !== Math.round(selection.height * dpr)) {
    fail(`the file is ${saved.width}x${saved.height}, the selection ${selection.width}x${selection.height} at ${dpr}x`);
  }
  const keys = [];
  for (let row = 1; row <= 6; row += 1) for (let column = 1; column <= 8; column += 1) keys.push([column / 9, row / 7]);
  const pixels = samplePixels(saved.path, keys);
  const distinct = new Set(pixels.map(String)).size;
  report.pixels = { samples: pixels.length, distinct };
  if (distinct < 6) fail(`the picture is flat (${distinct} distinct colours over ${pixels.length} samples)`);

  report.ok = true;
  console.log(
    `PASS: 截图全局快捷键在三种「不在前台」的状态下都能启动截图——键位 ${JSON.stringify(report.binding)}（无修饰键的裸键被拒绝：${report.refused}），` +
      `隐藏（is_visible=${report.hiddenVisible}）/ 最小化 / 被设置窗口抢焦点时各命中一次（armed ${report.armedBefore} → ${report.states.hidden.after} / ${report.states.minimised.after} / ${report.states.unfocused.after}）；` +
      `再由快捷键起一次完整截图：拖 ${selection.width}x${selection.height}、文件 ${stat.size} 字节 ${saved.width}x${saved.height}、采样 ${pixels.length} 点 ${distinct} 色。`,
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
    if (saved?.path) fs.rmSync(saved.path, { force: true });
    if (main) {
      // The user's own chord back in the shell's hands, window back on screen.
      await main.evaluate(`(() =>
        window.__TAURI_INTERNALS__.invoke("screenshot_set_global_hotkey", { chord: ${JSON.stringify(userBinding)} }).catch(() => null))()`);
      await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|show", { label: "main" }).catch(() => null)`);
      await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|unminimize", { label: "main" }).catch(() => null)`);
      await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|set_focus", { label: "main" }).catch(() => null)`);
      await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "settings" }).catch(() => null)`);
    }
  } catch {
    // The window may be gone; what it left behind is reported above.
  }
  overlay?.socket.close();
  main?.socket.close();
}
