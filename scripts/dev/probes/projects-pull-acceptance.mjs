// Acceptance for the local project list's check-and-pull behaviour, run against a lab repo
// that is behind its own little bare remote (see the setup printed by the caller):
//  - the check fetches first, so the row reports what the remote really has (behind 1)
//    instead of the stale local view (nothing behind);
//  - the per-row pull brings that one repo up to date and the row says so;
//  - a repo whose upstream branch is named differently is refused, in the UI and in the
//    backend, because `git pull` would merge that other branch into this one.
//
// Usage: node scripts/dev/probes/projects-pull-acceptance.mjs [--port=9222]
//        [--behind=clone-a] [--differs=clone-b]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const arg = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  fallback;

const BEHIND = arg("behind", "clone-a");
const DIFFERS = arg("differs", "clone-b");

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("没找到主窗口；dev 起了吗？");
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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (node.innerText || node.textContent || "").trim().slice(0, 160), title: node.getAttribute("title") };
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

/** Wait until the element exists and is not disabled, then click where it really is. */
const clickOn = async (expression, label, timeoutMs = 40000) => {
  const enabled = `(() => { const node = ${expression}; return node && !node.disabled ? node : null; })()`;
  const found = await waitFor(enabled, timeoutMs);
  if (!found) fail(`${label} 没找到（或一直是禁用状态）`);
  await sleep(300);
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

const setValue = async (selectorExpression, value) =>
  evaluate(`(() => {
    const node = ${selectorExpression};
    if (!node) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

const filterExpr = `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选路径|Filter paths/.test(i.getAttribute("placeholder") || ""))`;
const rowExpr = (name) => `(() => {
  const row = [...document.querySelectorAll("tr")].find((n) => (n.innerText || "").includes(${JSON.stringify(name)}));
  return row ?? null;
})()`;
/** What one row shows, plus what its pull button would do. */
const rowState = (name) =>
  evaluate(`(() => {
    const row = ${rowExpr(name)};
    if (!row) return null;
    const cells = [...row.querySelectorAll("td")].map((c) => (c.innerText || "").trim());
    const pull = [...row.querySelectorAll("button")].find((b) => /^(⇣|正在拉取…|Pull|Pulling…)$/.test((b.innerText || "").trim()));
    const refresh = [...row.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes("刷新") || (b.getAttribute("title") || "").includes("Refresh"));
    return JSON.stringify({
      cells,
      path: (row.querySelector("button[title]")?.getAttribute("title")) ?? null,
      pullShown: pull ? (pull.innerText || "").trim() : null,
      pullDisabled: pull ? pull.disabled : null,
      pullTitle: pull ? pull.getAttribute("title") : null,
      hasRefreshButton: Boolean(refresh),
      fetchWarning: (row.innerText || "").includes("⚠"),
    });
  })()`);

const clickRowRefresh = async (name) => {
  const expr = `(() => {
    const row = ${rowExpr(name)};
    if (!row) return null;
    const b = [...row.querySelectorAll("button")].find((x) => {
      const t = x.getAttribute("title") || "";
      return t.includes("只刷新这一行") || t.includes("Refresh this row");
    });
    return b ?? null;
  })()`;
  await clickOn(expr, `${name} 那一行的单行刷新`);
};

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

  // ---- The projects panel, on the local list ----
  await clickOn(
    `[...document.querySelectorAll("button")].find((b) => /本地项目与远程仓库|Local projects/.test(b.getAttribute("title") || ""))`,
    "页头的项目面板入口",
  );
  await clickOn(
    `[...document.querySelectorAll("[data-sub-value]")].find((el) => el.getAttribute("data-sub-value") === "projects")`,
    "面板里的本地项目切换项",
    20000,
  );
  if (!(await waitFor(filterExpr))) fail("本地项目列表没有出现");
  await setValue(filterExpr, "pull-lab");
  await sleep(600);

  // ---- 1. The lab repos are in the list (the store was edited before this run) ----
  const behindRow = await waitFor(rowExpr(BEHIND), 20000);
  if (!behindRow) fail(`列表里没有 ${BEHIND}（store 里的两行是不是被清掉了？）`);
  report.rowBeforeRefresh = behindRow.text.replace(/\s+/g, " ");

  // ---- 2. The check fetches, so the row says what the remote really has ----
  // Written before this run: clone-a had not fetched since the remote moved on, so a
  // local-only check would say "clean".
  const toolbarRefresh = `[...document.querySelectorAll("button")].find((b) => /^(刷新|Refresh)$/.test((b.innerText || "").trim()))`;
  await clickOn(toolbarRefresh, "工具栏的刷新");
  let fetched = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !fetched) {
    await sleep(600);
    const raw = await rowState(BEHIND);
    const state = raw ? JSON.parse(raw) : null;
    fetched = Boolean(state && state.cells.some((c) => /落后|behind/.test(c)));
    if (!fetched) continue;
    report.rowAfterFetch = state;
  }
  if (!fetched) {
    report.rowAfterFetch = JSON.parse((await rowState(BEHIND)) ?? "null");
    fail("刷新之后那一行没有报「落后」，说明检查没有先 fetch");
  }
  if (report.rowAfterFetch.fetchWarning) fail("这一行的 fetch 失败了（出现了警告标记）");

  // ---- 3. A differently named upstream is refused before it is even clicked ----
  const differs = JSON.parse((await rowState(DIFFERS)) ?? "null");
  report.differsRow = differs;
  if (!differs) fail(`列表里没有 ${DIFFERS}`);
  if (differs.pullDisabled !== true) fail("上游不同名的行没有被禁用拉取");
  if (!/不同名/.test(differs.pullTitle ?? "")) {
    fail(`上游不同名的行提示不对：${differs.pullTitle}`);
  }

  // ---- 4. The backend refuses it too, not just the button ----
  const refusal = await evaluate(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("projects_pull", {
        path: ${JSON.stringify(differs.path ?? "")},
        workspace: { kind: "local" },
      });
      return "no-refusal";
    } catch (e) {
      return String(e);
    }
  })()`);
  report.backendRefusalForDiffers = refusal === "no-refusal" ? refusal : refusal.slice(0, 200);

  // ---- 5. Pull the one repo that really is behind ----
  const pullExpr = `(() => {
    const row = ${rowExpr(BEHIND)};
    if (!row) return null;
    return [...row.querySelectorAll("button")].find((b) => (b.innerText || "").trim() === "⇣") ?? null;
  })()`;
  await clickOn(pullExpr, `${BEHIND} 那一行的拉取`);
  const toast = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const text = await evaluate(
        `(() => { const n = [...document.querySelectorAll("[data-sonner-toast]")].find((x) => /已拉取|Pulled/.test(x.innerText || "")); return n ? (n.innerText || "").trim() : null; })()`,
      );
      if (text) return text;
      await sleep(400);
    }
    return null;
  })();
  if (!toast) fail("拉取之后没有出现提示（多半是后端拒绝了）");
  report.pullToast = toast;

  // ---- 6. The row follows: it is up to date now ----
  let upToDate = null;
  const settle = Date.now() + 30000;
  while (Date.now() < settle) {
    await sleep(600);
    upToDate = JSON.parse((await rowState(BEHIND)) ?? "null");
    if (upToDate && !upToDate.cells.some((c) => /落后|behind/.test(c))) break;
  }
  report.rowAfterPull = upToDate;
  if (!upToDate || upToDate.cells.some((c) => /落后|behind/.test(c))) {
    fail("拉取之后那一行还报落后");
  }

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}