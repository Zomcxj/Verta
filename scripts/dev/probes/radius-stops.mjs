// Acceptance for the corner-radius axis: seven stops that move every corner in the app, one radius
// for the whole window, and the one shape that has to answer differently - 无界, which merges the
// three regions and therefore rounds the merged block's outer frame instead of each pane.
//
// The numbers here are the honest ones: `--radius` is what the axis wrote, `--pane-radius` is what
// the stylesheet derived from it (`--radius * 1.4`), and the computed corner of a real pane is what
// the engine made of that. All three have to agree, and they have to agree with the stop that was
// chosen - a slider whose value and effect drift apart is the one thing a stop-based control cannot
// afford.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/radius-stops.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const STORE = "verta-settings.json";
const EVENT = "verta://prefs-changed";

/** The stops the settings offer, in order. Kept here so the probe cannot drift with the module. */
const STOPS = ["0", "0.25rem", "0.375rem", "0.5rem", "0.625rem", "0.875rem", "1rem"];
/** What `--pane-radius` is relative to `--radius` (see `globals.css`). */
const PANE_RATIO = 1.4;
/** 1rem at this app's root size, which is what the labels show in pixels. */
const REM_PX = 16;

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

/** What the shell currently says about its corners, per region. */
const readShell = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const corners = (node) => {
        const s = getComputedStyle(node);
        return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
      };
      // --pane-radius is a custom property, so what it holds is the expression, not a length: a
      // calc(0.5rem * 1.4) has to be *used* before the engine resolves it. The probe element is where
      // it gets used, which is also how the terminal reads its own tokens.
      const probe = document.createElement("span");
      probe.style.borderTopLeftRadius = "var(--pane-radius)";
      document.body.appendChild(probe);
      const resolved = getComputedStyle(probe).borderTopLeftRadius;
      probe.remove();
      const regions = {};
      for (const shell of ["sidebar", "workspace", "right"]) {
        const pane = document.querySelector('[data-shell="' + shell + '"] .verta-pane');
        const box = pane ? pane.getBoundingClientRect() : null;
        regions[shell] = pane && box && box.width > 0 ? corners(pane) : null;
      }
      return JSON.stringify({
        shape: root.getAttribute("data-shape"),
        radius: style.getPropertyValue("--radius").trim(),
        paneRadiusRaw: style.getPropertyValue("--pane-radius").trim(),
        paneRadius: resolved,
        windowRadius: style.getPropertyValue("--window-radius").trim(),
        terminalBackground: style.getPropertyValue("--terminal-background").trim(),
        regions,
      });
    })()`),
  );

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
/**
 * Puts a preference back, including "there was none".
 *
 * The delete has to be followed by an event carrying the app's own default: a window that is told
 * nothing keeps the value this probe last wrote, and the file and the screen would disagree until the
 * next launch.
 */
const restore = async (key, value, fallback) => {
  if (value === undefined) {
    await invoke("plugin:store|delete", { rid: store, key });
    await invoke("plugin:event|emit", {
      event: EVENT,
      payload: { key, value: fallback },
    });
    return;
  }
  await write(key, value);
};

const original = {
  cornerRadius: await read("cornerRadius"),
  shapeId: await read("shapeId"),
};
report.before = original;

/** The corners a `.verta-pane` in this region has, or null when the region is collapsed. */
const cornersOf = (shell, seen) => seen.regions[shell];

try {
  // ---- Every stop writes the value it promises, and the shell follows ----
  report.stops = {};
  let baselineWindowRadius = null;
  for (const stop of STOPS) {
    await write("cornerRadius", stop);
    await sleep(300);
    const seen = await readShell();
    report.stops[stop] = seen;
    if (seen.radius !== stop) {
      fail(`the stop ${stop} left --radius at ${JSON.stringify(seen.radius)}`);
    }
    baselineWindowRadius ??= seen.windowRadius;
    // The window's own corners belong to DWM: no stop may move them.
    if (seen.windowRadius !== baselineWindowRadius) {
      fail(`--window-radius moved from ${baselineWindowRadius} to ${seen.windowRadius} at ${stop}`);
    }
    const wanted = Number.parseFloat(stop) * REM_PX * PANE_RATIO;
    const actual = Number.parseFloat(seen.paneRadius);
    if (Math.abs(wanted - actual) > 0.51) {
      fail(`--pane-radius is ${seen.paneRadius} at ${stop}, not the ${wanted}px this radius implies`);
    }
    // `--radius` and its derivation have to reach a real pane, and all four of its corners.
    const corners = cornersOf("workspace", seen);
    if (!corners) fail("no workspace pane is on screen, so nothing can be measured");
    for (const corner of corners) {
      if (Math.abs(Number.parseFloat(corner) - actual) > 0.51) {
        fail(`a pane shows a ${corner} corner at ${stop} while --pane-radius is ${seen.paneRadius}`);
      }
    }
  }

  // ---- 无界: square inside, rounded outside, at whatever radius is chosen ----
  const mergedRadius = "0.5rem";
  await write("cornerRadius", mergedRadius);
  await write("shapeId", "boundless");
  await sleep(500);
  const merged = await readShell();
  report.merged = merged;
  if (merged.shape !== "boundless") {
    fail(`the window is in ${JSON.stringify(merged.shape)}, not the merged shape`);
  }
  const paneRadius = Number.parseFloat(merged.paneRadius);
  const expected = {
    sidebar: [merged.paneRadius, "0px", "0px", merged.paneRadius],
    workspace: ["0px", "0px", "0px", "0px"],
    right: ["0px", merged.paneRadius, merged.paneRadius, "0px"],
  };
  // A merged block whose radius did not resolve would pass the shapes below by accident.
  if (!(paneRadius > 0)) {
    fail(`--pane-radius resolved to ${merged.paneRadius} at ${mergedRadius}`);
  }
  const collapsed = [];
  for (const shell of ["sidebar", "workspace", "right"]) {
    const corners = cornersOf(shell, merged);
    if (!corners) {
      // A collapsed region has no width to judge, and that is a recorded known item rather than a
      // failure. The workspace is never collapsed, so it always carries the assertion.
      if (shell === "workspace") fail("the workspace region has no width, so nothing can be judged");
      collapsed.push(shell);
      continue;
    }
    if (corners.join(" ") !== expected[shell].join(" ")) {
      fail(
        `${shell} at ${mergedRadius} shows ${corners.join(" ")} - the merged block wants ${expected[shell].join(" ")}`,
      );
    }
  }
  // And the merge is real: the gutters are still closed with a radius on.
  const mergedGutters = await evaluate(`(() => {
    const widths = [...document.querySelectorAll('[data-slot="resizable-handle"]')].map(
      (node) => getComputedStyle(node).width,
    );
    return JSON.stringify(widths);
  })()`);
  report.mergedHandles = JSON.parse(mergedGutters);
  report.mergedCollapsed = collapsed;
  if (!report.mergedHandles.every((width) => width === "0px")) {
    fail(`the merged shape left handles between the panes: ${mergedGutters}`);
  }
  if (!(paneRadius > 0)) fail("a merged block with a radius of zero would prove nothing");

  // ---- The other axis that shares this document: the material's clear terminal ----
  await write("cornerRadius", "0.625rem");
  await write("shapeId", "glass");
  await sleep(500);
  const glass = await readShell();
  report.glass = glass;
  if (glass.terminalBackground !== "transparent") {
    fail(`the glass shape left the terminal at ${JSON.stringify(glass.terminalBackground)}`);
  }

  report.ok = true;
  const summary = STOPS.map(
    (stop) => `${Math.round(Number.parseFloat(stop) * REM_PX)}px→${report.stops[stop].paneRadius}`,
  ).join(" ");
  console.log(
    `PASS: 圆角轴七挡都落在真面板上——${summary}；面板圆角全角一致；--window-radius 全程 ${baselineWindowRadius}；无界在 ${mergedRadius} 下（--pane-radius ${merged.paneRadius}）左栏 ${cornersOf("sidebar", merged).join("/")}、工作区 ${cornersOf("workspace", merged).join("/")}、右栏 ${cornersOf("right", merged).join("/")}，两个手柄仍 ${report.mergedHandles.join("/")}${collapsed.length > 0 ? `（${collapsed.join("/")} 折叠，未判）` : ""}；玻璃下终端仍透明。跑完已还原。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // The user's own radius and shape go back, including "there was none".
  try {
    await restore("cornerRadius", original.cornerRadius, "0.625rem");
    await restore("shapeId", original.shapeId, "auto");
  } catch {
    // The window may already be gone.
  }
  socket.close();
}
