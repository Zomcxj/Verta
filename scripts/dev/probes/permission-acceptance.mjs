// End-to-end acceptance for the permission gate.
//
// Two parts: the backend command queries three repositories with real gh (my own ADMIN, someone else's READ,
// a non-existent one); the UI checks whether permission actually reaches the buttons (writable means the
// write buttons are there, read-only means they vanish and a hint appears).
//
// The read-only part has to be run separately: every repository `gh repo list` reports on this machine is my
// own ADMIN, so the UI has no genuinely read-only row; and in the page `window.__TAURI_INTERNALS__.invoke` is
// non-writable / non-configurable, so it cannot be stubbed. A controlled experiment stands in instead:
// temporarily pin the result inside `read_repo_permission` to `can_write = false` (one line; tauri dev
// recompiles and restarts by itself), then run:
//
//   node scripts/dev/probes/permission-acceptance.mjs --readonly
//
// Restore that line afterwards. Everything still goes through the real path: gh → payload → frontend pure
// functions → dialog rendering.
//
// Usage: node scripts/dev/probes/permission-acceptance.mjs [--readonly] [--port=9222]
import { mkdirSync, writeFileSync } from "node:fs";

const EXPECT_READ_ONLY = process.argv.includes("--readonly");
const port =
  process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const REPO = "Zomcxj/ModelHarbor";
/** Someone else's public repository: viewerPermission is READ. */
const READ_ONLY_REPO = "facebook/react";
const SHOTS = ".superpowers/shots";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没找到 page 目标；dev 起了吗？");
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "页面内异常",
    );
  }
  return result.result.value;
};

const waitFor = async (expression, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evaluate(`(() => {
      const node = ${expression};
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (found) return found;
    await sleep(250);
  }
  return null;
};

const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  // `buttons` is required: without it WebView2 never synthesizes a real click.
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(60);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(`${SHOTS}/${name}`, Buffer.from(data, "base64"));
};

/** Read the button labels in the dialog, to tell whether the write buttons are there. */
const modalButtons = () =>
  evaluate(`JSON.stringify(
    [...document.querySelectorAll('[role="dialog"] button')]
      .map((b) => (b.innerText || "").trim())
      .filter(Boolean)
  )`).then((text) => JSON.parse(text));

const WRITE_LABELS = /^(重跑|取消|删除|Rerun|Cancel|Delete)$/;

try {
  // ---- 0. Wait for first paint (under dev, IPC falls back to postMessage first, so startup is slow) ----
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");

  // A previous failed run may have left dialogs on screen; press Esc twice first so the real clicks below do not land on an overlay.
  for (let i = 0; i < 2; i++) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
    await sleep(400);
  }
  const leftover = await evaluate(
    `document.querySelectorAll('[role="dialog"]').length`,
  );
  if (leftover > 0) fail(`起始状态还有 ${leftover} 个弹窗没收掉`);

  // ---- 1. Backend command: query three kinds of repository with real gh ----
  const probe = await evaluate(`(async () => {
    const invoke = (repo) => window.__TAURI_INTERNALS__.invoke("github_repo_permission", { repo });
    const [mine, others, missing] = await Promise.all([
      invoke(${JSON.stringify(REPO)}),
      invoke(${JSON.stringify(READ_ONLY_REPO)}),
      invoke("no-such-owner-xyz/nope"),
    ]);
    return JSON.stringify({ mine, others, missing });
  })()`);
  const { mine, others, missing } = JSON.parse(probe);
  report.backend = { mine, others, missing };

  if (EXPECT_READ_ONLY) {
    // The backend is pinned to "not writable" for this pass, so the UI must offer no write button at all.
    if (mine.kind !== "ready" || mine.canWrite)
      fail(`--readonly 这轮后端应该是不可写：${JSON.stringify(mine)}`);
  } else {
    if (mine.kind !== "ready" || mine.permission !== "ADMIN" || !mine.canWrite)
      fail(`自己的仓库权限不对：${JSON.stringify(mine)}`);
  }
  if (others.kind !== "ready" || others.permission !== "READ" || others.canWrite)
    fail(`只读仓库应该拿到 READ 且不给写：${JSON.stringify(others)}`);
  if (missing.canWrite !== true)
    fail(`查不动的仓库应该按「有权限」算：${JSON.stringify(missing)}`);
  if (missing.kind === "ready") fail(`不存在的仓库不该是 ready：${JSON.stringify(missing)}`);
  if (!missing.error) fail("查不动时应该带上 gh 的原话");

  // ---- 2. UI: open the run history and check the write buttons ----
  const remotesButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /远程仓库|Remote repositories/.test(b.getAttribute("title") || ""))`,
  );
  if (!remotesButton) fail("页头里没有远程仓库入口");
  await realClick(remotesButton.x, remotesButton.y);
  const filterBox = await waitFor(
    `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`,
  );
  if (!filterBox) fail("远程仓库列表没有出现");

  const openRuns = async () => {
    await evaluate(`(() => {
      const input = [...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "ModelHarbor");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    const rowMenu = await waitFor(
      `[...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").match(/更多操作|More actions/))`,
      15000,
    );
    if (!rowMenu) fail("筛选后没有仓库行（或行菜单按钮）");
    await realClick(rowMenu.x, rowMenu.y);
    const runsItem = await waitFor(
      `[...document.querySelectorAll('[role="menuitem"]')].find((n) => /运行记录|Run history|Runs/.test(n.innerText || ""))`,
      15000,
    );
    if (!runsItem) fail("行菜单里没有「运行记录…」");
    await realClick(runsItem.x, runsItem.y);
    // Wait until the table really has a run row (the details button every row carries).
    const row = await waitFor(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /^(详情|Details)$/.test((b.innerText || "").trim()))`,
      40000,
    );
    if (!row) fail("运行列表里没有出现运行行");
  };

  await openRuns();
  if (EXPECT_READ_ONLY) {
    // This part runs with gh swapped for a "read-only" forwarding shim.
    const buttons = await modalButtons();
    report.readOnly = buttons.slice(0, 12);
    if (buttons.some((label) => WRITE_LABELS.test(label)))
      fail(`只读仓库不该有写按钮：${JSON.stringify(buttons.slice(0, 24))}`);
    if (!buttons.some((label) => /^(详情|Details)$/.test(label)))
      fail(`只读仓库也得能看详情：${JSON.stringify(buttons.slice(0, 24))}`);
    const hintShown = await evaluate(
      `document.body.innerText.includes("没有这个仓库的写权限")`,
    );
    if (!hintShown) fail("只读仓库应该有一句提示");
    report.readOnlyHint = hintShown;
    await shot("permission-readonly.png");
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
    socket.close();
    process.exit(0);
  }

  const writableButtons = await modalButtons();
  report.writable = writableButtons.slice(0, 12);
  if (!writableButtons.some((label) => WRITE_LABELS.test(label)))
    fail(`有写权限时该有重跑/删除按钮：${JSON.stringify(writableButtons)}`);
  const hintWhenWritable = await evaluate(
    `document.body.innerText.includes("没有这个仓库的写权限")`,
  );
  if (hintWhenWritable) fail("有写权限时不该出只读提示");
  await shot("permission-writable.png");

  report.readOnlyUi =
    "Run --readonly separately: temporarily pin backend can_write to false and verify the UI offers no write buttons";
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket.close();
}
