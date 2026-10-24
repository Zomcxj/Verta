// End-to-end acceptance for editing a repo description straight from the list: open the projects
// panel, switch to the remote list, filter to the target repo, click its description cell, type a
// new text, save, and check the toast and the re-read row. The GitHub side (what was really stored,
// and the restore) is checked with gh outside this script.
//
// Usage: node scripts/dev/probes/description-edit-acceptance.mjs [--port=9222] [--repo=Zomcxj/Verta]
//        [--text=SCRATCH description]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback;

const REPO = arg("repo", "Zomcxj/Verta");
const NEW_TEXT = arg("text", "SCRATCH description from the list");

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

const rectOf = (expression) =>
  evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 100) };
  })()`);

/** A real mouse click: WebView2 only fires React onClick for synthesized input carrying `buttons`. */
const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
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

const waitFor = async (expression, timeoutMs = 40000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rect = await rectOf(expression);
    if (rect) return rect;
    await sleep(250);
  }
  return null;
};

/**
 * Click something for real. The element is measured again after a pause: a dialog animates
 * in, and a rect taken during that animation is where the button used to be.
 */
const clickOn = async (expression, label, timeoutMs = 40000) => {
  const found = await waitFor(expression, timeoutMs);
  if (!found) fail(`${label} 没找到`);
  await sleep(350);
  const settled = (await rectOf(expression)) ?? found;
  await realClick(settled.x, settled.y);
  return settled;
};

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
};

/** React tracks the value on the DOM node, so a plain `node.value = x` is ignored. */
const setValue = async (selectorExpression, value) =>
  evaluate(`(() => {
    const node = ${selectorExpression};
    if (!node) return false;
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

const filterBoxExpr = `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`;
const rowExpr = (selector) => `(() => {
  const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(REPO)}));
  if (!row) return null;
  return ${selector};
})()`;
const dialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => (d.innerText || "").includes(${JSON.stringify(REPO)}))`;
const buttonInDialog = (pattern) =>
  `[...(${dialog}?.querySelectorAll("button") ?? [])].find((b) => ${pattern}.test((b.innerText || "").trim()))`;

try {
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");

  // A previous run may have left a dialog open; start from a clean slate.
  for (let i = 0; i < 3; i += 1) {
    await pressEscape();
    await sleep(200);
  }

  // ---- 1. The projects panel, on the remote list ----
  await clickOn(
    `[...document.querySelectorAll("button")].find((b) => /本地项目与远程仓库|Local projects/.test(b.getAttribute("title") || ""))`,
    "页头的项目面板入口",
  );
  await clickOn(
    `[...document.querySelectorAll("[data-sub-value]")].find((el) => el.getAttribute("data-sub-value") === "remotes")`,
    "面板里的远程仓库切换项",
    20000,
  );
  const filterBox = await waitFor(filterBoxExpr);
  if (!filterBox) fail("远程仓库列表没有出现");
  report.remotesOpened = true;

  // ---- 2. Narrow to the target repo ----
  await setValue(filterBoxExpr, REPO);
  await sleep(600);

  report.cellBefore = (
    await clickOn(
      rowExpr(
        `[...row.querySelectorAll("button")].find((b) => /改说明|加说明|Edit description|Add description/.test(b.getAttribute("title") || "")) ?? null`,
      ),
      `${REPO} 那一行的说明单元格`,
      15000,
    )
  ).text;

  // ---- 3. The dialog opens filled in with the stored text ----
  const textareaExpr = `${dialog}?.querySelector("textarea")`;
  const textarea = await waitFor(textareaExpr, 10000);
  if (!textarea) fail("说明弹窗没有出现");
  report.seeded = await evaluate(
    `(() => { const node = ${textareaExpr}; return node ? node.value : null; })()`,
  );
  report.dialogTitle = (
    await waitFor(`${dialog}?.querySelector("h2")`, 5000)
  )?.text;

  // ---- 4. Type the new text and save ----
  await setValue(textareaExpr, NEW_TEXT);
  report.saveButton = (
    await clickOn(buttonInDialog("/^(保存描述|Save description)$/"), "保存按钮", 10000)
  ).text;

  const toast = await waitFor(
    `[...document.querySelectorAll("[data-sonner-toast]")].find((n) => /描述已更新|Description updated/.test(n.innerText || ""))`,
    30000,
  );
  if (!toast) fail("没有出现保存成功的提示");
  report.toast = toast.text;

  await sleep(700);
  report.dialogClosed = await evaluate(`${dialog} === undefined`);
  report.cellAfter = await evaluate(
    `(() => {
      const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(REPO)}));
      const button = row ? [...row.querySelectorAll("button")].find((b) => /改说明|Edit description/.test(b.getAttribute("title") || "")) : null;
      return button ? (button.innerText || "").trim() : null;
    })()`,
  );

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}