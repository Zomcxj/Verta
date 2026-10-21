// 登录态面板的真机验收。
//
// 两轮，因为「已登录」和「没登录」是两份完全不同的界面：
//
//   1. 默认这轮（应用照常跑，用你真实的 gh 登录态）：账号面板把账号 / 主机 / 令牌来源 /
//      协议 / 已授权 scopes 都列出来；登出只验到确认框为止（**不真的登出**，那会把你的账号
//      从 gh 里摘掉）。
//   2. `--isolated` 那轮：控制台那边另起一个 dev，`GH_CONFIG_DIR` 指到临时目录，
//      于是 gh 认为「这台机器没登录」，而**你真实的登录态一点不受影响**。这一轮验：
//      没登录时的提示、浏览器授权（真去 GitHub 要一次性码、显示出来、然后中止）、
//      以及粘贴一个假 token 被 gh 拒掉时错误有没有如实显示。
//      注意：假 token 这步绝不能落在真实配置上，所以必须跑在 --isolated 这轮里。
//
// 用法：node scripts/dev/probes/auth-acceptance.mjs [--isolated] [--port=9222]
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";

const ISOLATED = process.argv.includes("--isolated");
const port =
  process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const SHOTS = ".superpowers/shots";
/** 一个格式合法、但 GitHub 一定不认的 token（只在 --isolated 那轮用）。 */
const BOGUS_TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

mkdirSync(SHOTS, { recursive: true });

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

const rectOf = (expression) =>
  evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 60) };
  })()`);

const waitFor = async (expression, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await rectOf(expression);
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
  writeFileSync(`${SHOTS}/${name}`, Buffer.from(data, "base64"));
};

const ANY_BUTTON = '[role="dialog"] button, [role="alertdialog"] button';
const modalButton = (label, selector = ANY_BUTTON) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => (b.innerText || "").trim() === ${JSON.stringify(label)})`;

const clickButton = async (label, selector) => {
  const rect = await waitFor(modalButton(label, selector), 15000);
  if (!rect) return false;
  await realClick(rect.x, rect.y);
  return true;
};

const dialogText = () =>
  evaluate(
    `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => d.innerText).join("\\n=== \\n")`,
  );

const authDialogOpen = () =>
  `[...document.querySelectorAll('[role="dialog"]')].find((d) => /GitHub 账号/.test(d.innerText || ""))`;

const pressEscape = async () => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(300);
};

const fillInput = (index, value) =>
  evaluate(`(() => {
    const input = [...document.querySelectorAll('[role="dialog"] input')][${index}];
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

/** 打开账号面板：远程仓库标签页 → 页头那个账号按钮。 */
const openAuthPanel = async () => {
  const remotesButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /远程仓库|Remote repositories/.test(b.getAttribute("title") || ""))`,
  );
  if (!remotesButton) fail("页头里没有远程仓库入口");
  await realClick(remotesButton.x, remotesButton.y);
  const accountButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /账号与登录/.test(b.getAttribute("title") || ""))`,
    30000,
  );
  if (!accountButton) fail("页头里没有账号入口");
  await realClick(accountButton.x, accountButton.y);
  const dialog = await waitFor(authDialogOpen(), 30000);
  if (!dialog) fail("账号面板没打开");
  // 打开时先写「正在读取登录态…」，等它读完（gh 要起一次进程）。
  const read = await (async () => {
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const text = await dialogText();
      if (!/正在读取登录态/.test(text)) return true;
      await sleep(400);
    }
    return false;
  })();
  if (!read) fail("登录态一直读不出来");
};

try {
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");
  for (let attempt = 0; attempt < 4; attempt++) {
    const open = await evaluate(
      `document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`,
    );
    if (open === 0) break;
    await pressEscape();
    await evaluate(`(() => {
      const close = document.querySelector('[role="dialog"] [data-slot="dialog-close"]');
      if (close) close.click();
      return true;
    })()`);
    await sleep(500);
  }

  await openAuthPanel();
  const text = await dialogText();
  report.panelText = text.slice(0, 400);

  if (ISOLATED) {
    // ---- 没登录那轮 ----
    if (!/这台机器还没登录 GitHub/.test(text))
      fail(`没登录时该给出提示：${text.slice(0, 200)}`);
    // 「令牌来源 / 已授权」这些只在登着的时候画，没登录时不该有。
    if (/令牌来源|已授权/.test(text)) fail(`没登录时不该列出账号信息：${text.slice(0, 200)}`);
    report.notLoggedInHint = true;
    await shot("auth-not-logged-in.png");

    // 浏览器授权：真去 GitHub 要一次性码，显示出来，然后中止。
    if (!(await clickButton("用浏览器授权"))) fail("没有「用浏览器授权」按钮");
    const streaming = await (async () => {
      const deadline = Date.now() + 90000;
      let last = "";
      while (Date.now() < deadline) {
        const texts = JSON.parse(
          await evaluate(
            `JSON.stringify([...document.querySelectorAll('[role="dialog"] pre')].map((n) => n.innerText))`,
          ),
        );
        last = texts.join("\n");
        // 输出框一开始是占位文案，等到真有一次性码为止。
        if (/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(last)) return last;
        await sleep(500);
      }
      return last;
    })();
    report.webStream = streaming.slice(0, 400);
    if (!streaming.trim()) fail("浏览器授权没有任何输出流出来");
    // GitHub 的一次性码形如 XXXX-XXXX。
    if (!/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(streaming))
      fail(`流出来的内容里没有一次性码：${streaming.slice(0, 200)}`);
    await shot("auth-web-login.png");
    if (!(await clickButton("中止"))) fail("浏览器授权进行中没有「中止」按钮");
    await sleep(1500);
    const afterCancel = await dialogText();
    report.afterCancel = afterCancel.slice(0, 200);

    // 粘贴假 token：本地拦太短，够长了交给 gh，gh 拒掉要如实显示。
    if (!(await fillInput(0, "ghp_short"))) fail("找不到 token 输入框");
    await sleep(300);
    const shortDisabled = await evaluate(
      `(() => { const b = ${modalButton("用 token 登录")}; return b ? b.disabled : null; })()`,
    );
    report.shortTokenDisabled = shortDisabled;
    if (shortDisabled !== true) fail("token 太短时按钮应该不可点");

    if (!(await fillInput(0, BOGUS_TOKEN))) fail("找不到 token 输入框");
    await sleep(300);
    if (!(await clickButton("用 token 登录"))) fail("没有「用 token 登录」按钮");
    const rejected = await (async () => {
      // 这台机器上 gh 验 token 要打一次 GitHub API，慢的时候一分钟往上，给宽一点。
      const deadline = Date.now() + 150000;
      let last = "";
      while (Date.now() < deadline) {
        last = await dialogText();
        if (/没接受这个 token/.test(last)) return last;
        await sleep(1000);
      }
      return last;
    })();
    report.tokenRejected = rejected.slice(-320);
    if (!/没接受这个 token/.test(rejected))
      fail(`假 token 被拒时没有如实显示：${rejected.slice(-200)}`);
    await shot("auth-token-rejected.png");
    // 输入框提交完要清掉：应用里不留这串东西。
    const cleared = await evaluate(
      `(() => { const i = [...document.querySelectorAll('[role="dialog"] input')][0]; return i ? i.value : null; })()`,
    );
    report.tokenInputAfterSubmit = cleared;
    if (cleared !== "") fail("提交之后 token 输入框没有清空");

    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // ---- 已登录那轮 ----
  if (/这台机器还没登录 GitHub|没装 gh CLI/.test(text))
    fail(`这台机器应该已经登录：${text.slice(0, 200)}`);
  if (!/账号/.test(text) || !/令牌来源/.test(text) || !/已授权/.test(text))
    fail(`面板没有列出账号信息：${text.slice(0, 200)}`);
  const scopes = JSON.parse(
    await evaluate(`JSON.stringify(
      [...document.querySelectorAll('[role="dialog"] span')]
        .map((n) => (n.innerText || "").trim())
        .filter((t) => /^[a-z_:]+$/.test(t))
    )`),
  );
  report.scopes = scopes;
  if (!scopes.includes("repo")) fail(`scopes 里没有 repo：${JSON.stringify(scopes)}`);
  // 这台机器的 token 有 delete_repo，所以不该出「缺授权」那条提示。
  const missingScopeHint = /缺 delete_repo 授权/.test(text);
  report.missingScopeHint = missingScopeHint;
  if (missingScopeHint) fail("这个账号有 delete_repo，不该提示缺授权");
  // token 本身永远不该出现在界面上。
  if (/ghp_[A-Za-z0-9]/.test(text) || /github_pat_/.test(text))
    fail("面板上出现了 token 本身");
  await shot("auth-logged-in.png");

  // 登出：只验确认框里的后果说明，不真的点确认（那会把账号从 gh 里摘掉）。
  if (!(await clickButton("登出"))) fail("没有「登出」按钮");
  const confirm = await waitFor(
    `[...document.querySelectorAll('[role="alertdialog"]')].find((d) => /登出/.test(d.innerText || ""))`,
    15000,
  );
  if (!confirm) fail("登出的确认框没出现");
  const confirmText = await dialogText();
  report.logoutConfirm = confirmText.slice(0, 300);
  if (!/钥匙串|重新登录/.test(confirmText))
    fail(`登出确认框没说清后果：${confirmText.slice(0, 200)}`);
  await shot("auth-logout-confirm.png");
  // 取消掉，别真登出。
  if (!(await clickButton("取消"))) fail("确认框里没有「取消」");
  await sleep(800);
  report.logoutCancelled = true;

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket.close();
}
