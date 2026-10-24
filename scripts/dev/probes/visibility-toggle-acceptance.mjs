// End-to-end acceptance for the visibility cell of the remote list: clicking it switches the repo
// between private and public, and only the switch *to public* asks first.
//
// The script refreshes the list, then walks the cell: what the confirm dialog says, that cancelling
// it writes nothing, that confirming writes, and that the other direction does not ask at all. The
// GitHub side (what was really stored) is checked with gh outside this script.
//
// Usage: node scripts/dev/probes/visibility-toggle-acceptance.mjs [--port=9222] [--repo=Zomcxj/x]
//        [--from=private|public]   which direction to expect first (default private)
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const REPO = arg("repo", "Zomcxj/verta-visibility-scratch");
const FROM = arg("from", "private");

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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 120) };
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

/** A dialog animates in: measure again after a pause, or the click lands beside the button. */
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

const filterBoxExpr = `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`;
const rowExpr = (selector) => `(() => {
  const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(REPO)}));
  if (!row) return null;
  return ${selector};
})()`;
const cellExpr = rowExpr(
  `[...row.querySelectorAll("button")].find((b) => /切换私有|Switch private/.test(b.getAttribute("title") || "")) ?? null`,
);
const cellText = async () =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(REPO)}));
    const button = row ? [...row.querySelectorAll("button")].find((b) => /切换私有|Switch private/.test(b.getAttribute("title") || "")) : null;
    return button ? (button.innerText || "").trim() : null;
  })()`);
const confirmDialog = `[...document.querySelectorAll('[role="alertdialog"]')].find((d) => (d.innerText || "").includes(${JSON.stringify(REPO)}))`;
const buttonInConfirm = (pattern) =>
  `[...(${confirmDialog}?.querySelectorAll("button") ?? [])].find((b) => ${pattern}.test((b.innerText || "").trim()))`;

/** The cell is disabled while a write is in flight, so wait for it instead of sleeping. */
const waitForIdleCell = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const disabled = await evaluate(
      `(() => { const n = ${cellExpr}; return n ? n.disabled : null; })()`,
    );
    if (disabled === false) return true;
    await sleep(300);
  }
  return false;
};

const waitForCell = async (expected, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cellText()) === expected) return true;
    await sleep(400);
  }
  return false;
};
const toastExpr = (pattern) =>
  `[...document.querySelectorAll("[data-sonner-toast]")].find((n) => ${pattern}.test(n.innerText || "")) ?? null`;

/** Wait for an element and hand back its text (nodes cannot come back over the wire). */
const waitForText = async (expression, timeoutMs = 40000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(
      `(() => { const node = ${expression}; return node ? (node.innerText || "").trim() : null; })()`,
    );
    if (value) return value;
    await sleep(300);
  }
  return null;
};

async function refreshList() {
  const refresh = await waitFor(
    `(() => {
      const box = ${filterBoxExpr};
      if (!box) return null;
      let node = box;
      for (let i = 0; i < 5 && node; i += 1) {
        node = node.parentElement;
        const button = node?.querySelector("button");
        const wanted = [...(node?.querySelectorAll("button") ?? [])].find((b) => /^(刷新|Refresh)$/.test((b.innerText || "").trim()));
        if (wanted) return wanted;
      }
      return null;
    })()`,
    10000,
  );
  if (!refresh) fail("远程仓库面板里没有刷新按钮");
  await realClick(refresh.x, refresh.y);
  // gh takes seconds; wait for the row to show up again.
  const row = await waitFor(cellExpr, 60000);
  if (!row) fail(`刷新后列表里没有 ${REPO}`);
}

try {
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");
  for (let i = 0; i < 3; i += 1) {
    await pressEscape();
    await sleep(150);
  }

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

  await evaluate(`(() => {
    const box = ${filterBoxExpr};
    if (!box) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, ${JSON.stringify(REPO)});
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(400);

  // The list may have been read before the repo existed.
  if (!(await waitFor(cellExpr, 3000))) {
    await refreshList();
  }

  report.cellBefore = await cellText();
  const expectPrivateFirst = FROM === "private";
  if ((report.cellBefore === "私有") !== expectPrivateFirst) {
    fail(`起点不对：期望从${expectPrivateFirst ? "私有" : "公开"}开始，实际是 ${report.cellBefore}`);
  }

  if (expectPrivateFirst) {
    // ---- Private -> public: the confirm dialog is the thing being tested ----
    await clickOn(cellExpr, "可见性单元格");
    const dialog = await waitFor(confirmDialog, 10000);
    if (!dialog) fail("切到公开没有先确认");
    report.confirmTitle = (await waitFor(`${confirmDialog}?.querySelector("h2")`, 4000))?.text;
    report.confirmBody = dialog.text.replace(/\s+/g, " ").slice(0, 160);

    // Cancel must write nothing.
    await clickOn(buttonInConfirm("/^(取消|Cancel)$/"), "确认框的取消");
    await sleep(600);
    report.afterCancel = {
      dialogGone: (await evaluate(`${confirmDialog} === undefined`)) === true,
      cell: await cellText(),
    };

    // Now go through with it.
    await clickOn(cellExpr, "可见性单元格（第二次）");
    await clickOn(buttonInConfirm("/^(改为公开|Make public)$/"), "确认框的确认按钮");
    report.toastToPublic = await waitForText(
      toastExpr("/可见性已更新|Visibility updated/"),
      40000,
    );
    if (!(await waitForCell("公开"))) fail("确认公开之后列表里的可见性没有变成公开");
    report.cellAfterPublic = await cellText();
  }

  // ---- Public -> private: no question asked ----
  if (!(await waitForIdleCell())) fail("可见性单元格一直不可用");
  await clickOn(cellExpr, "可见性单元格（回私有）");
  await sleep(600);
  report.askedAgain =
    (await evaluate(`${confirmDialog} !== undefined`)) === true;
  report.toastToPrivate = await waitForText(
    toastExpr("/可见性已更新|Visibility updated/"),
    40000,
  );
  if (!(await waitForCell("私有"))) fail("改回私有之后列表里没有变成私有");
  report.cellAfterPrivate = await cellText();

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}