// What does 碳纤维 look like? One pass over the window, a corner and a seam, plus both child windows.
//
// The weave is a pattern, so "does it work" is a question about density and contrast: too fine and the
// frame looks like noise, too strong and text on a child window sits in a pattern. This switches
// `shapeId` the way the picker does, screenshots the frame and a seam at 6x, opens the settings and
// usage windows and screenshots their bodies, and writes the user's own shape back at the end.
//
// It changes nothing else: the store write and the event are the same two the picker sends, and the
// original value is restored in a `finally`, including "there was none".
//
// Usage:
//   pnpm tauri dev            (or a release build with --remote-debugging-port=9222)
//   node scripts/dev/probes/shape-carbon-look.mjs [--port=9222] [--out=<dir>] [--scale=6]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const scale = Number(process.argv.find((a) => a.startsWith("--scale="))?.slice(8) ?? "6");
const outDir =
  process.argv.find((a) => a.startsWith("--out="))?.slice(6) ??
  `${process.env.TEMP ?? "."}\\verta-carbon-look`;

const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", (e) =>
      reject(new Error(String(e?.message ?? e))),
      { once: true },
    );
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
      const what =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text;
      throw new Error(`${what} in: ${expression.slice(0, 160)}`);
    }
    return result.result.value;
  };
  const invoke = (command, args) =>
    evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => (value === undefined ? null : value)).catch((e) => "ERR " + String(e))`,
    );
  const shoot = async (name, clip, scaleOverride = scale) => {
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: scaleOverride } } : {}),
    });
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.data, "base64"));
    return path;
  };
  return { send, evaluate, invoke, shoot, close: () => socket.close() };
}

const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();
const findPage = (list, match) => list.find((t) => t.type === "page" && match(t.url));

const mainTarget = findPage(
  await targets(),
  (url) => url.endsWith("1420/") || url === "http://tauri.localhost/",
);
if (!mainTarget) {
  console.error("no app page on the debug port: is it running with --remote-debugging-port?");
  process.exit(1);
}
const app = await connect(mainTarget.webSocketDebuggerUrl);

const STORE = "verta-settings.json";
const PREF_KEY = "shapeId";
const EVENT = "verta://prefs-changed";

let rid = null;
const openStore = async () => {
  const loaded = await app.invoke("plugin:store|load", { path: STORE });
  if (typeof loaded === "string" && loaded.startsWith("ERR")) {
    throw new Error(`the settings store would not open: ${loaded}`);
  }
  rid = loaded;
};

const writeShape = async (value) => {
  const written = await app.invoke("plugin:store|set", { rid, key: PREF_KEY, value });
  if (typeof written === "string" && written.startsWith("ERR")) {
    throw new Error(`the settings store refused ${value}: ${written}`);
  }
  await app.invoke("plugin:event|emit", {
    event: EVENT,
    payload: { key: PREF_KEY, value },
  });
  await sleep(400);
};

/** What the surface layers are actually painted with, and where the panes are. */
const readState = async () =>
  JSON.parse(
    await app.evaluate(`(() => {
      const wrap = document.querySelector("[data-shell]");
      const panes = [...document.querySelectorAll(".verta-pane")];
      const layers = [...document.querySelectorAll("[data-theme-surface-layer], [data-theme-surface-fill]")];
      return JSON.stringify({
        shapeAttr: document.documentElement.getAttribute("data-shape"),
        surfaceAttr: document.documentElement.getAttribute("data-shape-surface"),
        surfacThemeAttr: document.documentElement.getAttribute("data-theme-surface"),
        layers: layers.map((l) => {
          const style = getComputedStyle(l);
          return {
            which: l.hasAttribute("data-theme-surface-layer") ? "layer" : "fill",
            display: style.display,
            image: style.backgroundImage.slice(0, 90),
            size: style.backgroundSize,
            repeat: style.backgroundRepeat,
            color: style.backgroundColor,
          };
        }),
        panes: panes.map((p) => {
          const box = p.getBoundingClientRect();
          const style = getComputedStyle(p);
          return { x: box.x, y: box.y, w: box.width, h: box.height, background: style.backgroundColor };
        }),
        wrap: wrap && wrap.getAttribute("data-shell"),
      });
    })()`),
  );

const files = [];
let original;
try {
  await openStore();
  const stored = await app.invoke("plugin:store|get", { rid, key: PREF_KEY });
  original = Array.isArray(stored) ? (stored[1] ? stored[0] : undefined) : stored;

  await writeShape("carbon");
  const state = await readState();
  console.log(JSON.stringify({ original: original ?? null, state }, null, 1));
  if (state.surfaceAttr !== "weave") {
    throw new Error(`the shape did not reach the document: data-shape-surface=${state.surfaceAttr}`);
  }
  // One layer, and it is the one under the UI: the other is `z-index: 0` and portalled after `#root`,
  // so a fabric on it paints over the panes and the terminal.
  const drawn = state.layers.filter((l) => l.display !== "none" && l.image.includes("gradient"));
  if (drawn.length !== 1 || drawn[0].which !== "layer") {
    throw new Error(`the weave is painted on ${drawn.map((l) => l.which).join(", ") || "nothing"}`);
  }

  // The whole window first: density is judged at 100%, and the frames either side of the panes are
  // where the fabric is meant to show.
  files.push(await app.shoot("carbon-window-1x", null, 1));

  const first = state.panes[0];
  const second = state.panes[1];
  if (first) {
    files.push(
      await app.shoot("carbon-corner", {
        x: Math.max(0, first.x - 4),
        y: Math.max(0, first.y - 4),
        width: 26,
        height: 26,
      }),
    );
  }
  // The window's own left margin, 8px wide: where the fabric is meant to be seen, and where the
  // frame's own tint sits over it.
  files.push(await app.shoot("carbon-margin", { x: 0, y: 300, width: 14, height: 40 }, 8));
  if (first && second) {
    // The seam between two panes: the fabric's widest stretch inside the window.
    files.push(
      await app.shoot("carbon-seam", {
        x: first.x + first.w - 6,
        y: first.y + Math.min(60, first.h / 3),
        width: 12,
        height: 34,
      }),
    );
  }

  // Then the two child windows, which are their own documents: their body carries the weave.
  for (const [label, command, root] of [
    ["settings", "open_settings_window", "#settings-root"],
    ["usage", "open_usage_window", "#usage-root"],
  ]) {
    await app.invoke(command, {});
    const deadline = Date.now() + 20_000;
    let target = null;
    while (Date.now() < deadline && !target) {
      target = findPage(await targets(), (url) => url.includes(`${label}.html`));
      if (!target) await sleep(200);
    }
    if (!target) throw new Error(`the ${label} window never appeared`);
    const child = await connect(target.webSocketDebuggerUrl);
    // The page may still be booting: the body's background is what matters, not the first frame.
    // The child window applies the stored shape in an effect after hydration, so the first read can
    // be before it: poll until the document says it, not until the window exists.
    let body = "{}";
    const paintDeadline = Date.now() + 30_000;
    while (Date.now() < paintDeadline) {
      body = await child.evaluate(`(() => {
        const layer = document.querySelector("[data-theme-surface-layer]");
        const style = layer ? getComputedStyle(layer) : null;
        const root = document.querySelector(${JSON.stringify(root)});
        return JSON.stringify({
          surfaceAttr: document.documentElement.getAttribute("data-shape-surface"),
          layerMounted: !!layer,
          image: style ? style.backgroundImage.slice(0, 90) : null,
          size: style ? style.backgroundSize : null,
          color: style ? style.backgroundColor : null,
          rootBackground: root ? getComputedStyle(root).backgroundColor : null,
        });
      })()`);
      if (body.includes("gradient")) break;
      await sleep(250);
    }
    console.log(`${label}: ${body}`);
    await sleep(600);
    files.push(await child.shoot(`carbon-${label}-1x`, null, 1));
    child.close();
  }
  console.log(`\nwrote:\n  ${files.join("\n  ")}`);
} finally {
  // Always put the user's shape back: this is their machine's preference, not the probe's.
  if (rid !== null) {
    // `auto` rather than a preset when there was no value: "let the theme decide" is a state of its
    // own, and writing a preset would silently overrule a theme that suggests one.
    await writeShape(original ?? "auto");
    console.log(`restored shapeId: ${original ?? "auto"}`);
  }
  app.close();
}
