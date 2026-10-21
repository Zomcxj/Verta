// 权限门禁的真机验收。
//
// 两段：后端命令拿真 gh 查三种仓库（自己的 ADMIN、别人的 READ、不存在的仓库），
// 界面看权限落不落到按钮上（有写权限时按钮在、只读时按钮消失并出提示）。
//
// 只读那一段要单独跑一次：本机 `gh repo list` 列出来的仓库全是自己的 ADMIN，界面上拿不到一个
// 真的只读行；页面里的 `window.__TAURI_INTERNALS__.invoke` 又是 non-writable / non-configurable，
// 桩也打不进去。所以用一个可控实验顶替：临时把 `read_repo_permission` 里的结论钉成
// `can_write = false`（改一行，tauri dev 自己重编重启），跑：
//
//   node scripts/dev/probes/permission-acceptance.mjs --readonly
//
// 验完把那行还原。这样 go 的仍是真实链路：gh → payload → 前端纯函数 → 弹窗渲染。
//
// 用法：node scripts/dev/probes/permission-acceptance.mjs [--readonly] [--port=9222]
import { mkdirSync, writeFileSync } from "node:fs";

const EXPECT_READ_ONLY = process.argv.includes("--readonly");
const port =
  process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const REPO = "Zomcxj/ModelHarbor";
/** 别人的公开仓库：viewerPermission 是 READ。 */
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
  // `buttons` 不能省：WebView2 少了它就不合成真正的 click。
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

/** 把弹窗里的按钮文字读出来，用来判断写按钮在不在。 */
const modalButtons = () =>
  evaluate(`JSON.stringify(
    [...document.querySelectorAll('[role="dialog"] button')]
      .map((b) => (b.innerText || "").trim())
      .filter(Boolean)
  )`).then((text) => JSON.parse(text));

const WRITE_LABELS = /^(重跑|取消|删除|Rerun|Cancel|Delete)$/;

try {
  // ---- 0. 等首屏（dev 下 IPC 先走 postMessage 回退，启动很慢） ----
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");

  // 上一轮失败可能把弹窗留在屏幕上；先按两次 Esc 清干净，免得后面的真实点击全落在遮罩上。
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

  // ---- 1. 后端命令：真 gh 查三种仓库 ----
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
    // 这一轮后端被临时钉成「不可写」，界面就该一个写按钮都不给。
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

  // ---- 2. 界面：打开运行记录，看写按钮在不在 ----
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
    // 等到表格里真有运行行（详情按钮是每行都有的那个）。
    const row = await waitFor(
      `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /^(详情|Details)$/.test((b.innerText || "").trim()))`,
      40000,
    );
    if (!row) fail("运行列表里没有出现运行行");
  };

  await openRuns();
  if (EXPECT_READ_ONLY) {
    // gh 被换成「只读」转发脚本时跑这一段。
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
    "另跑一次 --readonly：临时把后端 can_write 钉成 false，验界面不给写按钮";
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket.close();
}
