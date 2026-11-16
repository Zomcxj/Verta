// Does the mask come up before the usage window, or after it?
//
// Reported as "点击后先出现蒙版再弹窗口" (the mask first, the window after). The window is its own
// webview: a first open builds it and boots a page before anything can be on screen, so a mask raised
// by the click is up over nothing. This drives the **real** path - the header button - and reports, on
// one clock:
//
//   * t0             the button is clicked
//   * page target    the usage webview exists (still hidden)
//   * first paint    the usage page's own first paint, from `performance.getEntriesByType("paint")`
//   * content        when `[data-usage-updated-at]` is in the page (cached payload or live read)
//   * mask added     when `[data-slot="floating-scrim"]` appears in the main window
//
// The mask is raised by the usage page right after `show()`, so "mask added" is the window's own
// announcement: a mask that appears before the click returns is the bug this measures for.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   node scripts/dev/probes/usage-mask-order.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return { send, evaluate, close: () => socket.close() };
}

const targets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();
const findMain = (list) =>
  list.find(
    (t) =>
      t.type === "page" &&
      (t.url.endsWith("1420/") || t.url === "http://tauri.localhost/"),
  );
const findUsage = (list) =>
  list.find((t) => t.type === "page" && t.url.includes("usage.html"));

const mainTarget = findMain(await targets());
if (!mainTarget) {
  console.error("没有主窗口的 page 目标：应用带 --remote-debugging-port 起来了吗");
  process.exit(1);
}
const app = await connect(mainTarget.webSocketDebuggerUrl);

const maskUp = () =>
  app.evaluate(`!!document.querySelector('[data-slot="floating-scrim"]')`);

/** Put the window back to "never opened" the way a person does: close it. */
const closeUsage = async () => {
  const usage = findUsage(await targets());
  if (!usage) return;
  const page = await connect(usage.webSocketDebuggerUrl);
  await page.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "usage" }).catch((e) => String(e))`,
  );
  page.close();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && (await maskUp())) await sleep(30);
};

const watchMask = () =>
  app.evaluate(`(() => {
    window.__mask = { added: null };
    if (window.__maskObserver) window.__maskObserver.disconnect();
    window.__maskObserver = new MutationObserver(() => {
      if (window.__mask.added === null && document.querySelector('[data-slot="floating-scrim"]')) {
        window.__mask.added = Date.now();
      }
    });
    window.__maskObserver.observe(document.body, { childList: true, subtree: true });
    return true;
  })()`);

const clickOpen = () =>
  app.evaluate(`(() => {
    const button = [...document.querySelectorAll("button[title]")]
      .find((b) => b.title === "用量统计" || b.title === "Usage");
    if (!button) return "no button";
    button.click();
    return "clicked";
  })()`);

const usageTiming = async () => {
  const found = findUsage(await targets());
  if (!found) return null;
  const page = await connect(found.webSocketDebuggerUrl);
  const timing = await page.evaluate(`(() => {
    const paints = Object.fromEntries(
      performance.getEntriesByType("paint").map((e) => [e.name, Math.round(performance.timeOrigin + e.startTime)]),
    );
    return {
      paints,
      content: !!document.querySelector("[data-usage-updated-at]"),
      source: document.querySelector("[data-usage-updated-at]")?.getAttribute("data-usage-updated-at") ?? null,
    };
  })()`);
  page.close();
  return timing;
};

const run = async (label) => {
  await closeUsage();
  await sleep(300);
  await watchMask();
  const t0 = Date.now();
  const clicked = await clickOpen();
  if (clicked !== "clicked") throw new Error(`${label}: 表头没有用量按钮`);

  let targetAt = null;
  const targetDeadline = Date.now() + 20_000;
  while (targetAt === null && Date.now() < targetDeadline) {
    if (findUsage(await targets())) targetAt = Date.now();
    else await sleep(20);
  }
  const timing = await usageTiming();
  const maskDeadline = Date.now() + 20_000;
  let mask = null;
  while (Date.now() < maskDeadline) {
    mask = await app.evaluate(`window.__mask?.added ?? null`);
    if (mask !== null && timing?.content) break;
    await sleep(20);
  }
  const first = timing?.paints["first-paint"] ?? null;
  const row = {
    label,
    targetAt: targetAt === null ? null : targetAt - t0,
    firstPaint: first === null ? null : first - t0,
    maskAdded: mask === null ? null : mask - t0,
    source: timing?.source ?? null,
  };
  console.log(JSON.stringify(row));
  return row;
};

const first = await run("first open");
const second = await run("second open");

const wrong = [first, second].filter(
  (row) => row.maskAdded !== null && row.maskAdded < (row.targetAt ?? 0),
);
if (wrong.length) {
  console.log(
    `\nGLITCH: the mask was up before the window existed (${wrong.map((r) => r.label).join(", ")})`,
  );
  process.exit(1);
}
console.log("\nORDER OK: every mask came after the window it dims for");
