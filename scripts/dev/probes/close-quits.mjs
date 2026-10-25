// The one rule for "closing the main window leaves the app": with close-to-tray off, closing the main
// window ends the process even when the settings window and the screenshot overlay are alive (they are
// hidden rather than destroyed, which is what used to keep verta.exe running).
//
// This one closes the app for real, so it runs by itself: it opens a settings window, closes the main
// window through the app's own titlebar button, and polls the debug port until the process is gone.
// After a pass the app is closed and has to be started again.
//
// The run needs the close-to-tray preference off. Rather than write the user's settings, the probe
// checks the stored preference file first and refuses to run (exit code 2) when it is on, so the
// person running it decides to flip the switch and to flip it back.
//
// Usage: node scripts/dev/probes/close-quits.mjs [--port=9222] [--timeout=25000]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const timeoutMs = Number(
  process.argv.find((a) => a.startsWith("--timeout="))?.slice(10) ?? 25000,
);

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { homedir } = await import("node:os");

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const settingsPath = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "app.verta",
  "verta-settings.json",
);
const stored = JSON.parse(readFileSync(settingsPath, "utf8"));
if (stored.closeToTray !== false) {
  console.error(
    `SKIP: 关闭时收进托盘现在是 ${stored.closeToTray === true ? "开" : "未设置（默认开）"}；这条要验的是关掉它之后的行为。先在设置里把它关掉，再跑一次。`,
  );
  process.exit(2);
}
report.closeToTray = false;

const listTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(
    (t) => t.type === "page",
  );

const targets = await listTargets();
const mainPage = targets.find((t) => t.url.endsWith("1420/"));
if (!mainPage) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}

const connect = async (url) => {
  const socket = new WebSocket(url);
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
  return { socket, send, evaluate };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLICK_TITLE = (title) => `(() => {
  const button = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "") === ${JSON.stringify(title)});
  if (!button) return "no-button";
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  button.dispatchEvent(new PointerEvent("pointerdown", opts));
  button.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
  button.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  return "clicked";
})()`;

try {
  const main = await connect(mainPage.webSocketDebuggerUrl);

  // A settings window alive: the hidden webview that used to keep the process up.
  await main.evaluate(CLICK_TITLE("设置"));
  let settings = null;
  for (let attempt = 0; attempt < 20 && !settings; attempt += 1) {
    await sleep(400);
    settings = (await listTargets()).find((t) =>
      t.url.includes("settings.html"),
    );
  }
  report.settingsOpened = Boolean(settings);
  if (!settings) fail("设置窗口没起来");
  const settingsPage = await connect(settings.webSocketDebuggerUrl);
  const hidden = await settingsPage.evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:window|hide", { label: "settings" }).then(() => "hidden").catch((e) => "error: " + String(e))`,
  );
  settingsPage.socket.close();
  report.settingsHidden = hidden;
  if (hidden !== "hidden") {
    fail(`设置窗口藏不起来，这一轮测不到「有隐藏窗口时关主窗口」：${hidden}`);
  }

  const clicked = await main.evaluate(CLICK_TITLE("关闭"));
  main.socket.close();
  report.clicked = clicked;
  if (clicked !== "clicked") fail(`没找到关闭主窗口的按钮：${clicked}`);

  const started = Date.now();
  let alive = true;
  while (Date.now() - started < timeoutMs) {
    await sleep(300);
    try {
      await listTargets();
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) break;
  }
  report.quitAfterMs = Date.now() - started;
  if (alive) {
    fail(
      `关掉主窗口 ${timeoutMs}ms 后应用还在（设置窗口已经藏起来了，撑着进程的就是它）`,
    );
  }

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `PASS: 关到托盘关掉时，藏着一个设置窗口的情况下关主窗口，${report.quitAfterMs}ms 后整个应用退出（调试端口也没了）`,
  );
} catch (error) {
  fail(String(error?.message ?? error));
}
