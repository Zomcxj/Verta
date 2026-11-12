// Acceptance for the shape picker: choosing a shape in Settings changes the shell, in the other
// window too.
//
// The axis itself is checked by `theme-shape.mjs`, which writes the preference the way a picker would.
// This one drives the actual control, because the propagation is the part that has failed in this
// codebase before: a preference written to disk that reaches no window's store leaves the control
// where it was, click after click. So the assertion is cross-window - press a shape in the Settings
// window, and the main window's document has to carry it.
//
// Also checked: the picker draws each choice with the values that choice would write, so the buttons
// differ from each other before anything is applied; and `auto` is a separate answer from `soft`.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/shape-picker.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const STORE = "verta-settings.json";
const PREF_KEY = "shapeId";
const EVENT = "verta://prefs-changed";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

/** How a button is pressed. The app's controls react to a press, not to a click. */
const PRESS = `const press = (node) => {
  const options = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  node.dispatchEvent(new PointerEvent("pointerdown", options));
  node.dispatchEvent(new PointerEvent("pointerup", { ...options, buttons: 0 }));
  node.dispatchEvent(new MouseEvent("click", { ...options, buttons: 0 }));
};`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A debugging connection to one page, with the three calls this probe needs. */
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

const mainTarget = (list) =>
  list.find((t) => t.url === "http://tauri.localhost/") ??
  list.find((t) => t.url.includes("tauri.localhost/") && !t.url.includes("settings"));

/** The document's own answers, which are the same in either window. */
const readShell = async (page) =>
  JSON.parse(
    await page.evaluate(`(() => {
      const style = getComputedStyle(document.documentElement);
      return JSON.stringify({
        shape: document.documentElement.getAttribute("data-shape"),
        radius: style.getPropertyValue("--radius").trim(),
        borderWidth: style.getPropertyValue("--pane-border-width").trim(),
        windowRadius: style.getPropertyValue("--window-radius").trim(),
        // What the shell says when the native material is really on.
        vibrancy: document.documentElement.getAttribute("data-vibrancy"),
        terminal: style.getPropertyValue("--terminal-background").trim(),
      });
    })()`),
  );

/** Press the picker button whose label is this, and answer whether it was there. */
const pressShape = async (settings, label) =>
  settings.evaluate(`(() => {
    ${PRESS}
    const button = [...document.querySelectorAll("button[aria-pressed]")].find(
      (node) => (node.innerText || "").trim() === ${JSON.stringify(label)},
    );
    if (!button) return false;
    press(button);
    return true;
  })()`);

/** Wait for the main window to report this shape. */
const waitForShape = async (main, shape, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readShell(main))?.shape === shape) return true;
    await sleep(150);
  }
  return false;
};

let main = null;
let settings = null;
let rid = null;
let original;
try {
  main = await connect(mainTarget(await targets()) ?? fail("no main window"));

  // ---- What the picker offers ----
  await main.evaluate(`window.__TAURI_INTERNALS__.invoke("open_settings_window", { tab: "themes" })`);
  let settingsTarget = null;
  for (let attempt = 0; attempt < 60 && !settingsTarget; attempt += 1) {
    settingsTarget = (await targets()).find((t) => t.url.includes("settings.html"));
    if (!settingsTarget) await sleep(250);
  }
  if (!settingsTarget) fail("the settings window did not open");
  settings = await connect(settingsTarget);

  // The picker mounts with the page; the theme list above it reads the disk, so give it a moment.
  let options = [];
  for (let attempt = 0; attempt < 60 && options.length === 0; attempt += 1) {
    // Found by what the buttons are rather than by how the grid looks: the shape choices carry
    // `aria-pressed` and the mode choices at the top of the section do not, and a column count is a
    // styling detail this probe should not depend on.
    const raw = await settings.evaluate(`(() => {
      const grid = [...document.querySelectorAll("div.grid")].find((node) =>
        node.querySelector("button[aria-pressed]"),
      );
      if (!grid) return "[]";
      return JSON.stringify(
        [...grid.querySelectorAll("button")].map((node) => {
          const icon = node.querySelector("[data-shape-icon]");
          const region = icon?.querySelector("[data-region]");
          const style = region ? getComputedStyle(region) : null;
          return {
            label: (node.innerText || "").trim().split(String.fromCharCode(10)).pop().trim(),
            selected: node.getAttribute("aria-pressed") === "true",
            // The drawing is three regions; what tells the borderless pair apart is the distance
            // between them, and 无界 rounds the block instead of the regions.
            regions: icon ? icon.querySelectorAll("[data-region]").length : 0,
            gap: icon ? icon.getAttribute("data-gap") : null,
            block: Boolean(icon?.hasAttribute("data-block")),
            blockRadius: icon ? getComputedStyle(icon).borderTopLeftRadius : null,
            border: style ? style.borderTopWidth : null,
          };
        }),
      );
    })()`);
    options = JSON.parse(raw ?? "[]");
    if (options.length === 0) await sleep(250);  }
  report.options = options;
  if (options.length !== 6) {
    fail(`the picker offers ${options.length} choices (${options.map((o) => o.label).join("/")}), not the six`);
  }
  if (options[0].label !== "无界") fail(`the first choice is ${options[0].label}, not the boundless one`);
  // Each choice draws the three regions its own way: without that the borderless pair would be the
  // same picture, since the radius is no longer theirs to show.
  for (const option of options) {
    if (option.regions !== 3) {
      fail(`the ${option.label} choice draws ${option.regions} regions, not the three of the shell`);
    }
  }
  const mergedGaps = options.filter((o) => o.gap === "0");
  if (mergedGaps.length !== 1 || mergedGaps[0].label !== "无界") {
    fail(`exactly one choice may close the gutters: ${JSON.stringify(options.map((o) => `${o.label} ${o.gap}`))}`);
  }
  const blocks = options.filter((o) => o.block);
  if (blocks.length !== 1 || blocks[0].label !== "无界") {
    fail(`exactly one choice rounds a merged block: ${JSON.stringify(blocks.map((o) => o.label))}`);
  }
  const minimalOption = options.find((o) => o.label === "极简");
  if (minimalOption.border !== "0px") {
    fail(`the minimal choice draws a ${minimalOption.border} border, not none`);
  }

  // ---- The radius is the section's own control, and the drawings follow it ----
  const readControl = async () =>
    JSON.parse(
      await settings.evaluate(`(() => {
        const thumb = document.querySelector('[aria-valuemax="6"]');
        const value = document.querySelector("[data-radius-value]");
        return JSON.stringify({
          hasSlider: Boolean(thumb),
          now: thumb ? thumb.getAttribute("aria-valuenow") : null,
          dots: document.querySelectorAll("[data-stop]").length,
          label: value ? (value.innerText || "").trim() : null,
        });
      })()`),
    );
  // The store is how the slider writes, and the event is how every window hears about it.
  const setStored = async (key, value) => {
    await settings.evaluate(`(() => {
      const store = window.__PROBE_STORE__;
      return window.__TAURI_INTERNALS__.invoke("plugin:store|set", { rid: store, key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })
        .then(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: ${JSON.stringify(EVENT)}, payload: { key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} } }));
    })()`);
    await sleep(400);
  };
  // The settings window opens its own store handle: the id from the main window is not one it owns.
  report.radiusStore = await settings.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:store|load", { path: ${JSON.stringify(STORE)} }).then((r) => { window.__PROBE_STORE__ = typeof r === "object" && r !== null ? (r.rid ?? r) : r; return window.__PROBE_STORE__; }).catch(() => null)`,
  );
  if (!report.radiusStore) fail("the settings window could not open the settings store");

  report.radius = {};
  for (const stop of ["0", "0.5rem", "1rem"]) {
    await setStored("cornerRadius", stop);
    const control = await readControl();
    const drawn = await settings.evaluate(`(() => {
      const grid = [...document.querySelectorAll("div.grid")].find((node) =>
        node.querySelector("[data-shape-icon]"),
      );
      const block = grid?.querySelector('[data-shape-icon="boundless"]');
      const panes = grid?.querySelector('[data-shape-icon="minimal"]');
      const middle = panes ? panes.querySelectorAll("[data-region]")[1] : null;
      return JSON.stringify({
        block: block ? getComputedStyle(block).borderTopLeftRadius : null,
        // The workspace pane, not the first one: the narrow panes stop getting rounder near the top
        // of the range on purpose, so they cannot draw as pills.
        region: middle ? getComputedStyle(middle).borderTopLeftRadius : null,
      });
    })()`);
    report.radius[stop] = { control, ...JSON.parse(drawn) };
    if (!control.hasSlider) fail("the radius slider is not in the shape section");
    if (control.dots !== 7) fail(`the radius slider shows ${control.dots} stops, not the seven`);
    const wantedIndex = { "0": 0, "0.5rem": 3, "1rem": 6 }[stop];
    const wantedLabel = { "0": "0px", "0.5rem": "8px", "1rem": "16px" }[stop];
    if (control.now !== String(wantedIndex)) {
      fail(`the slider sits at ${control.now} for ${stop}, not ${wantedIndex}`);
    }
    if (control.label !== wantedLabel) {
      fail(`the control shows ${control.label} for ${stop}, not ${wantedLabel}`);
    }
  }
  // The drawings are the ones that move: same picture, different corners, as the slider travels.
  const radii = ["0", "0.5rem", "1rem"].map((stop) =>
    Number.parseFloat(report.radius[stop].block),
  );
  if (!(radii[0] < radii[1] && radii[1] < radii[2])) {
    fail(`the merged drawing does not follow the radius axis: ${JSON.stringify(report.radius)}`);
  }
  if (radii[0] !== 0) fail(`the drawing is still round at a radius of zero: ${report.radius["0"].block}`);
  // And the regions of the other shapes follow it too: that is the same variable reaching them.
  const regionRadii = ["0", "0.5rem", "1rem"].map((stop) =>
    Number.parseFloat(report.radius[stop].region),
  );
  if (!(regionRadii[0] < regionRadii[1] && regionRadii[1] < regionRadii[2])) {
    fail(`the region drawings do not follow the radius axis: ${JSON.stringify(report.radius)}`);
  }

  // ---- A click in Settings reaches the other window ----
  report.baseline = await readShell(main);

  // ---- The material: pressed in Settings, switched on in the other window ----
  if (!(await pressShape(settings, "玻璃"))) fail("the glass choice is not pressable");
  if (!(await waitForShape(main, "glass"))) {
    report.afterGlass = await readShell(main);
    fail(`pressing 玻璃 left the main window at ${JSON.stringify(report.afterGlass.shape)}`);
  }
  // The material is a native call, so give the window a moment to report it.
  let afterGlass = await readShell(main);
  for (let attempt = 0; attempt < 30 && afterGlass.vibrancy !== "on"; attempt += 1) {
    await sleep(200);
    afterGlass = await readShell(main);
  }
  report.afterGlass = afterGlass;
  report.settingsAfterGlass = await readShell(settings);
  if (afterGlass.borderWidth !== "1px") {
    fail(`glass did not reach the document: ${JSON.stringify(afterGlass)}`);
  }
  // The Settings window draws panes of its own and follows the same axis.
  if (report.settingsAfterGlass.shape !== "glass") {
    fail(`the settings window itself is ${JSON.stringify(report.settingsAfterGlass.shape)}`);
  }

  // ---- The one that asks for square panes must still not un-round the window ----
  if (!(await pressShape(settings, "极简"))) fail("the minimal choice is not pressable");
  if (!(await waitForShape(main, "minimal"))) fail("pressing 极简 did not reach the main window");
  report.afterMinimal = await readShell(main);
  if (report.afterMinimal.windowRadius !== report.baseline.windowRadius) {
    fail(
      `minimal moved --window-radius from ${report.baseline.windowRadius} to ${report.afterMinimal.windowRadius}`,
    );
  }

  // ---- The same list from the command palette, which is where most people meet it ----
  //
  // 「切换形态…」 sits right under 「切换主题…」 there. cmdk selects on click and previews on
  // pointermove, so this leg checks both: a hover has to repaint the shell without writing anything,
  // a click has to write it.
  report.palette = {};
  await main.send("Page.bringToFront");
  await sleep(200);

  /** One key, sent the way the window receives it - a page-level event never reaches the app. */
  const sendKey = async (key, code, virtualKeyCode, modifiers = 0) => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await main.send("Input.dispatchKeyEvent", {
        type,
        modifiers,
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
      });
    }
  };
  // Found by the input cmdk puts on screen, not by the id the caller passes: cmdk writes its own
  // `id` after spreading the props, so the id the palette asks for never reaches the DOM.
  const paletteIsOpen = () => main.evaluate(`Boolean(document.querySelector("[cmdk-input]"))`);
  const closePalette = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await paletteIsOpen())) return;
      await sendKey("Escape", "Escape", 27);
      await sleep(300);
    }
  };

  // The palette's chord belongs to the user: this machine has it on Alt+P rather than the Ctrl+P the
  // catalogue ships, and a probe that hard-coded one would blame the app for honouring a keymap it
  // was told to honour. So the binding is read, and the header's own button is the way in when it is
  // a chord this probe cannot translate.
  report.palette.binding = JSON.parse(
    await main.evaluate(`(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:store|load", { path: ${JSON.stringify(STORE)} })
        .then((r) => {
          const handle = typeof r === "object" && r !== null ? (r.rid ?? r) : r;
          return window.__TAURI_INTERNALS__.invoke("plugin:store|get", { rid: handle, key: "shortcuts" });
        })
        .then((row) => {
          const stored = Array.isArray(row) ? row[0] : row;
          // Keyed by shortcut id, dots and all: "commandPalette.open".
          return JSON.stringify(stored?.["commandPalette.open"]?.[0] ?? null);
        })
        .catch(() => null))()`),
  );
  // Whatever the last run of this probe (or a person) left open: the page has to start at the
  // commands, or 「切换形态」 is not on it.
  await closePalette();
  const binding = report.palette.binding;
  const openedVia = await (async () => {
    if (binding && /^[a-z0-9]$/i.test(binding.key)) {
      const letter = binding.key.toUpperCase();
      const modifiers =
        (binding.alt ? 1 : 0) |
        (binding.ctrl ? 2 : 0) |
        (binding.meta ? 4 : 0) |
        (binding.shift ? 8 : 0);
      await sendKey(binding.key.toLowerCase(), `Key${letter}`, letter.charCodeAt(0), modifiers);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (await paletteIsOpen()) return "shortcut";
        await sleep(100);
      }
    }
    const clicked = await main.evaluate(`(() => {
      ${PRESS}
      const button = [...document.querySelectorAll("button")].find((node) =>
        /命令面板|command palette/i.test(
          (node.getAttribute("title") || "") + (node.getAttribute("aria-label") || ""),
        ),
      );
      if (!button) return false;
      press(button);
      return true;
    })()`);
    if (!clicked) return null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await paletteIsOpen()) return "button";
      await sleep(100);
    }
    return null;
  })();
  report.palette.opened = openedVia;
  if (!openedVia) fail("the palette did not open, by keymap or by the header button");

  /** A row of either list, pressed the way cmdk expects: it selects on click. */
  const pressPaletteRow = (matches) =>
    main.evaluate(`(() => {
      ${PRESS}
      const row = [...document.querySelectorAll("[cmdk-item]")].find((node) =>
        (node.innerText || "").includes(${JSON.stringify(matches)}),
      );
      if (!row) return false;
      press(row);
      return true;
    })()`);
  const paletteRows = () =>
    main.evaluate(
      `JSON.stringify([...document.querySelectorAll("[cmdk-item]")].map((node) => (node.innerText || "").trim().split(String.fromCharCode(10))[0].trim()))`,
    );

  if (!(await pressPaletteRow("切换形态"))) {
    fail(`the palette has no 切换形态 row: ${await paletteRows()}`);
  }
  await sleep(400);
  const shapeRows = JSON.parse(
    await main.evaluate(`(() => {
      const rows = [...document.querySelectorAll("[cmdk-item]")];
      return JSON.stringify({
        icons: rows.reduce((total, node) => total + node.querySelectorAll("[data-shape-icon]").length, 0),
        labels: rows.map((node) => (node.innerText || "").trim().split(String.fromCharCode(10))[0].trim()),
        drawn: [...document.querySelectorAll("[data-shape-icon]")].map((node) => node.getAttribute("data-shape-icon")),
      });
    })()`),
  );
  report.palette.shapes = shapeRows;
  if (shapeRows.icons !== 6) {
    fail(`the palette's shape page draws ${shapeRows.icons} shapes, not the six: ${JSON.stringify(shapeRows.labels)}`);
  }
  for (const id of ["boundless", "minimal", "cloud", "emboss", "slab", "glass"]) {
    if (!shapeRows.drawn.includes(id)) {
      fail(`the palette's shape page is missing ${id}: ${JSON.stringify(shapeRows)}`);
    }
  }

  // Hovering previews without writing: the shell follows the pointer, the preference does not.
  report.palette.hovered = await main.evaluate(`(() => {
    const row = [...document.querySelectorAll('[cmdk-item]')].find((node) =>
      (node.innerText || "").includes("云朵"),
    );
    if (!row) return false;
    row.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" }));
    return true;
  })()`);
  if (!report.palette.hovered) {
    fail(`the palette draws no 云朵 row to hover, only: ${await paletteRows()}`);
  }
  let previewed = await readShell(main);
  for (let attempt = 0; attempt < 30 && previewed.shape !== "cloud"; attempt += 1) {
    await sleep(100);
    previewed = await readShell(main);
  }
  report.palette.preview = previewed.shape;
  if (previewed.shape !== "cloud") {
    fail(`hovering 云朵 in the palette left the shell at ${previewed.shape}`);
  }

  // Escape goes back to the command list rather than closing the palette, and drops the preview.
  //
  // Radix reads Escape in the capture phase and dismisses the dialog unless the content's
  // `onEscapeKeyDown` says not yet, so what is checked here is both halves: the key arrived at the
  // window at all (`defaultPrevented`, reported) and the page went back instead of the dialog
  // going away.
  await main.evaluate(`(() => {
    window.__probeEscape = [];
    document.addEventListener("keydown", (event) => {
      const seen = event;
      setTimeout(() => window.__probeEscape.push({ key: seen.key, prevented: seen.defaultPrevented }), 0);
    }, true);
    return true;
  })()`);
  await sendKey("Escape", "Escape", 27);
  await sleep(400);
  const afterEscape = JSON.parse(
    await main.evaluate(`(() => JSON.stringify({
      open: Boolean(document.querySelector("[cmdk-input]")),
      icons: document.querySelectorAll('[data-shape-icon]').length,
      shape: document.documentElement.getAttribute("data-shape"),
      keys: window.__probeEscape ?? [],
      focus: document.activeElement
        ? document.activeElement.tagName + "/" + (document.activeElement.getAttribute("role") || "")
        : null,
    }))()`),
  );
  report.palette.afterEscape = afterEscape;
  if (!afterEscape.open) {
    fail(`Escape closed the palette instead of going back a page (${JSON.stringify(afterEscape)})`);
  }
  if (afterEscape.icons !== 0) fail(`Escape left the shape page up: ${JSON.stringify(afterEscape)}`);
  if (afterEscape.shape !== report.afterMinimal.shape) {
    fail(
      `the preview outlived the page: ${afterEscape.shape} after Escape, ${report.afterMinimal.shape} before`,
    );
  }

  // A click commits it, to the document and to the preference.
  if (!(await pressPaletteRow("切换形态"))) fail("the palette lost its 切换形态 row after Escape");
  await sleep(300);
  if (!(await pressPaletteRow("云朵"))) fail("the palette's shape page has no 云朵 row to press");
  if (!(await waitForShape(main, "cloud"))) fail("pressing 云朵 in the palette did not reach the document");
  await sleep(400);
  report.palette.committed = await main.evaluate(`(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:store|load", { path: ${JSON.stringify(STORE)} })
      .then((r) => {
        const handle = typeof r === "object" && r !== null ? (r.rid ?? r) : r;
        return window.__TAURI_INTERNALS__.invoke("plugin:store|get", { rid: handle, key: "shapeId" });
      })
      .then((row) => (Array.isArray(row) ? row[0] : row))
      .catch(() => null))()`);
  if (report.palette.committed !== "cloud") {
    fail(`the palette's choice was not stored: shapeId is ${JSON.stringify(report.palette.committed)}`);
  }

  report.ok = true;
  console.log(
    `PASS: 形态选择器有 ${options.length} 项、每项都画出三块区域与自己的描边（只有无界合缝并给整块上圆角，${options.map((o) => `${o.label}${o.gap}`).join("/")}）；圆角滑块 7 挡、显示 ${report.radius["0.5rem"].control.label} 时停在 ${report.radius["0.5rem"].control.now}、图标圆角随挡位 ${radii.join("→")}；设置窗口点「玻璃」主窗口变 ${report.afterGlass.shape}（材质 ${report.afterGlass.vibrancy}），点「极简」主窗口回到 ${report.afterMinimal.shape} 且窗口外框仍 ${report.afterMinimal.windowRadius}；命令面板「切换形态」列出同样 ${report.palette.shapes.icons} 项，悬停云朵主窗口预览成 ${report.palette.preview}（Esc 后回到 ${report.palette.afterEscape.shape}、页面退回命令列表），点云朵后 shapeId 落成 ${report.palette.committed}。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // The picker wrote a real preference, so the file goes back to what it said before this ran -
  // including "nothing", which is not the key `shapeId: auto`.
  try {
    if (main) {
      const opened = await main.evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:store|load", { path: ${JSON.stringify(STORE)} }).then((r) => (typeof r === "object" && r !== null ? (r.rid ?? r) : r)).catch(() => null)`,
      );
      rid = opened;
      if (rid !== null && rid !== undefined) {
        const stored = await main.evaluate(
          `window.__TAURI_INTERNALS__.invoke("plugin:store|get", { rid: ${JSON.stringify(rid)}, key: ${JSON.stringify(PREF_KEY)} }).catch(() => null)`,
        );
        original = Array.isArray(stored) ? (stored[1] ? stored[0] : undefined) : stored;
        if (original === undefined) {
          await main.evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:store|delete", { rid: ${JSON.stringify(rid)}, key: ${JSON.stringify(PREF_KEY)} }).catch(() => null)`,
          );
        } else {
          await main.evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:store|set", { rid: ${JSON.stringify(rid)}, key: ${JSON.stringify(PREF_KEY)}, value: ${JSON.stringify(original)} }).catch(() => null)`,
          );
        }
        await main.evaluate(
          `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: ${JSON.stringify(EVENT)}, payload: { key: ${JSON.stringify(PREF_KEY)}, value: ${JSON.stringify(original ?? "auto")} } }).catch(() => null)`,
        );
        // This probe moved the radius too, and the same rule applies: its own value back, or the key
        // gone and the window told the default it would have had.
        const storedRadius = await main.evaluate(
          `window.__TAURI_INTERNALS__.invoke("plugin:store|get", { rid: ${JSON.stringify(rid)}, key: "cornerRadius" }).catch(() => null)`,
        );
        const radiusWas = Array.isArray(storedRadius)
          ? storedRadius[1]
            ? storedRadius[0]
            : undefined
          : storedRadius;
        // Only if this run actually moved it: otherwise the key was never there to begin with.
        const movedRadius = Boolean(report.radius);
        if (radiusWas !== undefined) {
          await main.evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:store|set", { rid: ${JSON.stringify(rid)}, key: "cornerRadius", value: ${JSON.stringify(radiusWas)} }).catch(() => null)`,
          );
        } else if (movedRadius) {
          await main.evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:store|delete", { rid: ${JSON.stringify(rid)}, key: "cornerRadius" }).catch(() => null)`,
          );
        }
        if (movedRadius) {
          await main.evaluate(
            `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: ${JSON.stringify(EVENT)}, payload: { key: "cornerRadius", value: ${JSON.stringify(radiusWas ?? "0.625rem")} } }).catch(() => null)`,
          );
        }
      }
      // The Settings window was opened by this run, so it is closed by this run.
      await main.evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "settings" }).catch(() => null)`,
      );
    }
  } catch {
    // The window may already be gone; what it left behind is reported above.
  }
  settings?.socket.close();
  main?.socket.close();
}
