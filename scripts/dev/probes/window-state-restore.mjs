// Acceptance for the window geometry the window-state plugin remembers.
//
// The question this answers: the file on disk (`.window-state.json`) records a size and a position,
// but the live window shows different numbers, so is the record ever applied at all?
//
// It is applied, and the file's numbers are simply not what the live window has:
//   - the plugin keeps move and resize in memory while the app runs and writes the file only on a
//     clean exit (`RunEvent::Exit`), so a file older than the running process describes the last
//     clean exit, not the window in front of the user (a dev app killed by a rebuild never writes);
//   - the restore itself is a Rust call on the window-ready event (`window.restore_state(flags)`),
//     not an IPC command, so no capability in `src-tauri/capabilities/default.json` is involved.
//
// To watch a restore happen, the probe creates a window whose record exists but which has not been
// created in this session: Settings. Its own builder asks for 900x700 while the record holds a
// different height, so the size it comes up with says whether the record was applied. It is opened
// through the header's own Settings button, and destroyed again at the end (the app only hides it on
// close, and a window this script created should not be left behind for the rest of the session).
//
// Usage: node scripts/dev/probes/window-state-restore.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { homedir } = await import("node:os");

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const statePath = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "app.verta",
  ".window-state.json",
);
const recorded = JSON.parse(readFileSync(statePath, "utf8"));
if (!recorded.main || !recorded.settings) {
  fail(`${statePath} 里没有 main / settings 的记录`);
}
report.statePath = statePath;
report.recorded = {
  main: recorded.main,
  settings: {
    width: recorded.settings.width,
    height: recorded.settings.height,
    x: recorded.settings.x,
    y: recorded.settings.y,
  },
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const mainPage = targets.find(
  (t) => t.type === "page" && t.url.endsWith("1420/"),
);
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
const GEOMETRY = `JSON.stringify({ inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], at: [screenX, screenY], dpr: devicePixelRatio })`;
const listTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter((t) =>
    t.url.includes("settings.html"),
  );
// Destroy rather than close: close is hidden by the app, and a hidden window has already had its
// state read, so a second run of this script could not measure a restore with it in the way.
//
// The answer to a destroy never arrives, because the target it would come from is gone by the time
// it is sent, so the call is fired and the work is judged by whether the target disappeared.
const destroy = async (page) =>
  Promise.race([
    page.evaluate(
      `window.__TAURI_INTERNALS__.invoke("plugin:window|destroy", { label: "settings" }).catch(() => "error")`,
    ),
    sleep(3000),
  ]).then(() => {
    page.socket.close();
  });

const waitGone = async () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await listTargets()).length === 0) return true;
    await sleep(400);
  }
  return false;
};

try {
  const main = await connect(mainPage.webSocketDebuggerUrl);
  report.live = { main: JSON.parse(await main.evaluate(GEOMETRY)) };

  const existing = await listTargets();
  if (existing.length > 0) {
    await destroy(await connect(existing[0].webSocketDebuggerUrl));
    report.clearedExisting = await waitGone();
    if (!report.clearedExisting) {
      fail("这个会话里已经有过一个设置窗口，而且销毁不掉：量不到一次真正的恢复");
    }
  }

  const clicked = await main.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "") === "设置");
    if (!button) return "no-button";
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    button.dispatchEvent(new PointerEvent("pointerdown", opts));
    button.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    button.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    return "clicked";
  })()`);
  if (clicked !== "clicked") fail(`没找到页头的设置按钮：${clicked}`);

  let settingsPage = null;
  for (let attempt = 0; attempt < 20 && !settingsPage; attempt += 1) {
    await sleep(500);
    settingsPage = (await listTargets())[0] ?? null;
  }
  if (!settingsPage) fail("设置窗口没有出现");

  const settings = await connect(settingsPage.webSocketDebuggerUrl);
  await sleep(1200);
  const live = JSON.parse(await settings.evaluate(GEOMETRY));
  report.live.settings = live;
  report.codeDefault = { width: 900, height: 700 };

  report.cleanup = true;
  await destroy(settings);
  report.leftBehind = (await waitGone()) ? 0 : (await listTargets()).length;

  const record = recorded.settings;
  report.compared = {
    width: live.inner[0] - record.width,
    height: live.inner[1] - record.height,
    x: live.at[0] - record.x,
    y: live.at[1] - record.y,
  };
  const isCodeDefault = live.inner[0] === 900 && live.inner[1] === 700;
  report.kept = {
    isCodeDefault,
    widthMatchesRecord: Math.abs(report.compared.width) <= 2,
    positionNearRecord:
      Math.abs(report.compared.x) <= 12 && Math.abs(report.compared.y) <= 12,
  };

  if (isCodeDefault) {
    fail(
      `设置窗口用了代码里的 900x700，没用记录里的 ${record.width}x${record.height}，说明记录没有被应用`,
    );
  }
  if (!report.kept.widthMatchesRecord) {
    fail(`宽度不是记录里的：${live.inner[0]} 对 ${record.width}`);
  }
  if (report.leftBehind !== 0) {
    fail(`设置窗口没被销毁，还剩 ${report.leftBehind} 个目标`);
  }

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `PASS: 设置窗口按记录打开（记录 ${record.width}x${record.height} at ${record.x},${record.y}，实际 ${live.inner[0]}x${live.inner[1]} at ${live.at[0]},${live.at[1]}，代码默认 900x700）`,
  );
  if (report.compared.height !== 0) {
    console.log(
      `注意：高度比记录多 ${report.compared.height} px。tao 在 set_inner_size 里会给"无边框但保留阴影"的窗口补一次隐藏偏移（window_rect - client_rect），记录的是客户端高度，所以补完之后客户端就比记录高。设置窗口是全应用唯一保留阴影的无边框窗口（主窗口 shadow: false、截图浮层 .shadow(false)），详见 VERTA.md 的 Window styling。`,
    );
  }
  main.socket.close();
} catch (error) {
  fail(String(error?.message ?? error));
}
