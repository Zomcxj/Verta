// Acceptance for the shape axis: choosing a shape moves the corners, the borders and the shadows,
// and a theme that spells its own radius keeps it.
//
// The picker does not exist yet, so this drives the same two steps a picker takes - the value written
// to the settings store, and the `verta://prefs-changed` event the store emits so every window follows
// - and then reads what the document carries: `data-shape`, `--radius`, `--pane-border-width`, and
// the computed border and corner radius of a real pane.
//
// Two things worth stating in the numbers: the default (`auto`, no theme suggesting a shape) has to
// leave the shell exactly as it was before the axis - `second verse, same as the first` - and
// `minimal` must not touch `--window-radius`, because the window's corners belong to DWM and a pane
// that asks for square corners does not get to un-round the window.
//
// The user's stored value is read first and written back at the end, including "there was none".
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/theme-shape.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const STORE = "verta-settings.json";
const PREF_KEY = "shapeId";
const EVENT = "verta://prefs-changed";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/** The presets as the stylesheet receives them, so the numbers below have something to be wrong about. */
const SHAPES = {
  soft: { radius: "0.625rem", border: "1px" },
  fine: { radius: "0.375rem", border: "0.5px" },
  minimal: { radius: "0", border: "0px" },
  tag: { radius: "1.25rem", border: "0.5px" },
  emboss: { radius: "0.5rem", border: "1px" },
  glass: { radius: "0.5rem", border: "1px" },
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
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
    throw new Error(
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 200)}`,
    );
  }
  return result.result.value;
};
const invoke = (command, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => (value === undefined ? null : value)).catch((e) => "ERR " + String(e))`,
  );

/**
 * The settings store, opened as a resource.
 *
 * The plugin's commands are addressed by `rid` - the id `plugin:store|load` hands back - not by path,
 * so a probe that calls `set` with a path is told `missing required key rid` and tests nothing.
 */
let rid = null;
const openStore = async () => {
  const loaded = await invoke("plugin:store|load", { path: STORE });
  if (typeof loaded === "string" && loaded.startsWith("ERR")) {
    fail(`the settings store would not open: ${loaded}`);
  }
  rid = typeof loaded === "object" && loaded !== null ? (loaded.rid ?? loaded) : loaded;
  return rid;
};

/** Everything the shell currently says about its own geometry. */
const readShell = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const panes = [...document.querySelectorAll(".verta-pane")].filter((node) => {
        for (let el = node; el; el = el.parentElement) {
          const s = getComputedStyle(el);
          if (s.visibility === "hidden" || s.display === "none") return false;
        }
        return node.getBoundingClientRect().width > 0;
      });
      const pane = panes[0] ?? null;
      const paneStyle = pane ? getComputedStyle(pane) : null;
      return JSON.stringify({
        shape: root.getAttribute("data-shape"),
        material: root.getAttribute("data-shape-material"),
        radius: style.getPropertyValue("--radius").trim(),
        paneRadius: style.getPropertyValue("--pane-radius").trim(),
        borderWidth: style.getPropertyValue("--pane-border-width").trim(),
        windowRadius: style.getPropertyValue("--window-radius").trim(),
        accentBar: style.getPropertyValue("--accent-bar").trim(),
        cardShadow: style.getPropertyValue("--card-shadow").trim(),
        paneCount: panes.length,
        paneBorder: paneStyle ? paneStyle.borderTopWidth : null,
        paneCorner: paneStyle ? paneStyle.borderTopLeftRadius : null,
      });
    })()`),
  );

/** Give the preference the value a settings write would, and tell the window, as the store does. */
const chooseShape = async (value) => {
  const written = await invoke("plugin:store|set", { rid, key: PREF_KEY, value });
  if (typeof written === "string" && written.startsWith("ERR")) {
    fail(`the settings store refused ${value}: ${written}`);
  }
  const emitted = await invoke("plugin:event|emit", {
    event: EVENT,
    payload: { key: PREF_KEY, value },
  });
  if (typeof emitted === "string" && emitted.startsWith("ERR")) {
    fail(`the preferences event refused ${value}: ${emitted}`);
  }
  await sleep(250);
  return readShell();
};

let original;
try {
  await openStore();
  const stored = await invoke("plugin:store|get", { rid, key: PREF_KEY });
  // The plugin answers a `get` with `[value, exists]`, so "was anything stored" is the second element
  // and `null` alone would not tell an absent key from a key holding null.
  original = Array.isArray(stored) ? (stored[1] ? stored[0] : undefined) : stored;
  report.storedBefore = original ?? null;

  const baseline = await readShell();
  report.baseline = baseline;
  if (baseline.paneCount === 0) fail("no pane is on screen, so there is nothing to measure");

  // ---- The default leaves the shell exactly as it was before the axis ----
  if (baseline.shape !== "soft") {
    fail(
      `the shell is ${JSON.stringify(baseline.shape)} with nothing chosen; a fresh install has to be soft`,
    );
  }
  if (baseline.borderWidth !== "1px") {
    fail(`the default border width is ${JSON.stringify(baseline.borderWidth)}, not the 1px it was`);
  }
  if (baseline.paneBorder !== "1px") {
    fail(`a pane draws a ${baseline.paneBorder} border by default, not the 1px it was`);
  }
  // A theme may spell its own radius; when it does, no shape is allowed to overwrite it.
  const themeSpeaksRadius = baseline.radius !== "" && baseline.radius !== SHAPES.soft.radius;
  report.themeSpeaksRadius = themeSpeaksRadius;
  if (themeSpeaksRadius && baseline.radius !== "0.625rem") {
    report.baselineRadiusFromTheme = baseline.radius;
  }

  // ---- Each shape moves the geometry, and only the geometry it owns ----
  report.shapes = {};
  for (const id of ["tag", "minimal", "emboss", "glass", "soft"]) {
    const shell = await chooseShape(id);
    report.shapes[id] = shell;
    if (shell.shape !== id) {
      fail(`choosing ${id} left the document at ${JSON.stringify(shell.shape)}`);
    }
    const expected = SHAPES[id];
    if (shell.borderWidth !== expected.border) {
      fail(`${id}: --pane-border-width is ${JSON.stringify(shell.borderWidth)}, not ${expected.border}`);
    }
    // A border is drawn in whole device pixels and never thinner than one, so at this scale a
    // declared 0.5px is used as 1px and a declared 0 as 0. The variable is the truth; the computed
    // value is what the engine made of it, and only those two answers are acceptable.
    const declared = Number.parseFloat(expected.border);
    const allowed = declared === 0 ? ["0px"] : [expected.border, `${Math.max(1, Math.round(declared))}px`];
    if (!allowed.includes(shell.paneBorder)) {
      fail(
        `${id}: a pane draws a ${shell.paneBorder} border for a declared ${expected.border} (allowed: ${allowed.join(" / ")})`,
      );
    }
    if (themeSpeaksRadius) {
      if (shell.radius !== baseline.radius) {
        fail(
          `${id}: the shape overwrote a radius the theme declared (${shell.radius} against ${baseline.radius})`,
        );
      }
    } else if (shell.radius !== expected.radius) {
      fail(`${id}: --radius is ${JSON.stringify(shell.radius)}, not ${expected.radius}`);
    }
    // The window's own corners belong to DWM. A shape that asks for square panes does not get to
    // un-round the window, and nothing here may move that value.
    if (shell.windowRadius !== baseline.windowRadius) {
      fail(
        `${id}: --window-radius moved from ${baseline.windowRadius} to ${shell.windowRadius}; the window's corners are DWM's`,
      );
    }
    if (id === "glass" && shell.material !== "native") {
      fail("glass did not ask for the native material");
    }
    if (id !== "glass" && shell.material !== null) {
      fail(`the material attribute survived into ${id}`);
    }
  }

  // ---- Back to what was there before this run (and the same happens in `finally`) ----
  if (original === undefined) {
    await invoke("plugin:store|delete", { rid, key: PREF_KEY });
    await invoke("plugin:event|emit", {
      event: EVENT,
      payload: { key: PREF_KEY, value: "auto" },
    });
  } else {
    await chooseShape(original);
  }
  await sleep(400);
  const restored = await readShell();
  report.restored = restored;
  if (restored.shape !== baseline.shape || restored.borderWidth !== baseline.borderWidth) {
    fail(
      `the shell was not put back: ${JSON.stringify(restored)} against ${JSON.stringify(baseline)}`,
    );
  }

  report.ok = true;
  const summary = Object.keys(report.shapes)
    .map((id) => `${id} ${report.shapes[id].borderWidth}/${report.shapes[id].radius}`)
    .join("  ");
  console.log(
    `PASS: 形态轴真的作用在外壳上——${summary}；默认仍是 soft 的 1px/${baseline.radius}；--window-radius 全程 ${baseline.windowRadius}；glass 带 data-shape-material=native；跑完已还原。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // Whatever happened above, the user's file goes back to what it said before this ran - including
  // "nothing", which is not the same as the shape named `soft`.
  try {
    if (rid !== null && rid !== undefined) {
      if (original === undefined) {
        await invoke("plugin:store|delete", { rid, key: PREF_KEY });
        await invoke("plugin:event|emit", {
          event: EVENT,
          payload: { key: PREF_KEY, value: "auto" },
        });
      } else {
        await chooseShape(original);
      }
    }
  } catch {
    // The window may already be gone; the file state is reported above either way.
  }
  socket.close();
}
