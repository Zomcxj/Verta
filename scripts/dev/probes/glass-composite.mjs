// Acceptance for the one thing the other probes cannot see: whether the terminal's canvas is really
// blended with the page, as the SCREEN has it.
//
// Every other probe in this directory reads the document, and the document was right the whole time
// the acrylic shape showed a black rectangle in the middle of the window: `--terminal-background` was
// transparent, the surface's own background was transparent, the WebGL context had `alpha: true`, and
// `Page.captureScreenshot` - which samples the page - showed a translucent terminal. What the compositor
// did with that canvas is a different question, and the answer was "paint it opaque black", because the
// context had been created with `desynchronized: true` and such a canvas stops honouring its alpha.
//
// So this probe asks the screen. It paints an opaque magenta behind the terminal canvas - a known colour
// that depends on neither the wallpaper nor the theme's tint - and then looks at the screen: magenta
// where the terminal has no glyphs means the canvas is genuinely transparent, black means it is not.
//
// Windows only, because it reads the screen through PowerShell.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/glass-composite.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const STORE = "verta-settings.json";
const EVENT = "verta://prefs-changed";
const { execFileSync } = await import("node:child_process");
const fs = await import("node:fs");

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no main window: is the app running with --remote-debugging-port?");
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
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 160)}`,
    );
  }
  return result.result.value;
};
const invoke = (command, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => (value === undefined ? null : value)).catch((e) => "ERR " + String(e))`,
  );

/** Screen pixels at physical coordinates, through PowerShell. */
const screenColours = (points) => {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)",
    "$out = @()",
    `foreach ($p in @(${points.map((p) => `@(${p.x},${p.y})`).join(",")})) {`,
    "  $x = [Math]::Min([Math]::Max($p[0], 0), $b.Width - 1)",
    "  $y = [Math]::Min([Math]::Max($p[1], 0), $b.Height - 1)",
    "  $c = $bmp.GetPixel($x, $y)",
    '  $out += "$($c.R),$($c.G),$($c.B)"',
    "}",
    "$g.Dispose(); $bmp.Dispose()",
    'Write-Output ("screen:" + $b.Width + "x" + $b.Height)',
    '$out -join " | "',
  ].join("\n");
  const file = `${process.env.TEMP}\\verta-composite-sample.ps1`;
  fs.writeFileSync(file, script, "utf8");
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const screen = out.find((line) => line.startsWith("screen:")) ?? "screen:?";
  const colours = (out.find((line) => line.includes(",")) ?? "")
    .split("|")
    .map((one) => one.trim().split(",").map(Number));
  return { screen, colours };
};

const rid = await invoke("plugin:store|load", { path: STORE });
const store = typeof rid === "object" && rid !== null ? (rid.rid ?? rid) : rid;
if (typeof store === "string" && store.startsWith("ERR")) {
  fail(`the settings store would not open: ${store}`);
}
const read = async (key) => {
  const value = await invoke("plugin:store|get", { rid: store, key });
  return Array.isArray(value) ? (value[1] ? value[0] : undefined) : value;
};
const write = async (key, value) => {
  await invoke("plugin:store|set", { rid: store, key, value });
  await invoke("plugin:event|emit", { event: EVENT, payload: { key, value } });
};

const original = { shapeId: await read("shapeId"), cornerRadius: await read("cornerRadius") };
report.before = original;

/** Points on screen inside the terminal, and one in the right panel as a control. */
const samplePoints = async () => {
  const geometry = JSON.parse(
    await evaluate(`(() => {
      const surface = document.querySelector("[data-verta-terminal-surface]");
      if (!surface) return JSON.stringify(null);
      const r = surface.getBoundingClientRect();
      const other = document.querySelector('[data-shell="right"] .verta-pane').getBoundingClientRect();
      const frame = window.outerHeight - window.innerHeight;
      return JSON.stringify({
        origin: { x: window.screenX, y: window.screenY + frame },
        points: [
          { name: "term-left", x: Math.round(r.left + 40), y: Math.round(r.top + 200) },
          { name: "term-mid", x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 150) },
          { name: "term-right", x: Math.round(r.right - 80), y: Math.round(r.top + 320) },
          { name: "control", x: Math.round(other.left + 40), y: Math.round(other.top + 200) },
        ],
      });
    })()`),
  );
  if (!geometry) fail("no terminal on screen: open one in the main window and run this again");
  const { origin, points } = geometry;
  return {
    origin,
    physical: points.map((p) => ({ name: p.name, x: origin.x + p.x, y: origin.y + p.y })),
  };
};

/** Paints a known colour behind the terminal canvas, so the screen's answer does not depend on the
 * wallpaper or on the theme's tint. */
const paintBehind = (colour) =>
  evaluate(`(() => {
    let tag = document.getElementById("probe-composite");
    if (tag) tag.remove();
    if (${JSON.stringify(colour)} !== null) {
      tag = document.createElement("style");
      tag.id = "probe-composite";
      tag.textContent = "[data-shell] .verta-pane { background: " + ${JSON.stringify(colour)} + " !important }";
      document.head.appendChild(tag);
    }
    return true;
  })()`);

try {
  const geometry = await samplePoints();
  report.screen = geometry;
  await write("shapeId", "glass");
  await write("cornerRadius", "0");

  // ---- The square stop is where the black plate showed ----
  await paintBehind("rgb(255, 0, 255)");
  await sleep(900);
  const square = screenColours(geometry.physical);
  report.squareStop = square;
  const terminalPixels = square.colours.slice(0, 3);
  const control = square.colours[3];
  for (const [index, pixel] of terminalPixels.entries()) {
    const [r, g, b] = pixel;
    if (r === 0 && g === 0 && b === 0) {
      fail(
        `the terminal is opaque black on screen at ${geometry.physical[index].name} (${pixel.join(",")}) - the canvas is not being blended`,
      );
    }
    // Magenta where there is no glyph: the painted colour is reaching the screen through the canvas.
    if (r < 180 || g > 90 || b < 180) {
      fail(
        `the terminal does not show the colour behind it at ${geometry.physical[index].name}: ${pixel.join(",")}`,
      );
    }
  }
  report.control = control;

  // ---- And at a rounded stop, as the control that the canvas is otherwise fine ----
  await write("cornerRadius", "0.625rem");
  await sleep(900);
  const rounded = screenColours(geometry.physical);
  report.roundedStop = rounded;
  const roundedPixels = rounded.colours.slice(0, 3);
  for (const [index, pixel] of roundedPixels.entries()) {
    const [r, g, b] = pixel;
    if (r < 180 || g > 90 || b < 180) {
      fail(
        `the terminal does not show the colour behind it at ${geometry.physical[index].name} with a radius on: ${pixel.join(",")}`,
      );
    }
  }

  report.ok = true;
  console.log(
    `PASS: 终端画布真的和页面混在一起了（屏幕像素，不是调试器截图）——玻璃 + 圆角最低档 ${square.colours
      .slice(0, 3)
      .map((c) => c.join(","))
      .join(" / ")}、圆角 0.625rem ${roundedPixels.map((c) => c.join(",")).join(" / ")}，两者都能看见画在 canvas 后面的品红；` +
      `对照（右栏）${control.join(",")}；屏幕 ${square.screen}。跑完已还原。`,
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
    await paintBehind(null);
    if (original.shapeId === undefined) {
      await invoke("plugin:store|delete", { rid: store, key: "shapeId" });
      await invoke("plugin:event|emit", { event: EVENT, payload: { key: "shapeId", value: "auto" } });
    } else {
      await write("shapeId", original.shapeId);
    }
    if (original.cornerRadius === undefined) {
      await invoke("plugin:store|delete", { rid: store, key: "cornerRadius" });
      await invoke("plugin:event|emit", {
        event: EVENT,
        payload: { key: "cornerRadius", value: "0.625rem" },
      });
    } else {
      await write("cornerRadius", original.cornerRadius);
    }
  } catch {
    // The window may already be gone.
  }
  socket.close();
}
