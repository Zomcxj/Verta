// End-to-end acceptance for the issue / PR UI: drive the backend write path first (comment → read the detail
// → close), then walk the UI (remote repository list → row menu → Issues / PR → list → detail).
//
// Usage: node scripts/dev/probes/issues-acceptance.mjs [--port=9222] [--repo=Zomcxj/LabelForge]
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const port = args.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const REPO =
  args.find((a) => a.startsWith("--repo="))?.slice(7) ?? "Zomcxj/LabelForge";
const SHOTS = ".superpowers/shots";
mkdirSync(SHOTS, { recursive: true });

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

/** A single backend call takes a dozen seconds (gh goes over the network), so allow a generous timeout. */
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(
      () => reject(new Error(`${method} 超时`)),
      120_000,
    );
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
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
  const result = await send("Page.captureScreenshot", { format: "png" });
  if (!result.data) return;
  writeFileSync(`${SHOTS}/${name}`, Buffer.from(result.data, "base64"));
};

/** Wait until something appears in the page (returns its rect), or null on timeout. */
const waitFor = async (expression, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rect = await rectOf(expression);
    if (rect) return rect;
    await sleep(250);
  }
  return null;
};

try {
  // The UI may still be running the old code: reload once so the new modules really load.
  await send("Page.reload", { ignoreCache: true });
  await sleep(6000);
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120_000,
  );
  if (!booted) fail("界面一直没有渲染出来");

  // ---- 1. Open the remote repositories tab ----
  const remotesButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /本地项目与远程仓库|Remote repositories|Local projects/.test(b.getAttribute("title") || ""))`,
  );
  if (!remotesButton) fail("页头里没有远程仓库入口");
  await realClick(remotesButton.x, remotesButton.y);
  const filterBox = await waitFor(
    `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`,
    40_000,
  );
  if (!filterBox) fail("远程仓库列表没有出现");

  // ---- 2. Filter down to the target repository and open "Issues / PR..." from the row menu ----
  await evaluate(`(() => {
    const input = [...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(REPO.split("/")[1])});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const rowMenu = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").match(/更多操作|More actions/))`,
    15_000,
  );
  if (!rowMenu) fail("筛选后没有仓库行（或行菜单按钮）");
  await realClick(rowMenu.x, rowMenu.y);
  const issuesItem = await waitFor(
    `[...document.querySelectorAll('[role="menuitem"]')].find((n) => /Issues/.test(n.innerText || ""))`,
  );
  if (!issuesItem) fail("行菜单里没有 Issues / PR 项");
  report.menuItem = issuesItem.text;
  await realClick(issuesItem.x, issuesItem.y);

  // ---- 3. The list shows up ----
  const dialog = await waitFor(`document.querySelector('[role="dialog"]')`, 20_000);
  if (!dialog) fail("Issues / PR 弹窗没有打开");
  const listRows = await waitFor(
    `document.querySelector('[role="dialog"] li > button')`,
    30_000,
  );
  if (!listRows) {
    // It may be the "no issues" empty state, which is a valid screen too: record the body text.
    const emptyText = await evaluate(
      `document.querySelector('[role="dialog"]')?.innerText?.slice(0, 400) ?? ""`,
    );
    report.emptyDialog = emptyText;
    fail(`弹窗里没有条目：${emptyText}`);
  }
  report.listRow = listRows.text;
  await shot("issues-list.png");

  // ---- 4. Switch the state filter to Closed ----
  const closedFilter = await waitFor(
    `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /^(已关闭|Closed)$/.test((b.innerText || "").trim()))`,
  );
  if (!closedFilter) fail("弹窗里没有状态筛选按钮");
  await realClick(closedFilter.x, closedFilter.y);
  await sleep(4000);
  const closedRow = await waitFor(
    `document.querySelector('[role="dialog"] li > button')`,
    30_000,
  );
  if (!closedRow) fail("切到「已关闭」后列表是空的");
  report.closedRow = closedRow.text;

  // ---- 5. Open the detail ----
  await realClick(closedRow.x, closedRow.y);
  const back = await waitFor(
    `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /返回|Back/.test(b.innerText || ""))`,
    30_000,
  );
  if (!back) fail("详情里没有「返回」按钮");
  const detailText = await evaluate(
    `document.querySelector('[role="dialog"]')?.innerText?.slice(0, 800) ?? ""`,
  );
  report.detailText = detailText;
  // The body box must not be empty: Markdown loads lazily, so let it settle before measuring.
  await sleep(3000);
  const bodyBox = await evaluate(
    `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const box = [...(dialog?.querySelectorAll("div") ?? [])].find(
        (n) => typeof n.className === "string" && n.className.includes("max-h-[35vh]"),
      );
      if (!box) return null;
      return JSON.stringify({ h: Math.round(box.getBoundingClientRect().height), text: (box.innerText || "").slice(0, 80) });
    })()`,
  );
  report.bodyBox = bodyBox ? JSON.parse(bodyBox) : null;
  if (report.bodyBox && report.bodyBox.h < 20) {
    fail(`正文那一段是空的（高 ${report.bodyBox.h}px）`);
  }
  await shot("issues-detail.png");

  // ---- 6. Backend writes: comment → read the detail → close ----
  const write = JSON.parse(
    await evaluate(`(async () => {
      const internals = window.__TAURI_INTERNALS__;
      const list = await internals.invoke("github_issues", { repo: ${JSON.stringify(REPO)}, state: "open", limit: null });
      const created = await internals.invoke("github_issue_create", {
        repo: ${JSON.stringify(REPO)},
        title: "[verta 验收] 临时 issue " + Date.now(),
        body: "真机验收用的临时条目，验收后关闭。",
        labels: "verta-acceptance",
      });
      if (created.kind !== "ready" || !created.number) {
        return JSON.stringify({ step: "create", created, list: { kind: list.kind, count: list.issues.length } });
      }
      const number = created.number;
      const commented = await internals.invoke("github_issue_comment", {
        repo: ${JSON.stringify(REPO)}, number, body: "验收评论：Verta 的评论功能通了。",
      });
      const detail = await internals.invoke("github_issue_detail", { repo: ${JSON.stringify(REPO)}, number });
      const closed = await internals.invoke("github_issue_set_state", { repo: ${JSON.stringify(REPO)}, number, state: "closed" });
      const after = await internals.invoke("github_issue_detail", { repo: ${JSON.stringify(REPO)}, number });
      return JSON.stringify({
        step: "done",
        number,
        listBefore: { kind: list.kind, count: list.issues.length },
        created: { kind: created.kind, number: created.number, error: created.error },
        comment: { kind: commented.kind, error: commented.error },
        detail: {
          kind: detail.kind,
          state: detail.detail?.state,
          labels: detail.detail?.labels,
          comments: detail.detail?.comments?.map((c) => ({ author: c.author, body: c.body })),
        },
        closed: { kind: closed.kind, error: closed.error },
        stateAfterClose: after.detail?.state,
      });
    })()`),
  );
  report.write = write;
  if (write.step !== "done") fail(`写操作没走完：${JSON.stringify(write)}`);
  if (write.comment.kind !== "ready") fail(`评论失败：${JSON.stringify(write.comment)}`);
  if (!write.detail.comments?.length)
    fail("评论发出后详情里读不到它");
  if (write.stateAfterClose !== "closed") fail("关闭之后状态不是 closed");

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket.close();
}
