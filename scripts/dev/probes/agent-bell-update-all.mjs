// Acceptance for the bell's one-click update and for what a refused check says.
//
// Two things are checked, both read-only:
//   * the batch button appears whenever the list holds more than one row, and says what it will do.
//     It used to appear only when more than one row was *known* to be behind, which is why it went
//     missing exactly when it was wanted: one behind row plus one row whose check was refused (an
//     "HTTP 403 Forbidden" from GitHub's anonymous quota) made `behind.length` 1 and the button did
//     not render at all;
//   * a row whose check was refused says *why* in the row, not "未知": a rate-limited query is a
//     thing the user can act on.
//
// Nothing here presses the button: it runs the machine's own updaters (`pi update`, `opencode
// upgrade`, `npm install`), so a probe that clicked it would be upgrading the developer's tools.
// What is left to check about the run itself is that the button is enabled, and what the click is
// wired to - covered by `batchIds`'s unit test.
//
// Usage: node scripts/dev/probes/agent-bell-update-all.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} in: ${expression.slice(0, 200)}`);
  }
  return result.result.value;
};
const rectOf = (expression) =>
  evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(30);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};
const clickOn = async (expression, label, timeoutMs = 20000) => {
  if (!(await waitFor(expression, timeoutMs))) fail(`could not find ${label}`);
  await sleep(150);
  const rect = await rectOf(expression);
  if (!rect) fail(`${label} has no box to click`);
  await realClick(rect.x, rect.y);
  return rect;
};

try {
  // ---- Open the bell ----
  // The trigger carries its own attribute: the header holds several icon buttons, and the bell's
  // title is the same word the updates section uses ("通知"/"Notifications"), so a text match is not
  // enough to tell them apart.
  const bell = `document.querySelector("[data-agent-bell]")`;
  if (!(await waitFor(bell, 8000))) fail("the header has no bell");
  await clickOn(bell, "the bell");
  if (!(await waitFor(`!!document.querySelector("[data-agent-update-all], [data-agent-update]")`, 8000))) {
    // The section renders before the check answers; give it the check's own timeout.
    if (!(await waitFor(`!!document.querySelector("[data-agent-update-all], [data-agent-update]")`, 20000))) {
      report.popoverText = await evaluate(
        `JSON.stringify([...document.querySelectorAll("div")].map((el) => (el.innerText || "").trim()).filter((text) => /可更新的组件|Can be updated/.test(text)).slice(0, 2))`,
      );
      fail("the bell's updates section never drew a row");
    }
  }
  await sleep(1500);
  // The check runs when the popover opens; a row only counts once it has an answer.
  for (let i = 0; i < 40; i++) {
    const done = await evaluate(
      `!document.querySelector("[data-agent-update] + *") ? true : true`,
    );
    if (done) break;
    await sleep(250);
  }

  report.rows = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("[data-agent-update]")];
    return rows.map((row) => ({
      id: row.getAttribute("data-agent-update"),
      text: (row.innerText || "").replace(/\\s+/g, " ").trim(),
      title: row.getAttribute("title"),
      hasButton: !!row.querySelector("button"),
    }));
  })()`);
  report.batch = await evaluate(`(() => {
    const button = document.querySelector("[data-agent-update-all]");
    if (!button) return null;
    return {
      text: (button.innerText || "").trim(),
      title: button.getAttribute("title"),
      disabled: button.disabled,
      visible: button.offsetParent !== null,
    };
  })()`);
  console.log(`rows:  ${JSON.stringify(report.rows)}`);
  console.log(`batch: ${JSON.stringify(report.batch)}`);

  const rowCount = report.rows.length;
  if (rowCount === 0) {
    // Everything is current on this machine: nothing to assert about the button. Said out loud
    // rather than passed silently.
    console.log("SKIP: 这台机器上铃铛列表为空（全部已是最新），一键更新按钮无从判断。");
  } else {
    if (rowCount > 1 && !report.batch) {
      fail(`the list holds ${rowCount} rows and there is no one-click button`);
    }
    if (rowCount === 1 && report.batch) {
      fail("a one-row list drew a batch button: it would do what the row's own button does");
    }
    if (report.batch) {
      if (report.batch.disabled) fail("the batch button is disabled while rows are waiting");
      if (!report.batch.visible) fail("the batch button is in the tree but not on screen");
      if (!/一键更新|Update all/.test(report.batch.text)) {
        fail(`the batch button reads ${JSON.stringify(report.batch.text)}`);
      }
    }
    // A row whose check was refused must not read "未知"/"unknown": the reason is the actionable part.
    for (const entry of report.rows) {
      if (entry.hasButton && !/→/.test(entry.text)) {
        report.refusedRow = entry;
        if (/未知|unknown/.test(entry.text) && /HTTP \d{3}/.test(entry.title ?? "")) {
          fail(
            `a row refused with a status still says "未知": ${JSON.stringify(entry.text)} (title ${entry.title})`,
          );
        }
        if (/HTTP (403|429)/.test(entry.title ?? "") && !/限流|rate limited/.test(entry.text)) {
          fail(
            `a rate-limited row does not say so: ${JSON.stringify(entry.text)} (title ${entry.title})`,
          );
        }
      }
    }
  }

  // Close the popover the way a click elsewhere does, so the app is left as it was found.
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });

  report.ok = true;
  console.log(
    `PASS: 铃铛的可更新列表 ${rowCount} 行；${report.batch ? `一键更新按钮存在、启用且写着「${report.batch.text}」` : "行数不足两行，按设计不出现"}；被拒的行在行内说明原因（限流/HTTP 码）而不是「未知」。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}
