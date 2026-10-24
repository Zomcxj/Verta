// End-to-end acceptance for editing a release from its detail view: open the projects panel, switch to
// the remote list, filter to the target repo, open Releases, open the drafted release, edit its title and
// notes, save, and check both the toast and the re-read detail. The GitHub side (what was really stored,
// and the cleanup) is checked with gh outside this script.
//
// Usage: node scripts/dev/probes/release-edit-acceptance.mjs [--port=9222] [--repo=Zomcxj/Verta]
//        [--tag=v0.0.0-scratch-edit] [--title=...] [--notes=...]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback;

const REPO = arg("repo", "Zomcxj/Verta");
const TAG = arg("tag", "v0.0.0-scratch-edit");
const NEW_TITLE = arg("title", "SCRATCH edited title");
const NEW_NOTES = arg("notes", "SCRATCH edited body\nsecond line");

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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 120) };
  })()`);

/** A real mouse click: WebView2 only fires React onClick for synthesized input events carrying `buttons`. */
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
 * Click something for real. The element is measured again after a short pause: a dialog
 * animates in, and a rect taken during that animation is where the button used to be, so a
 * real mouse click lands beside it.
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

/** React tracks the value on the DOM node, so a plain `node.value = x` is ignored: go through the setter. */
const setValue = async (selectorExpression, value) =>
  evaluate(`(() => {
    const node = ${selectorExpression};
    if (!node) return false;
    const proto = node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

const dialog = `[...document.querySelectorAll('[role="dialog"]')].find((d) => (d.innerText || "").includes(${JSON.stringify(TAG)}))`;
const buttonInDialog = (pattern) =>
  `[...(${dialog}?.querySelectorAll("button") ?? [])].find((b) => ${pattern}.test((b.innerText || "").trim()))`;

try {
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");

  // A previous run may have left a dialog open, and this dialog keeps its view state while
  // mounted, so start from a clean slate rather than assuming the list is showing.
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

  const filterBox = await waitFor(
    `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`,
  );
  if (!filterBox) fail("远程仓库列表没有出现");
  report.remotesOpened = true;

  // ---- 2. Narrow to the target repo, then Releases... from its row menu ----
  await setValue(
    `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`,
    REPO,
  );
  await sleep(500);
  // The workspace tabs each carry a "more actions" button too, so the row has to be
  // found first and the button taken from inside it. The remote list is a table.
  const rowMenuExpr = `(() => {
      const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(REPO)}));
      if (!row) return null;
      return [...row.querySelectorAll("button")].find((b) => /更多操作|More actions/.test(b.getAttribute("title") || "")) ?? null;
    })()`;
  report.rowMenu = (await clickOn(rowMenuExpr, `筛选 ${REPO} 后的仓库行菜单`, 15000)).text;
  await clickOn(
    `[...document.querySelectorAll('[role="menuitem"]')].find((n) => /Releases/.test(n.innerText || ""))`,
    "行菜单里的 Releases 项",
  );

  // The dialog keeps whichever view it was left on, so step back to the list first.
  const backButton = await waitFor(buttonInDialog("/返回列表|Back to list/"), 5000);
  if (backButton) await clickOn(buttonInDialog("/返回列表|Back to list/"), "返回列表");

  // ---- 3. Open the drafted release ----
  const releaseRowExpr = `[...document.querySelectorAll("li > button")].find((n) => (n.innerText || "").includes(${JSON.stringify(TAG)}))`;
  report.foundRow = (await clickOn(releaseRowExpr, `列表里的 ${TAG}`, 30000)).text;

  // ---- 4. Edit: the detail swaps its body for the form ----
  report.editButton = (
    await clickOn(buttonInDialog("/^(编辑|Edit)$/"), "详情里的编辑按钮", 15000)
  ).text;

  const titleField = await waitFor(
    `[...(${dialog}?.querySelectorAll("input") ?? [])].find((i) => /Release 标题|Release title/.test(i.getAttribute("placeholder") || ""))`,
    10000,
  );
  const notesField = await waitFor(
    `[...(${dialog}?.querySelectorAll("textarea") ?? [])].find((i) => /更新说明|Release notes/.test(i.getAttribute("placeholder") || ""))`,
    10000,
  );
  if (!titleField || !notesField) {
    report.dialogs = await evaluate(
      `[...document.querySelectorAll('[role="dialog"]')].map((d) => ({ text: (d.innerText || "").slice(0, 160), buttons: [...d.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 12) }))`,
    );
    report.dialogButtons = await evaluate(
      `[...(${dialog}?.querySelectorAll("button") ?? [])].map((b) => (b.innerText || "").trim())`,
    );
    report.editButtonText = editButton.text;
    fail("编辑表单没有出现");
  }
  report.formSeeded = await evaluate(`(() => {
    const input = [...(${dialog}?.querySelectorAll("input") ?? [])].find((i) => /Release 标题|Release title/.test(i.getAttribute("placeholder") || ""));
    return input ? input.value : null;
  })()`);

  await setValue(
    `[...(${dialog}?.querySelectorAll("input") ?? [])].find((i) => /Release 标题|Release title/.test(i.getAttribute("placeholder") || ""))`,
    NEW_TITLE,
  );
  await setValue(
    `[...(${dialog}?.querySelectorAll("textarea") ?? [])].find((i) => /更新说明|Release notes/.test(i.getAttribute("placeholder") || ""))`,
    NEW_NOTES,
  );

  const saveButton = await clickOn(
    buttonInDialog("/^(保存|Save)$/"),
    "表单里的保存按钮",
    10000,
  );
  report.saveButton = saveButton.text;

  // ---- 5. The toast, then the detail re-read that follows it ----
  const toast = await waitFor(
    `[...document.querySelectorAll("[data-sonner-toast]")].find((n) => /Release 已更新|Release updated/.test(n.innerText || ""))`,
    30000,
  );
  if (!toast) fail("没有出现保存成功的提示");
  report.toast = toast.text;

  const editedTitle = await waitFor(
    `[...document.querySelectorAll("span")].find((n) => (n.innerText || "").trim() === ${JSON.stringify(NEW_TITLE)})`,
    30000,
  );
  if (!editedTitle) fail("详情里没有换成新标题");
  report.detailTitle = editedTitle.text;

  const editedBody = await evaluate(
    `document.body.innerText.includes(${JSON.stringify(NEW_NOTES.split("\n")[0])})`,
  );
  report.detailBodyHasNewFirstLine = editedBody;
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}
