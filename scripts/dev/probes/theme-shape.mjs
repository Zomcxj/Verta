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
const BOUNDLESS_KEY = "boundless";
const EVENT = "verta://prefs-changed";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/**
 * The presets as the stylesheet receives them, so the numbers below have something to be wrong about.
 *
 * The radius is not here at all: it is an axis of its own (`radius-stops.mjs` measures it), and a
 * shape no longer writes `--radius`. `visible` says what each preset changes, because without it the
 * borderless ones would be indistinguishable.
 */
const SHAPES = {
  minimal: { border: "0px", visible: "nothing at all" },
  cloud: { border: "1px", visible: "panes stepped in from the frame with a soft shadow" },
  emboss: { border: "1px", visible: "two inset edges" },
  slab: { border: "1px", visible: "a contact shadow and a heavier border" },
  acrylic: { border: "1px", visible: "the native acrylic material behind a translucent layer" },
  glass: { border: "1px", visible: "a see-through pane with nothing drawn behind it" },
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
        boundless: root.getAttribute("data-boundless"),
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
        paneBorderColor: paneStyle ? paneStyle.borderTopColor : null,
        paneShadow: paneStyle ? paneStyle.boxShadow : null,
        paneMargin: paneStyle ? paneStyle.marginTop : null,
        // The sidebar's 会话/文件 rail draws a band of its own, which 无界 drops: inside a shape
        // that has no interior edges, a strip with an edge reads as pasted on.
        rail: (() => {
          const node = document.querySelector('[data-slot="sidebar-rail"]');
          if (!node) return null;
          const s = getComputedStyle(node);
          return { background: s.backgroundColor, borderTop: s.borderTopColor };
        })(),
        glassLayer: root.getAttribute("data-theme-glass"),
        paneOpacity: style.getPropertyValue("--theme-pane-opacity").trim(),
        // data-vibrancy is set by the shell when the native material is actually on, so it is the
        // one place that says whether choosing glass reached the window.
        vibrancy: root.getAttribute("data-vibrancy"),
        terminalBackground: style.getPropertyValue("--terminal-background").trim(),
        // 无界 closes the gutters between the three regions - the wrappers' inner padding and the
        // width the resize handles take - so both are measured rather than assumed.
        gutters: [...document.querySelectorAll("[data-shell]")].map((node) => {
          const s = getComputedStyle(node);
          return {
            side: node.getAttribute("data-shell"),
            left: s.paddingLeft,
            right: s.paddingRight,
          };
        }),
        handles: [...document.querySelectorAll('[data-slot="resizable-handle"]')].map((node) => ({
          width: getComputedStyle(node).width,
          hitArea: getComputedStyle(node, "::after").width,
        })),
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

/** The merged sheet, written the way the switch writes it: the store, then the event. */
const setBoundless = async (value) => {
  await invoke("plugin:store|set", { rid, key: BOUNDLESS_KEY, value });
  await invoke("plugin:event|emit", {
    event: EVENT,
    payload: { key: BOUNDLESS_KEY, value },
  });
  await sleep(250);
  return readShell();
};

let original;
let boundlessWas;
try {
  await openStore();
  const stored = await invoke("plugin:store|get", { rid, key: PREF_KEY });
  // The plugin answers a `get` with `[value, exists]`, so "was anything stored" is the second element
  // and `null` alone would not tell an absent key from a key holding null.
  original = Array.isArray(stored) ? (stored[1] ? stored[0] : undefined) : stored;
  // The sheet is the user's, and this probe measures shapes: it starts from the unmerged shell and
  // puts the switch back the way it found it.
  const storedBoundless = await invoke("plugin:store|get", {
    rid,
    key: BOUNDLESS_KEY,
  });
  boundlessWas = Array.isArray(storedBoundless)
    ? storedBoundless[1]
      ? storedBoundless[0]
      : undefined
    : storedBoundless;
  if (boundlessWas === true) await setBoundless(false);
  report.storedBefore = original ?? null;

  // The user's own material switch outranks every shape: with it on, the desktop material is on for
  // all of them, so this probe can only judge the shape's part of that answer when it is off.
  const vibrancySwitch = await invoke("plugin:store|get", { rid, key: "windowVibrancy" });
  const switchValue = Array.isArray(vibrancySwitch)
    ? vibrancySwitch[1]
      ? vibrancySwitch[0]
      : undefined
    : vibrancySwitch;
  report.materialSwitch = switchValue === true;
  const materialFromShape = report.materialSwitch !== true;

  const baseline = await readShell();
  report.baseline = baseline;
  // The sidebar can be collapsed, and then there is no rail to measure: say so rather than pass on
  // an absent element.
  report.railSeen = baseline.rail !== null;
  if (baseline.paneCount === 0) fail("no pane is on screen, so there is nothing to measure");
  // Whatever shape is in force is the user's business - this probe measures the presets, so it starts
  // by putting the default one on and using that as the reference.

  // ---- Each shape moves the geometry, and only the geometry it owns ----
  report.shapes = {};
  let plain = null;
  for (const id of ["minimal", "cloud", "emboss", "slab", "acrylic", "glass"]) {
    const shell = await chooseShape(id);
    report.shapes[id] = shell;
    if (shell.shape !== id) {
      fail(`choosing ${id} left the document at ${JSON.stringify(shell.shape)}`);
    }
    const expected = SHAPES[id];
    // With the sheet off (this probe turns it off before measuring), the sidebar is a card, so its
    // rail keeps the band and the hairline it draws for itself.
    const rail = shell.rail;
    if (rail) {
      const transparent = (colour) =>
        colour === "transparent" || colour === "rgba(0, 0, 0, 0)";
      if (transparent(rail.background)) {
        fail(`${id} drew no band under the sidebar rail: ${JSON.stringify(rail)}`);
      }
    }
    if (id === "minimal") {
      plain = shell;
      // Decoration is opt-in: the default paints no border at all. The inset highlight that is left
      // in `--pane-shadow` is the theme's own chrome, not something the shape adds.
      if (shell.paneBorder !== "0px") fail(`the default still draws a ${shell.paneBorder} border`);
    }
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
    // The window's own corners belong to DWM. A shape that asks for square panes does not get to
    // un-round the window, and nothing here may move that value.
    if (shell.windowRadius !== baseline.windowRadius) {
      fail(
        `${id}: --window-radius moved from ${baseline.windowRadius} to ${shell.windowRadius}; the window's corners are DWM's`,
      );
    }
    const wantMaterial =
      id === "glass" ? "clear" : id === "acrylic" ? "acrylic" : null;
    if (shell.material !== wantMaterial) {
      fail(`${id} asked the window for ${JSON.stringify(shell.material)}, not ${JSON.stringify(wantMaterial)}`);
    }
    // ---- And what each shape changes besides its radius ----
    if (
      id !== "minimal" &&
      shell.paneBorderColor === plain.paneBorderColor
    ) {
      // Half a pixel is drawn as one, so the colour is what tells the thinner presets apart.
      fail(`${id} draws the same border colour as the default (${shell.paneBorderColor})`);
    }
    // Both of emboss's edges are insets, and so is the theme's own dark highlight - so "contains
    // inset" passes on the theme's chrome alone. What has to be true is that the shape *replaced* it.
    if (id === "emboss" && shell.paneShadow === plain.paneShadow) {
      fail(`emboss changed nothing: the pane still carries the theme's own ${shell.paneShadow}`);
    }
    if (id === "slab" && (!shell.paneShadow || shell.paneShadow === "none")) {
      fail(`slab has no contact shadow: ${shell.paneShadow}`);
    }
    if (id === "cloud") {
      // A floating card needs both halves: the step in from the frame, and the shadow it lets fall.
      // Without the step in the shadow was clipped and the shape looked like `minimal`.
      if (!/^\d/.test(shell.paneMargin ?? "")) {
        fail(`cloud does not step its panes in from the frame: margin ${JSON.stringify(shell.paneMargin)}`);
      }
      if (!shell.paneShadow || shell.paneShadow === "none") {
        fail(`cloud casts no shadow: ${shell.paneShadow}`);
      }
      if (shell.paneShadow === plain.paneShadow) {
        fail(`cloud kept the theme's own ${shell.paneShadow} instead of one of its own`);
      }
    }
    if (id === "glass") {
      if (shell.glassLayer !== "on") fail("glass did not turn the translucent layer on");
      if (shell.paneOpacity !== "0.28") {
        fail(`glass carries pane opacity ${JSON.stringify(shell.paneOpacity)}, not acrylic's 0.28`);
      }
      // The material has to reach the window, not just the document.
      if (shell.vibrancy !== "on") {
        fail("the native material was never switched on (no data-vibrancy)");
      }
      // And the terminal stops painting the theme's colour: a solid rectangle in a translucent
      // window is the one place acrylic looked broken.
      if (shell.terminalBackground !== "transparent") {
        fail(
          `the terminal still paints ${JSON.stringify(shell.terminalBackground)} under the material`,
        );
      }
    } else {
      if (shell.glassLayer !== null) fail(`the glass layer survived into ${id}`);
      // Only the shape's own request can be judged: with the user's master switch on, the material
      // stays on for every shape, and that is the documented rule.
      if (materialFromShape && shell.vibrancy !== null) {
        fail(`the native material survived into ${id} with the switch off`);
      }
      // The theme's terminal colour comes back when the material goes away.
      if (shell.terminalBackground === "transparent") {
        fail(`the terminal stayed see-through in ${id}`);
      }
    }
  }

  // ---- The merged sheet is a switch of its own, not a preset ----
  //
  // Its whole point is that it combines: with it on, the shape in force keeps drawing (border,
  // shadow, material) and only the seams between the three regions go away.
  const shapeBefore = (await readShell()).shape;
  const merged = await setBoundless(true);
  report.merged = merged;
  if (merged.boundless !== "on") {
    fail(`the switch did not merge the shell: ${JSON.stringify(merged.boundless)}`);
  }
  if (merged.shape !== shapeBefore) {
    fail(`merging the shell changed the shape from ${shapeBefore} to ${merged.shape}`);
  }
  const inner = (side) => merged.gutters.find((g) => g.side === side);
  const sideways = [
    ["sidebar", inner("sidebar")?.right],
    ["workspace", inner("workspace")?.left],
    ["workspace", inner("workspace")?.right],
    ["right", inner("right")?.left],
  ].filter(([, value]) => value !== "0px");
  if (merged.gutters.length !== 3) {
    fail(`the shell named ${merged.gutters.length} regions, not the three`);
  }
  if (sideways.length > 0) {
    fail(
      `the sheet left a gutter: ${sideways.map(([side, value]) => `${side} ${value}`).join(", ")}`,
    );
  }
  if (merged.handles.length === 0) fail("no resize handle was found to measure");
  for (const handle of merged.handles) {
    if (handle.width !== "0px") fail(`the sheet left a ${handle.width} handle between the panes`);
    if (!/^\d+(\.\d+)?px$/.test(handle.hitArea) || Number.parseFloat(handle.hitArea) < 3) {
      fail(`a zero-width handle lost its hit area (${handle.hitArea}) - it would not be draggable`);
    }
  }
  // Inside one sheet a strip with an edge reads as pasted on, so the rail drops its band.
  const mergedRail = merged.rail;
  if (mergedRail) {
    const transparent = (colour) =>
      colour === "transparent" || colour === "rgba(0, 0, 0, 0)";
    if (!transparent(mergedRail.background) || !transparent(mergedRail.borderTop)) {
      fail(`the sheet left the sidebar rail's band on: ${JSON.stringify(mergedRail)}`);
    }
  }

  const unmerged = await setBoundless(false);
  if (unmerged.boundless !== null) {
    fail(`switching the sheet off left ${JSON.stringify(unmerged.boundless)} on the document`);
  }
  if (unmerged.gutters.find((g) => g.side === "sidebar")?.right === "0px") {
    fail("switching the sheet off did not reopen the gutters");
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
    .map((id) => `${id} ${report.shapes[id].borderWidth}`)
    .join("  ");
  console.log(
    `PASS: 形态轴真的作用在外壳上（描边宽度）——${summary}；默认（极简）不画边框；「无界」现在是独立开关：打开后三块合成一块（三处内缝 0、两个手柄 0px 但保留 ${report.merged?.handles[0]?.hitArea} 命中区）、左侧「会话/文件」那条的底色与上边线一并去掉，且形态本身不变（仍是 ${report.merged?.shape}），关掉后内缝回来；--window-radius 全程 ${baseline.windowRadius}；玻璃要 clear、亚克力要 acrylic，两者的终端都透明；跑完已还原。`,
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
  // "nothing", which is not the same as having chosen a shape.
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
      if (boundlessWas === true) await setBoundless(true);
    }
  } catch {
    // The window may already be gone; the file state is reported above either way.
  }
  socket.close();
}
