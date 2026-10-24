// End-to-end acceptance for creating a repository and then renaming it, both from the remote
// list: create it through "New repository…", then walk the row's menu into "Repo settings…"
// and rename it there. The script checks what the page shows; what GitHub really stored is
// checked with gh outside it (visibility, description, license, .gitignore, the new name).
//
// Usage: node scripts/dev/probes/create-rename-acceptance.mjs [--port=9222]
//        [--name=verta-create-scratch] [--text=SCRATCH description]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback;

const NAME = arg("name", "verta-create-scratch");
const TEXT = arg("text", "SCRATCH created by create-rename-acceptance");
const RENAMED = `${NAME}-renamed`;

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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 140) };
  })()`);

/** A real mouse click: WebView2 only fires React onClick for synthesized input carrying `buttons`. */
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
 * A dialog animates in, and a busy button ignores clicks: wait until the element is there
 * **and enabled**, measure again after a pause, then click where it actually is.
 */
const clickOn = async (expression, label, timeoutMs = 40000) => {
  const enabled = `(() => { const node = ${expression}; return node && !node.disabled ? node : null; })()`;
  const found = await waitFor(enabled, timeoutMs);
  if (!found) fail(`${label} 没找到（或一直是禁用状态）`);
  await sleep(350);
  const settled = (await rectOf(enabled)) ?? found;
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

const textOf = (expression) =>
  evaluate(
    `(() => { const node = ${expression}; return node ? (node.innerText || node.textContent || "").trim() : null; })()`,
  );

const waitForText = async (expression, pattern, timeoutMs = 40000) => {
  const deadline = Date.now() + timeoutMs;
  const test = new RegExp(pattern);
  while (Date.now() < deadline) {
    const value = await textOf(expression);
    if (value && test.test(value)) return value;
    await sleep(300);
  }
  return null;
};

const filterBoxExpr = `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`;
const rowExpr = (name) => `(() => {
  const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(name)}));
  return row ?? null;
})()`;
const createDialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /新建仓库|New repository/.test(d.innerText || ""))`;
const settingsDialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => /仓库设置|Repo settings/.test(d.innerText || ""))`;
const buttonIn = (scope, pattern) =>
  `[...(${scope}?.querySelectorAll("button") ?? [])].find((b) => ${pattern}.test((b.innerText || "").trim()))`;

/** sonner keeps a toast about four seconds, so poll rather than sample once. */
const waitForToast = async (pattern, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await evaluate(
      `(() => {
        const n = [...document.querySelectorAll("[data-sonner-toast]")].find((x) => ${pattern}.test(x.innerText || ""));
        return n ? (n.innerText || "").trim() : null;
      })()`,
    );
    if (text) return text;
    await sleep(400);
  }
  return null;
};

/** Pick one template through a Radix Select: open it, then click the option by its text. */
const pickOption = async (index, label, optionText) => {
  await clickOn(
    `${createDialog}?.querySelectorAll('[role="combobox"]')[${index}]`,
    `${label} 的下拉`,
    10000,
  );
  if (!(await waitFor(`[...document.querySelectorAll('[role="listbox"]')][0]`, 8000))) {
    fail(`${label} 的下拉没有展开`);
  }
  const option = `[...document.querySelectorAll('[role="option"]')].find((o) => (o.innerText || "").trim() === ${JSON.stringify(optionText)})`;
  await clickOn(option, `${label} 里的 ${optionText}`, 8000);
  await sleep(400);
  const shown = await evaluate(
    `(() => { const t = ${createDialog}?.querySelectorAll('[role="combobox"]')[${index}]; return t ? (t.innerText || "").trim() : null; })()`,
  );
  if (shown !== optionText) fail(`${label} 选完显示的是 ${shown}，不是 ${optionText}`);
  return shown;
};

try {
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");
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
  if (!(await waitFor(filterBoxExpr))) fail("远程仓库列表没有出现");
  report.remotesOpened = true;

  // ---- 2. Create a repository ----
  await clickOn(
    `[...document.querySelectorAll("button")].find((b) => /^(新建仓库…|New repository…)$/.test((b.innerText || "").trim()))`,
    "新建仓库按钮",
  );
  if (!(await waitFor(createDialog, 10000))) fail("新建仓库弹窗没有出现");

  report.defaultVisibility = await evaluate(
    `(() => { const n = ${createDialog}?.querySelector("#new-repo-private"); return n ? n.getAttribute("data-state") : null; })()`,
  );

  await setValue(`${createDialog}?.querySelector("#new-repo-name")`, NAME);
  await setValue(`${createDialog}?.querySelector("#new-repo-description")`, TEXT);
  report.gitignore = await pickOption(0, ".gitignore 模板", "Rust");
  report.license = await pickOption(1, "许可证", "MIT");

  await clickOn(buttonIn(createDialog, "/^(创建仓库|Create repository)$/"), "创建按钮");
  const createdText = await waitForToast("/已创建|Created/");
  if (!createdText) fail("创建之后没有出现提示");
  report.createToast = createdText;
  report.createdSlug = createdText.match(/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+/)?.[0] ?? null;
  await sleep(500);
  report.createDialogClosed = (await evaluate(`${createDialog} === undefined`)) === true;

  // ---- 3. The list read itself back: the new row is there ----
  const createdRow = await waitFor(rowExpr(NAME), 90000);
  if (!createdRow) fail(`创建之后列表里没有 ${NAME}`);
  report.rowTextAfterCreate = createdRow.text.replace(/\s+/g, " ");

  // ---- 4. Rename it from the row's menu ----
  await clickOn(
    `[...(${rowExpr(NAME)}?.querySelectorAll("button") ?? [])].find((b) => b.getAttribute("title") === "更多操作" || /^⋯$/.test((b.innerText || "").trim())) ?? null`,
    `${NAME} 那一行的更多操作`,
    15000,
  );
  await clickOn(
    `[...document.querySelectorAll('[role="menuitem"]')].find((i) => /^(仓库设置…|Repo settings…)$/.test((i.innerText || "").trim()))`,
    "菜单里的仓库设置",
    10000,
  );
  // React writes the DOM `value` property, so an attribute selector would not see it.
  const renameField = `[...(${settingsDialog}?.querySelectorAll("input") ?? [])].find((i) => i.value === ${JSON.stringify(NAME)})`;
  if (!(await waitFor(renameField, 25000))) {
    fail("仓库设置弹窗里没有以当前库名填好的输入框");
  }
  report.renameSeeded = await evaluate(
    `(() => { const n = ${renameField}; return n ? n.value : null; })()`,
  );
  report.renameDisabledWhenClean = await evaluate(
    `(() => { const b = ${buttonIn(settingsDialog, "/^(改库名|Rename)$/")}; return b ? b.disabled : null; })()`,
  );

  await setValue(renameField, RENAMED);
  await clickOn(buttonIn(settingsDialog, "/^(改库名|Rename)$/"), "改库名按钮");
  const renameToast = await waitForToast("/已改名|Renamed/");
  if (!renameToast) fail("改名之后没有出现提示");
  report.renameToast = renameToast;

  // ---- 5. The dialog and the row both follow the new name ----
  const title = await waitForText(
    `${settingsDialog}?.querySelector("h2")`,
    RENAMED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    30000,
  );
  report.dialogTitleAfterRename = title;
  if (!title || !title.includes(RENAMED)) fail(`弹窗标题没有跟着改成 ${RENAMED}`);

  await pressEscape();
  await sleep(700);
  const renamedRow = await waitFor(rowExpr(RENAMED), 20000);
  if (!renamedRow) fail(`列表里没有改名后的 ${RENAMED}`);
  report.rowTextAfterRename = renamedRow.text.replace(/\s+/g, " ");
  // The new name contains the old one, so "gone" means no row shows the old name alone.
  report.rowsStillShowingOldName = await evaluate(`(() => {
    return [...document.querySelectorAll("tr")].filter((n) => {
      const text = n.innerText || "";
      return text.includes(${JSON.stringify(NAME)}) && !text.includes(${JSON.stringify(RENAMED)});
    }).length;
  })()`);
  if (report.rowsStillShowingOldName !== 0) fail("列表里还留着旧名字那一行");

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}