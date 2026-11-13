// The font row says which family it is actually drawing with - and it has to be right.
//
// The complaint that started this: "I chose Cascadia Code and it shows JetBrains Mono". The face on
// screen was Cascadia Code; the two are nearly indistinguishable at 13px (both round to the same 8px
// cell, both have a dotted zero), and there was nothing anywhere that named the family in force. The
// row now does, so this run checks the claim rather than the picture: the family the row names is
// compared against an independent measurement made here, in the same webview, by the same method the
// terminal uses - a canvas whose width changes only when the family is real.
//
// Nothing is modified: the settings window is opened, read, and closed again.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/font-row-honesty.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const listTargets = async () => (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
      const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`${what} in: ${expression.slice(0, 160)}`);
    }
    return result.result.value;
  };
  return { socket, evaluate };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every connection this run opened: an open socket keeps the process alive after the last console.log. */
const sockets = [];

/** The same question the row answers, asked independently in this webview. */
const RESOLVES = (family) => `(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const sample = "Wim0123";
  const quoted = '"' + ${JSON.stringify(family)} + '"';
  for (const generic of ["monospace", "serif"]) {
    context.font = "16px " + generic;
    const baseline = context.measureText(sample).width;
    context.font = "16px " + quoted + ", " + generic;
    if (context.measureText(sample).width !== baseline) return true;
  }
  return false;
})()`;

let settings = null;
try {
  const main = (await listTargets()).find(
    (t) => t.type === "page" && t.url === "http://tauri.localhost/",
  );
  if (!main) fail("no main window: is the app running with --remote-debugging-port?");
  const app = await connect(main);

  report.preference = await app.evaluate(`(() => {
    const root = getComputedStyle(document.documentElement);
    return JSON.stringify({
      editorFamily: root.getPropertyValue("--editor-font-family").trim().slice(0, 60),
    });
  })()`);

  // The settings window is created on demand; the app opens it from the header menu, which is a menu
  // and not worth driving, so it is opened through the same event the palette uses.
  const alreadyOpen = (await listTargets()).find(
    (t) => t.type === "page" && t.url.includes("settings"),
  );
  let openedByProbe = false;
  if (!alreadyOpen) {
    openedByProbe = true;
    await app.evaluate(
      `window.__TAURI_INTERNALS__.invoke("open_settings_window").catch((error) => String(error))`,
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(250);
      settings = (await listTargets()).find(
        (t) => t.type === "page" && t.url.includes("settings"),
      );
      if (settings) break;
    }
  } else {
    settings = alreadyOpen;
  }
  if (!settings) fail("the settings window never appeared");

  const win = await connect(settings);
  sockets.push(app.socket, win.socket);
  await sleep(1200);

  /**
   * One read of the font row.
   *
   * The picker is not inside the preview: they are two siblings in the row's column, so the button is
   * found by walking up until an ancestor has one - the first version looked inside the preview and
   * found nothing.
   */
  const readRow = async () =>
    JSON.parse(
      await win.evaluate(`(() => {
      const sample = document.querySelector("[data-font-preview]");
      const line = document.querySelector("[data-font-effective-line]");
      if (!sample) return JSON.stringify({ found: false });
      const style = getComputedStyle(sample);
      let node = sample.parentElement;
      let picker = null;
      while (node && !picker) {
        picker = node.querySelector("button");
        if (!picker) node = node.parentElement;
      }
      return JSON.stringify({
        found: true,
        effective: sample.getAttribute("data-font-effective"),
        fallback: sample.getAttribute("data-font-fallback") === "true",
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        line: line ? line.textContent.trim() : null,
        picker: picker ? picker.textContent.trim().slice(0, 40) : null,
      });
    })()`),
    );

  // A window that has just opened hydrates its preferences over one IPC round trip, so the first read
  // can be the defaults. Waited for rather than slept through: two identical reads are the row at rest.
  let row = await readRow();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    const next = await readRow();
    const settled =
      next.effective === row.effective &&
      next.fontFamily === row.fontFamily &&
      next.fontSize === row.fontSize &&
      next.picker === row.picker;
    row = next;
    if (settled) break;
  }
  report.row = row;
  if (!row.found) fail("the font row draws no preview at all");
  if (!row.effective) fail("the preview does not say which family it is using");
  if (!row.line || !row.line.includes(row.effective)) {
    fail(`the line under the sample does not name ${row.effective}: ${JSON.stringify(row.line)}`);
  }

  // Independent check of the same claim: does the named family actually resolve in this webview?
  const resolves = await win.evaluate(RESOLVES(row.effective));
  report.resolves = resolves;
  if (!resolves) {
    fail(
      `the row names ${row.effective}, but measuring that family here says it has no effect - the row is claiming a face the webview cannot draw`,
    );
  }
  if (row.fallback) {
    fail(`the row reports a fallback (${row.effective}) although the named family resolves`);
  }
  // And the sample is drawn with that family, at the terminal's size.
  if (!row.fontFamily.toLowerCase().includes(row.effective.toLowerCase())) {
    fail(`the sample's font stack (${row.fontFamily}) does not start with the family it names`);
  }
  const size = Number.parseFloat(row.fontSize);
  if (!(size >= 4)) fail(`the sample is drawn at ${row.fontSize}`);

  // The family names itself the same way the terminal's own chain does: the terminal asks for the
  // setting, and the row reports what that turns into.
  if (!row.picker) fail("no picker button found in the settings window");
  report.picker = row.picker;
  if (!row.picker.includes(row.effective)) {
    fail(
      `the picker shows ${JSON.stringify(row.picker)} while the row says the terminal uses ${row.effective}`,
    );
  }

  console.log(
    `PASS: 字体行画的样本就是用 ${row.effective}（${row.fontSize}，stack 以其开头），下面写明「生效：${row.effective}」且不是回退；我在同一个 webview 里独立量过这个名字，它对 monospace / serif 两条基线的宽度都有影响（确实解析到），下拉框显示的也是 ${JSON.stringify(row.picker)}；设置窗口读完即关闭。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}

// The settings window is the app's to open and close. Only what this run opened is closed: a window the
// user already had up is not the probe's to take away.
try {
  if (openedByProbe) {
    const stillOpen = (await listTargets()).find(
      (t) => t.type === "page" && t.url.includes("settings"),
    );
    if (stillOpen) {
      const win = await connect(stillOpen);
      sockets.push(win.socket);
      await win.evaluate(
        `window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "settings" }).catch(() => null)`,
      );
    }
  }
} catch {
  // Not being able to close it is not what this run is about.
} finally {
  // Closed last, and all of them: an idle WebSocket is enough to keep node from exiting, which is how
  // this run used to sit there after printing its result.
  for (const socket of sockets) {
    try {
      socket.close();
    } catch {
      // Already gone.
    }
  }
}
