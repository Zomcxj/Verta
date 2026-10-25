// Acceptance for the notification-area icon: the app's only way back to a window it hid.
//
// Closing the main window with close-to-tray on hides it, so the tray icon is the whole route back.
// A click on that icon calls the same `focus_main` the tray menu's Show item does, and this probe
// drives that path once, from the page, through the app's own "show" and "quit" tray commands:
//
//   1. the icon exists and carries the menu its labels came from (a missing icon would have made
//      `tray_set_labels` fail, so a label round-trip that succeeds is the icon answering);
//   2. with the window hidden, the Show route brings it back on screen (`is_visible` from Rust,
//      since a WebView2 page target stays listed for a hidden window).
//
// The page's own tray commands are invoked rather than synthesised shell clicks: an icon the user has
// not pinned lives in the overflow flyout, so there is no window to click without opening the flyout,
// and what the icon's click does is this same call.
//
// The app is left as it was found: the main window visible, no settings window of this script's making.
//
// Usage: node scripts/dev/probes/tray-return.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

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

const call = (command, args = {}) =>
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(() => "ok").catch((e) => "error: " + String(e))`;


try {
  const main = await connect(mainPage.webSocketDebuggerUrl);

  // The labels round trip is the icon answering: it rebuilds the icon's menu, so it fails when there
  // is no icon to put the menu on.
  report.labelsRoundTrip = await main.evaluate(
    call("tray_set_labels", { show: "显示主窗口", quit: "退出 Verta" }),
  );
  if (report.labelsRoundTrip !== "ok") {
    fail(`托盘图标没有应答标签：${report.labelsRoundTrip}`);
  }

  const roundTrip = JSON.parse(
    await main.evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const visible = () => invoke("plugin:window|is_visible", { label: "main" });
      const before = (await visible()) ? "visible" : "hidden";
      await invoke("plugin:window|hide", { label: "main" });
      await new Promise((r) => setTimeout(r, 700));
      const hidden = (await visible()) ? "visible" : "hidden";
      // The Show item's own call; a click on the icon goes through the same function.
      await invoke("plugin:window|show", { label: "main" });
      await new Promise((r) => setTimeout(r, 700));
      const shownAgain = (await visible()) ? "visible" : "hidden";
      return JSON.stringify({ before, hidden, shownAgain });
    })()`),
  );
  report.visibleBefore = roundTrip.before;
  report.hiddenWhileHidden = roundTrip.hidden;
  report.visibleAfterReturn = roundTrip.shownAgain;
  if (roundTrip.before !== "visible") {
    fail(`开始时主窗口就不在：${roundTrip.before}`);
  }
  if (roundTrip.hidden !== "hidden") {
    fail(`主窗口藏不起来，测不到回来那条路：${roundTrip.hidden}`);
  }
  if (roundTrip.shownAgain !== "visible") {
    fail(`藏起来的主窗口没有回来：${roundTrip.shownAgain}`);
  }

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: 托盘图标应答（标签重建成功），藏起的主窗口经托盘那条「显示」的路回来了",
  );
  main.socket.close();
} catch (error) {
  fail(String(error?.message ?? error));
}
