// Does a launch bring back the tabs the last window closed with, and does a session
// tab actually reopen its session instead of sitting there as a bare shell?
//
// Two stages, because the first one quits the app for real (and with it the dev
// runner):
//
//   node scripts/dev/probes/tab-restore.mjs --stage=setup
//     Builds the scene in the live window: a scratch terminal tab, a throwaway pi
//     session in it, that session opened the app's own way (a row click, so the tab
//     carries the session id), then the app is asked to quit through its own
//     `app_quit` and the process is waited for. Finish by stating what the tab list on
//     disk has to contain.
//
//   (restart `pnpm tauri dev`, then)
//   node scripts/dev/probes/tab-restore.mjs --stage=check
//     Against the fresh window: the saved tabs are back, and the session row carries
//     a judge state - which only happens when the session's own UI is live on screen,
//     i.e. the tab resumed the session rather than restoring a shell.
//
// Both stages drive the window through the dev server's own modules, so this probe runs
// against `pnpm tauri dev` only; pointed at a compiled build it says so and stops.
//
// The run turns the restore switch on itself - it is off by default - and puts back the value it
// found, at the end. The quit goes through the app's own `app_quit` command, so close-to-tray does
// not matter here (that switch only decides what the titlebar's close button does).
//
// Three stages, because each quit takes the dev runner with it:
//   setup -> (restart `pnpm tauri dev`) -> check -> (restart) -> check-off
// `check-off` is the launch the default now promises: one cold terminal, the saved list unused.
//
// Usage: node scripts/dev/probes/tab-restore.mjs [--stage=setup|check] [--port=9222]
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const stage = args.find((a) => a.startsWith("--stage="))?.slice(8) ?? "setup";
const port = args.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const appData = join(
  process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
  "app.verta",
);
const settingsPath = join(appData, "verta-settings.json");
const tabsPath = join(appData, "verta-tabs.json");
const statePath = join(tmpdir(), "verta-tab-restore-probe-state.json");
const scratch = join(tmpdir(), "verta-restore-probe");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { stage };
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

// --- preflight (both stages) --------------------------------------------------------------------

let settings = {};
try {
  settings = JSON.parse(readFileSync(settingsPath, "utf8"));
} catch {
  console.error("SKIP: 读不到 verta-settings.json，应用还没跑过？");
  process.exit(2);
}
// The switch is off by default, so the value the user had is remembered here and put back at the
// end; the probe turns it on itself rather than asking anyone to open settings first.
const originalSwitchOn = settings.restoreTabsOnLaunch === true;

// --- CDP ----------------------------------------------------------------------------------------

const listTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(
    (t) => t.type === "page",
  );

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
    // Wrapped in an async IIFE: a probe snippet may `await` a dynamic import, and
    // Runtime.evaluate only awaits a promise when the script itself returns one.
    const result = await send("Runtime.evaluate", {
      expression: `(async () => {\n${expression}\n})()`,
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

const mainPage = async () => {
  const targets = await listTargets();
  // Dev serves the window from the vite server (`.../` on 1420); a compiled build serves
  // it from tauri's own protocol (`http://tauri.localhost/`). Both are the main window.
  const page = targets.find(
    (t) =>
      t.url.endsWith("1420/") ||
      (t.url.includes("tauri.localhost") &&
        !t.url.includes("settings.html") &&
        !t.url.includes("screenshot.html")),
  );
  if (!page) throw new Error("没找到主窗口的 page 目标，应用起来了吗？");
  return page;
};

// A real click, the way the interface sees one.
const PRESS_FN = `
  window.__probe = window.__probe || {};
  window.__probe.press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
`;
const clickButton = (match) => `
  ${PRESS_FN}
  const button = [...document.querySelectorAll("button")].find(${match});
  if (!button) return "no-button";
  window.__probe.press(button);
  return "clicked";
`;

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
`;

/**
 * This probe drives the window through the dev server's own modules (writing into a leaf,
 * reading a screen), so it only works against `pnpm tauri dev`. A compiled build bundles
 * those modules into one file and has no such URLs; say so instead of failing on an import.
 */
const requireDevModules = async (cdp) => {
  const available = await cdp.evaluate(`
    const urls = performance.getEntriesByType("resource").map((e) => e.name);
    return urls.some((n) => n.includes("/src/modules/")) ? "yes" : "no";
  `);
  if (available !== "yes") {
    fail(
      "这个窗口是编译版（没有 dev 的 /src 模块）。这条探针要跑在 `pnpm tauri dev` 起的窗口上；编译版请手动按 README/对话里的步骤点一遍。",
    );
  }
};

/** The restore switch, read and written the way a click in settings writes it. */
const setSwitch = (cdp, value) =>
  cdp.evaluate(`${MODULES}
    const store = await import(find("modules/settings/store.ts"));
    await store.setRestoreTabsOnLaunch(${JSON.stringify(value)});
    const prefs = await import(find("modules/settings/preferences.ts"));
    return JSON.stringify(prefs.usePreferencesStore.getState().restoreTabsOnLaunch);
  `);

const CHORDS = {
  "Ctrl+T": { key: "t", code: "KeyT", keyCode: 84, text: "\t", modifiers: 2 },
  "Ctrl+C": { key: "c", code: "KeyC", keyCode: 67, text: "", modifiers: 2 },
  "Ctrl+D": { key: "d", code: "KeyD", keyCode: 68, text: "", modifiers: 2 },
};
const pressChord = async (cdp, name) => {
  const spec = CHORDS[name];
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers: spec.modifiers,
  };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: "" });
};

const readTabsFile = () => {
  try {
    return JSON.parse(readFileSync(tabsPath, "utf8"))?.state ?? null;
  } catch {
    return null;
  }
};

// The shell reports its own spelling of the path (Git Bash hands over `/c/...`, the pane
// may hold `C:\...`), so the marker is the directory name rather than one exact string.
const treeHasDirNamed = (node, name) =>
  node.kind === "leaf"
    ? typeof node.cwd === "string" &&
      node.cwd.replaceAll("\\", "/").split("/").filter(Boolean).pop() === name
    : (node.children ?? []).some((c) => treeHasDirNamed(c, name));

// --- stage: setup -------------------------------------------------------------------------------

if (stage === "setup") {
  if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true });
  const probeDirName = basename(scratch);
  report.scratch = scratch;

  const cdp = await connect((await mainPage()).webSocketDebuggerUrl);
  await requireDevModules(cdp);

  // The default is off; the switch goes on through the app's own module, the same write a click in
  // settings makes. What the user had is put back by `--stage=check-off`.
  const switchInfo = JSON.parse(
    await cdp.evaluate(`${MODULES}
      const store = await import(find("modules/settings/store.ts"));
      const prefs = await import(find("modules/settings/preferences.ts"));
      return JSON.stringify({
        default: store.DEFAULT_PREFERENCES.restoreTabsOnLaunch,
        before: prefs.usePreferencesStore.getState().restoreTabsOnLaunch,
      });
    `),
  );
  report.switch = switchInfo;
  if (switchInfo.default !== false) {
    fail(`restoreTabsOnLaunch 默认值是 ${switchInfo.default}，应默认关`);
  }
  if (switchInfo.before !== true) {
    report.switchSet = await setSwitch(cdp, true);
  }

  // A plain terminal tab, then the scratch directory is reached by typing into it,
  // which is what a person does and leaves the tab's cwd as the scratch one.
  const leavesBefore = JSON.parse(
    await cdp.evaluate(`${MODULES}
      return JSON.stringify(sessions.ghosttySessionDiagnostics().map((d) => d.leafId));`),
  );
  await pressChord(cdp, "Ctrl+T");
  let leaf = null;
  for (let i = 0; i < 40 && leaf === null; i += 1) {
    await sleep(250);
    const now = JSON.parse(
      await cdp.evaluate(`${MODULES}
        return JSON.stringify(sessions.ghosttySessionDiagnostics().map((d) => d.leafId));`),
    );
    leaf = now.find((l) => !leavesBefore.includes(l)) ?? null;
  }
  if (leaf === null) fail("Ctrl+T 之后没看到新的终端叶子");
  report.leaf = leaf;
  await sleep(1200);

  const writeTo = (text) =>
    cdp.evaluate(
      `${MODULES}\n  return api.writeToSession(${leaf}, ${JSON.stringify(text)});`,
    );
  await writeTo(`cd "${scratch.replaceAll("\\", "/")}"\r`);
  await sleep(1500);

  // A throwaway pi session: start the agent, wait until its session shows up in the
  // store, then leave it so the row click below is the only one resuming it.
  await writeTo("pi\r");
  const scratchPosix = scratch.replaceAll("\\", "/");
  const findSession = async () => {
    const payload = await cdp.evaluate(`
      const invoke = window.__TAURI_INTERNALS__.invoke;
      return invoke("agent_sessions_list", { tool: "pi", distro: null }).then((p) =>
        JSON.stringify(p.sessions ?? []));
    `);
    const list = JSON.parse(payload);
    // The store may spell the directory `C:\...`, `/c/...` or with forward slashes,
    // depending on which shell started pi: match the directory it ends in.
    const dirNameOf = (p) =>
      (p ?? "").replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "";
    return (
      list
        .filter((s) => dirNameOf(s.cwd) === probeDirName)
        .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))[0] ?? null
    );
  };
  let session = null;
  for (let i = 0; i < 40 && !session; i += 1) {
    await sleep(500);
    session = await findSession();
  }
  if (!session) {
    // pi records the session on its first turn on some versions: give it one.
    await writeTo("probe\r");
    for (let i = 0; i < 24 && !session; i += 1) {
      await sleep(500);
      session = await findSession();
    }
  }
  if (!session) fail("scratch 目录里没等来一个 pi 会话");
  report.sessionId = session.id;

  // Leave the agent so the row click below is the only one driving this session.
  await pressChord(cdp, "Ctrl+C");
  await sleep(600);
  await pressChord(cdp, "Ctrl+D");
  await sleep(800);
  const busy = await cdp.evaluate(
    `${MODULES}\n  return api.leafHasForegroundProcess(${leaf});`,
  );
  if (busy) {
    await writeTo("/exit\r");
    await sleep(1200);
  }

  // Open the session the app's own way: a row click. This is the tab that carries
  // the session id and the resume marker.
  const pressRail = () =>
    cdp.evaluate(clickButton(
      `(b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === "会话"
        || (b.getAttribute("aria-label") || b.textContent || "").trim() === "Sessions"`,
    ));
  const rowsOnScreen = () =>
    cdp.evaluate(`return document.querySelectorAll("button[data-session-id]").length;`);
  let rows = 0;
  for (let attempt = 0; attempt < 3 && rows === 0; attempt += 1) {
    const pressed = await pressRail();
    if (pressed !== "clicked") fail(`侧栏的会话按钮没找到：${pressed}`);
    for (let i = 0; i < 8 && rows === 0; i += 1) {
      await sleep(400);
      rows = await rowsOnScreen();
    }
  }
  if (rows === 0) fail("会话列表没画出来");
  const sessionSelector = JSON.stringify(session.id);
  let row = null;
  for (let i = 0; i < 30 && !row; i += 1) {
    row = await cdp.evaluate(`
      return document.querySelector('button[data-session-id=' + ${sessionSelector} + ']') ? "found" : null;
    `);
    if (!row) await sleep(400);
  }
  if (!row) fail("会话列表里没找到 scratch 的那条会话行");
  const clickedRow = await cdp.evaluate(`
    ${PRESS_FN}
    const row = document.querySelector('button[data-session-id=' + ${sessionSelector} + ']');
    if (!row) return null;
    const label = (row.textContent || "").trim();
    window.__probe.press(row);
    return label;
  `);
  if (!clickedRow) fail("会话行没点动");
  // The tab this opens is titled with the session's name, which is how the check stage
  // finds it again to tidy up.
  report.sessionTitle = clickedRow;
  // The resume has to land and the cover has to lift before this is the scene.
  await sleep(7000);
  report.tabsAfterOpen = await cdp.evaluate(
    `return document.querySelectorAll("[data-tab-id]").length;`,
  );

  // The persistence write is debounced by three seconds; wait past it and then read
  // back what a launch will be asked to restore.
  await sleep(4500);
  const saved = readTabsFile();
  report.savedList = {
    tabs: saved?.tabs?.length ?? 0,
    hasScratchDir: (saved?.tabs ?? []).some((t) =>
      treeHasDirNamed(t?.tree ?? {}, probeDirName),
    ),
    hasSession: (saved?.tabs ?? []).some((t) => t.sessionId === session.id),
  };
  if (!report.savedList.hasScratchDir) fail("verta-tabs.json 里没有 scratch 目录的终端");
  if (!report.savedList.hasSession) fail("verta-tabs.json 里没有带会话的标签");
  if ((saved?.tabs?.length ?? 0) < 2) fail("存盘的标签数不对，至少要有原有标签加 scratch 两个");

  writeFileSync(
    statePath,
    JSON.stringify({
      sessionId: session.id,
      sessionTitle: report.sessionTitle ?? null,
      scratch: scratchPosix,
      tabs: saved.tabs,
      originalSwitchOn,
    }),
  );

  // Quit for real through the app's own quit, then wait for the debug port to go quiet.
  // (The titlebar close is the close-to-tray switch's business; `app_quit` is what the
  // tray's quit item calls.)
  await cdp.evaluate(
    `window.__TAURI_INTERNALS__.invoke("app_quit").catch(() => {}); "quit"`,
  );
  cdp.socket.close();
  let alive = true;
  const started = Date.now();
  while (Date.now() - started < 25000) {
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
  if (alive) fail("app_quit 之后 25s 应用还在，退不出就没法验下一次启动");

  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS(setup): 现场造好了，应用已退出。dev 也跟着退了：重新 `pnpm tauri dev`，起来后跑 --stage=check。",
  );
  process.exit(0);
}

// --- stage: check -------------------------------------------------------------------------------

let saved = null;
try {
  saved = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  console.error("SKIP: 找不到 setup 留下的现场记录，先跑 --stage=setup。");
  process.exit(2);
}

if (stage !== "check") {
  console.error(`未知 stage：${stage}（应为 setup / check / check-off）`);
  process.exit(2);
}

// Boot has to settle: restore, the active session tab resuming, pi painting, the
// judge ticking, and the first persistence write of the new window.
await sleep(9000);

const cdp = await connect((await mainPage()).webSocketDebuggerUrl);
await requireDevModules(cdp);

// 1. The saved list came back: the scratch terminal is in the strip by title.
const titles = await cdp.evaluate(`
  return [...document.querySelectorAll("[data-tab-id]")].map((el) => (el.textContent || "").trim());
`);
report.tabsOnScreen = titles;
report.scratchTabBack = titles.some((t) => t.includes(basename(scratch)));
if (!report.scratchTabBack) fail("标签条上没有 scratch 那个终端标签，列表没恢复");

// 2. The list on disk is still the restored one (the new window rewrote it with fresh ids).
const rewritten = readTabsFile();
report.rewritten = {
  tabs: rewritten?.tabs?.length ?? 0,
  hasSession: (rewritten?.tabs ?? []).some((t) => t.sessionId === saved.sessionId),
};
if (!report.rewritten.hasSession) fail("新窗口存回盘的列表里没有会话标签，恢复列表没落地");

// 3. The session was reopened, not restored as a bare shell: the judge can only name a
// state for that row when pi's own UI is live on a screen.
const pressRail = () =>
  cdp.evaluate(clickButton(
    `(b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === "会话"
      || (b.getAttribute("aria-label") || b.textContent || "").trim() === "Sessions"`,
  ));
let rows = 0;
for (let attempt = 0; attempt < 3 && rows === 0; attempt += 1) {
  await pressRail();
  for (let i = 0; i < 8 && rows === 0; i += 1) {
    await sleep(400);
    rows = await cdp.evaluate(
      `return document.querySelectorAll("button[data-session-id]").length;`,
    );
  }
}
if (rows === 0) fail("会话列表没画出来");
const rowState = await cdp.evaluate(`
  const row = document.querySelector("button[data-session-id=${JSON.stringify(saved.sessionId)}]");
  return row ? (row.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? "no-state") : "no-row";
`);
report.sessionRowState = rowState;
if (rowState === "no-row") fail("会话行不在列表里");
if (rowState === "no-state") {
  fail("会话行没有状态点：恢复回来的标签是个空壳，会话没有被重新打开");
}

// 4. No live screen is stuck on the resume command itself: the session took the terminal
// over rather than the command staying painted on a shell.
const screen = await cdp.evaluate(`${MODULES}
  const d = sessions.ghosttySessionDiagnostics();
  return JSON.stringify(d.map((x) => ({ leaf: x.leafId, tail: (api.leafScreenTail(x.leafId) ?? "").slice(-200) })));
`);
report.screens = JSON.parse(screen);
if (report.screens.some((s) => s.tail.includes("--session"))) {
  fail("有终端屏幕上还是 resume 命令本身，会话没有接管那个终端");
}
if (!report.screens.some((s) => s.tail.trim().length > 0)) {
  fail("没有任何终端的屏幕有内容，恢复后的会话没跑起来");
}

// 5. Tidy up: close the two tabs this probe made and delete the throwaway session, so a
// run leaves the window (and the session list) as it found them.
const needles = [basename(scratch), saved.sessionTitle ?? ""].filter(Boolean);
const closedTabs = await cdp.evaluate(`
  ${PRESS_FN}
  const needles = ${JSON.stringify(needles)};
  const chips = [...document.querySelectorAll("[data-tab-id]")].filter((el) =>
    needles.some((n) => (el.textContent || "").includes(n)));
  const opts = { bubbles: true, cancelable: true, button: 1, buttons: 4, isPrimary: false, pointerId: 1, pointerType: "mouse" };
  for (const chip of chips) chip.dispatchEvent(new MouseEvent("auxclick", opts));
  return chips.map((chip) => (chip.textContent || "").trim());
`);
report.closedTabs = closedTabs;
report.deletedSession = await cdp.evaluate(`
  const invoke = window.__TAURI_INTERNALS__.invoke;
  return invoke("agent_sessions_delete", { targets: [{ tool: "pi", id: ${JSON.stringify(saved.sessionId)}, distro: null }] })
    .then((r) => JSON.stringify(r))
    .catch((e) => "error: " + String(e));
`);

// Leave the switch off, so the next launch is the cold one the default promises; `--stage=check-off`
// looks at that launch and puts the original value back.
report.switchNow = await setSwitch(cdp, false);

cdp.socket.close();
console.log(JSON.stringify(report, null, 2));
console.log(
  "PASS: 关闭前的标签回来了，会话标签点开时真的把会话重新打开了（行上有状态点，屏幕是 agent 的）。dev 也跟着退了：重新 `pnpm tauri dev`，起来后跑 --stage=check-off。",
);
process.exit(0);

// --- stage: check-off ----------------------------------------------------------------------------

if (stage === "check-off") {
  // A launch with the switch off: the saved list stays on disk unused, and the window is the one
  // cold terminal the default promises. What was found is put back at the end.
  await sleep(9000);
  const cdp = await connect((await mainPage()).webSocketDebuggerUrl);
  await requireDevModules(cdp);

  const titles = await cdp.evaluate(`
    return [...document.querySelectorAll("[data-tab-id]")].map((el) => (el.textContent || "").trim());
  `);
  report.tabsOnScreen = titles;
  if (titles.length !== 1) {
    fail(`默认关的启动应有 1 个标签，屏幕上有 ${titles.length} 个：${JSON.stringify(titles)}`);
  }
  const saved = readTabsFile();
  report.savedList = { tabs: saved?.tabs?.length ?? 0 };
  if ((saved?.tabs?.length ?? 0) === 0) {
    console.log("  （盘上没有存过的列表，本来就是空冷启动）");
  }

  report.switchBack = await setSwitch(cdp, originalSwitchOn);
  cdp.socket.close();
  console.log(JSON.stringify(report, null, 2));
  console.log(
    "PASS: 默认关的启动只有一个冷终端，存过的列表没有被拿回来；开关已放回运行前的值。",
  );
  process.exit(0);
}
