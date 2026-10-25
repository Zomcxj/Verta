// Acceptance for the inline-image preview veil.
//
// The veil is the sheet that dims a terminal session behind a picture the user opened from it. It
// used to be a fixed 75% black, which is a black rectangle over any light theme. It is now the
// pane's own background at high alpha, so it follows the theme.
//
// There is no way to raise this veil from the outside: it needs a message in an agent session that
// attached an image (the bytes live in the opencode database), a terminal printing that name with a
// mosaic band above it, and the read back through IPC. So the veil is raised the way the component
// itself raises it: React's own dispatcher for the preview hook, found by walking the fiber tree to
// the overlay. Everything drawn afterwards is the component's real markup (real class, real image,
// real stacking), which is what is measured and photographed: the veil's computed colour, that it
// covers the pane, that it sits above the session, and that a simulated light theme gives a light
// veil rather than a black one.
//
// Nothing is written: the preview is dismissed and any temporary variable override removed before
// the script returns. The active tab is not changed.
//
// Usage: node scripts/dev/probes/image-preview-veil.mjs [--port=9222] [--shots=<dir>]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const SHOTS =
  process.argv.find((a) => a.startsWith("--shots="))?.slice(8) ?? null;

const report = {};
/** Throws instead of exiting: the tab the user was on is restored on the way out. */
const fail = (message) => {
  throw new Error(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) =>
    reject(new Error(String(e.message ?? e))),
  );
});
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

// The overlay's own preview hook, driven through React's dispatcher. The fiber is found by display
// name; the hook is the last one in that component carrying a `dispatch`, which is the preview (the
// hook before it holds the placed images, and every hook after it is a ref). Walking by shape rather
// than by index keeps this working when the component's earlier hooks move.
const OVERLAY_FIBER = `(() => {
  const container = [...document.body.children].find((n) => Object.keys(n).some((k) => k.startsWith("__reactContainer$")));
  if (!container) throw new Error("no react container");
  const rootKey = Object.keys(container).find((k) => k.startsWith("__reactContainer$"));
  const host = container[rootKey];
  const root = host.stateNode?.current ?? host;
  const stack = [root];
  const seen = new Set();
  let found = null;
  while (stack.length) {
    const fiber = stack.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    const name = fiber.type?.displayName || fiber.type?.name || (typeof fiber.type === "string" ? fiber.type : "");
    if (name === "GhosttyImageOverlay") { found = fiber; break; }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  if (!found) return null;
  const hooks = [];
  let hook = found.memoizedState;
  while (hook) { hooks.push(hook); hook = hook.next; }
  return hooks.filter((h) => typeof h.queue?.dispatch === "function").pop() ?? null;
})()`;

/** Installs the walker in the page, so the two snippets below share it. */
const INSTALL_OVERLAY_FINDER = `window.__vertaOverlayHook = () => ${OVERLAY_FIBER.trim()};`;

const PREVIEW_HOOK = `(() => {
  return window.__vertaOverlayHook() ? "ok" : "no-hook";
})()`;

const SET_PREVIEW = (url) => `(() => {
  const hook = window.__vertaOverlayHook();
  if (!hook) return "no-overlay";
  hook.queue.dispatch(${JSON.stringify(url)});
  return "dispatched";
})()`;

// Tabs are Radix triggers: they switch on a pointer sequence, and a bare click does nothing.
const ACTIVATE = (id) => `(async () => {
  const target = [...document.querySelectorAll("[data-tab-id]")].find((el) => el.getAttribute("data-tab-id") === ${JSON.stringify(id)});
  if (!target) return "no-tab";
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  target.dispatchEvent(new PointerEvent("pointerdown", opts));
  target.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
  target.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  await new Promise((r) => setTimeout(r, 1200));
  return "ok";
})()`;

const ACTIVE_TAB = `(() => {
  const el = [...document.querySelectorAll("[data-tab-id]")].find((n) => n.getAttribute("data-tab-active") === "true");
  return el ? el.getAttribute("data-tab-id") : null;
})()`;

const TAB_IDS = `[...document.querySelectorAll("[data-tab-id]")].map((el) => el.getAttribute("data-tab-id"))`;

const VEIL_STATE = `JSON.stringify((() => {
  const veil = [...document.querySelectorAll("button")].find((b) => b.className.includes("bg-background/85"));
  if (!veil) return { found: false };
  const style = getComputedStyle(veil);
  const r = veil.getBoundingClientRect();
  const pane = document.querySelector("canvas")?.parentElement;
  const paneRect = pane && pane.getBoundingClientRect();
  const image = veil.querySelector("img");
  return {
    found: true,
    background: style.backgroundColor,
    zIndex: style.zIndex,
    pointerEvents: style.pointerEvents,
    backdropFilter: style.backdropFilter,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    pane: paneRect && { x: Math.round(paneRect.x), y: Math.round(paneRect.y), w: Math.round(paneRect.width), h: Math.round(paneRect.height) },
    coversPane: paneRect ? Math.abs(r.x - paneRect.x) < 2 && Math.abs(r.y - paneRect.y) < 2 && Math.abs(r.width - paneRect.width) < 2 && Math.abs(r.height - paneRect.height) < 2 : null,
    imageLoaded: image ? image.complete && image.naturalWidth > 0 : false,
    imageSize: image ? [image.naturalWidth, image.naturalHeight] : null,
  };
})())`;

const shot = async (name) => {
  if (!SHOTS) return;
  const pane = await evaluate(
    `(() => { const r = document.querySelector("canvas")?.parentElement?.getBoundingClientRect(); return r ? JSON.stringify({ x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) }) : null; })()`,
  );
  const clip = pane ? JSON.parse(pane) : null;
  const result = await send("Page.captureScreenshot", {
    format: "png",
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    `${SHOTS}/${name}.png`,
    Buffer.from(result.data, "base64"),
  );
};

// A picture with structure, so the veil over the session is readable in the photograph.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#3a7abf"/><circle cx="120" cy="150" r="80" fill="#f2c14e"/><rect x="240" y="60" width="180" height="180" fill="#c94f4f"/></svg>`;
const IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`;

let startedOn = null;
try {
  startedOn = await evaluate(ACTIVE_TAB);
  report.startedOn = startedOn;
  let onCanvas = await evaluate(`!!document.querySelector("canvas")`);
  if (!onCanvas) {
    // The overlay only renders inside a terminal pane, so a terminal tab is found by activating tabs
    // until one mounts a surface. A terminal tab's title is its shell's cwd, so it cannot be named.
    for (const id of JSON.parse(await evaluate(`JSON.stringify(${TAB_IDS})`))) {
      if (id === startedOn) continue;
      await evaluate(ACTIVATE(id));
      onCanvas = await evaluate(`!!document.querySelector("canvas")`);
      if (onCanvas) {
        report.terminalTab = id;
        break;
      }
    }
  }
  if (!onCanvas) {
    fail("没有挂载终端画布的标签页，先开一个终端标签页");
  }

  const hook = await (async () => {
    await evaluate(INSTALL_OVERLAY_FINDER);
    return evaluate(PREVIEW_HOOK);
  })();
  report.hook = hook;
  if (hook !== "ok") fail(`找不到预览状态的 hook：${hook}`);

  const result = await evaluate(SET_PREVIEW(IMAGE));
  report.dispatched = result;
  if (result !== "dispatched") fail(`预览状态没设上：${result}`);
  await sleep(600);

  const dark = JSON.parse(await evaluate(VEIL_STATE));
  report.darkTheme = dark;
  if (!dark.found) fail("预览浮层没出现");
  await shot("veil-dark");

  // A light theme, simulated by writing the pane colour the veil mixes: the veil is the only thing
  // under test, and swapping the theme for real would write the user's settings.
  const previous = await evaluate(
    `(() => { const v = document.documentElement.style.getPropertyValue("--background"); document.documentElement.style.setProperty("--background", "#ffffff"); return v; })()`,
  );
  await sleep(400);
  const light = JSON.parse(await evaluate(VEIL_STATE));
  report.lightTheme = light;
  await shot("veil-light");
  await evaluate(
    `(() => { const el = document.documentElement; ${JSON.stringify(previous)} ? el.style.setProperty("--background", ${JSON.stringify(previous)}) : el.style.removeProperty("--background"); return "restored"; })()`,
  );

  await evaluate(SET_PREVIEW(null));
  await sleep(300);
  const dismissed = await evaluate(VEIL_STATE);
  report.afterDismiss = dismissed;

  if (!dark.coversPane) {
    fail(`浮层没盖住窗格：${JSON.stringify({ veil: dark.rect, pane: dark.pane })}`);
  }
  if (!dark.imageLoaded) fail("图片没画出来");
  if (dark.backdropFilter !== "none") {
    fail(`浮层带了 backdrop-filter（${dark.backdropFilter}），超出合成预算`);
  }
  if (dismissed.found) fail("关掉预览后浮层还在");

  // The computed colour comes back whichever way the mix resolved, so both the RGB and the oklab
  // form are read: `lightness` is 0..1 either way, and `alpha` is the last number.
  const parse = (value) => {
    const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
    const oklab = value.startsWith("oklab") || value.startsWith("oklch");
    const channels = numbers.slice(0, 3);
    const alpha = numbers.length > 3 ? numbers[3] : 1;
    const lightness = oklab
      ? channels[0]
      : channels.every((v) => v <= 1)
        ? Math.max(...channels)
        : Math.max(...channels) / 255;
    return { alpha, lightness, raw: value };
  };
  const darkColor = parse(dark.background);
  const lightColor = parse(light.background);
  report.colors = { dark: darkColor, light: lightColor };
  for (const [label, color] of [
    ["暗色主题", darkColor],
    ["浅色主题", lightColor],
  ]) {
    if (Math.abs(color.alpha - 0.85) > 0.03) {
      fail(`${label}下浮层的 alpha 是 ${color.alpha}，不是 0.85（${color.raw}）`);
    }
  }
  if (lightColor.lightness < 0.8) {
    fail(`浅色主题下浮层是暗的（${light.background}），说明还在用固定黑色`);
  }
  if (darkColor.lightness > 0.45) {
    fail(`暗色主题下浮层是亮的（${dark.background}），与暗色界面不符`);
  }

  report.ok = true;
  if (startedOn && report.terminalTab && startedOn !== report.terminalTab) {
    // Back to the tab the user was on, which is theirs.
    await evaluate(ACTIVATE(startedOn));
    report.restoredTo = await evaluate(ACTIVE_TAB);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `PASS: 浮层是窗格底色 85%（暗色 ${dark.background} / 浅色 ${light.background}），盖住窗格，无 backdrop-filter`,
  );
} catch (error) {
  if (startedOn && report.terminalTab && startedOn !== report.terminalTab) {
    await evaluate(ACTIVATE(startedOn)).catch(() => {});
  }
  console.error(`FAIL: ${String(error?.message ?? error)}`);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}