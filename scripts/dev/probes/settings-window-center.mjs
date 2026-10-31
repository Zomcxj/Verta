// Where the settings window opens.
//
// "Always centred" is a claim about a window's position, and a window's position is the one thing the
// source cannot show: the window-state plugin saves and restores it, so a window that is centred when
// it is built can come back wherever it was last moved. This measures the live windows instead: the
// settings window's box against the main window's, and against the work area it is clamped to.
//
// "Centred" means the middle of the main window rather than the middle of the screen. A screen centre
// drifts away from the main window as soon as that window is moved or is not maximised, so the old
// reading passes for a window that opens over empty desktop. Both numbers are printed, so the run
// shows which rule the window actually followed.
//
// Usage:
//   node scripts/dev/probes/settings-window-center.mjs
//   node scripts/dev/probes/settings-window-center.mjs --move-main
//   node scripts/dev/probes/settings-window-center.mjs --tolerance=4
//
// `--move-main` is the interesting case: it puts the main window near the bottom-left of the work
// area first (through scripts/dev/move-window.ps1), asks for the settings window again through the
// application's own command, and only then measures. A main window in the middle of the screen is
// the one position where the two rules agree, so a check that never moves it proves nothing.
//
// The settings window has to exist. Exits 2 when it does not: nothing measured is not a pass.
import { spawnSync } from "node:child_process";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const tolerance = Number(arg("tolerance") ?? "4");
const moveMain = process.argv.includes("--move-main");

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const pages = targets.filter((t) => t.type === "page");
const settingsTarget = pages.find((t) => t.url.includes("settings.html"));
const mainTarget = pages.find(
  (t) => !t.url.includes("settings.html") && /(localhost:1420|tauri\.localhost)\/?$/.test(t.url),
);
if (!settingsTarget || !mainTarget) {
  console.error(
    `没找到窗口（主窗口 ${mainTarget ? "有" : "没有"}，设置窗口 ${settingsTarget ? "有" : "没有"}）：先把两个窗口都打开再跑这个探针。`,
  );
  process.exit(2);
}

/** One CDP session per window, since each page reports its own window's box. */
async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  await new Promise((resolve) => socket.addEventListener("open", () => resolve()));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const current = id++;
      pending.set(current, (message) =>
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  const evaluate = async (body) => {
    const result = await send("Runtime.evaluate", {
      expression: `(async () => {\n${body}\n})()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  };
  return { evaluate, close: () => socket.close() };
}

const boxOf = (session) =>
  session.evaluate(`
    return {
      x: Math.round(window.screenX),
      y: Math.round(window.screenY),
      w: Math.round(window.outerWidth),
      h: Math.round(window.outerHeight),
      work: { w: window.screen.availWidth, h: window.screen.availHeight },
      screen: { w: window.screen.width, h: window.screen.height },
      dpr: window.devicePixelRatio,
    };
  `);

const main = await connect(mainTarget);
const settings = await connect(settingsTarget);

try {
  const before = await boxOf(main);
  let moved = null;
  if (moveMain) {
    // Bottom-left of the work area: as far from the screen centre as this display allows, which is
    // the position the two rules disagree at.
    const x = 40;
    const y = Math.max(0, before.work.h - before.h - 40);
    const script = "scripts/dev/move-window.ps1";
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-X", String(x), "-Y", String(y), "-WaitMs", "9000"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      console.error(`移动主窗口失败：${result.stdout?.trim()} ${result.stderr?.trim()}`);
      process.exit(3);
    }
    moved = result.stdout.trim();
    // Ask for the settings window again through the application's own command: re-opening is what
    // re-centres it, and it is the same call the header's button makes.
    await main.evaluate(`
      await window.__TAURI_INTERNALS__.invoke("open_settings_window", {});
      return true;
    `);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  const mainBox = await boxOf(main);
  const box = await boxOf(settings);

  // Put the main window back where it was: its geometry is saved by the window-state plugin, so a
  // window left where the probe put it would come back there on the next launch.
  if (moveMain) {
    const restore = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/dev/move-window.ps1",
        "-X",
        String(before.x),
        "-Y",
        String(before.y),
        "-WaitMs",
        "9000",
      ],
      { encoding: "utf8" },
    );
    console.log(`恢复主窗口位置：${restore.stdout?.trim() || restore.stderr?.trim()}`);
  }

  // The rule the application applies: the main window's middle, clamped to the work area.
  const wanted = {
    x: mainBox.x + Math.floor((mainBox.w - box.w) / 2),
    y: mainBox.y + Math.floor((mainBox.h - box.h) / 2),
  };
  const clamped = {
    x: Math.max(0, Math.min(wanted.x, box.work.w - box.w)),
    y: Math.max(0, Math.min(wanted.y, box.work.h - box.h)),
  };
  const onMain = { x: Math.abs(box.x - clamped.x), y: Math.abs(box.y - clamped.y) };
  const screenCentre = {
    x: Math.round((box.screen.w - box.w) / 2),
    y: Math.round((box.screen.h - box.h) / 2),
  };
  const onScreen = { x: Math.abs(box.x - screenCentre.x), y: Math.abs(box.y - screenCentre.y) };

  console.log(`主窗口  ${mainBox.w}x${mainBox.h} @(${mainBox.x},${mainBox.y})`);
  if (moved !== null) console.log(`        ${moved}`);
  console.log(`设置窗口 ${box.w}x${box.h} @(${box.x},${box.y})   缩放 ${box.dpr}`);
  console.log(`工作区  ${box.work.w}x${box.work.h}`);
  console.log(`主窗口中点 → (${clamped.x},${clamped.y})  差 ${onMain.x},${onMain.y}`);
  console.log(`屏幕中点   → (${screenCentre.x},${screenCentre.y})  差 ${onScreen.x},${onScreen.y}`);

  if (box.w === 900 && Math.abs(box.h - 910) <= 44) {
    console.log(`尺寸 通过：内高 ${box.h}（含自绘标题栏，代码里要的是 910）`);
  } else {
    console.log(`尺寸 未确认：${box.w}x${box.h}，代码里要的是 900x910 的内高`);
  }

  if (onMain.x <= tolerance && onMain.y <= tolerance) {
    console.log(`\n通过：设置窗口在主窗口正中（误差 ≤ ${tolerance}px）。`);
    process.exit(0);
  }
  console.log(`\n不通过：设置窗口不在主窗口正中，差 ${onMain.x},${onMain.y} px。`);
  process.exit(1);
} finally {
  main.close();
  settings.close();
}
