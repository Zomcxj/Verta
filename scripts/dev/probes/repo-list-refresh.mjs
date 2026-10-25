// Acceptance for reusing a repository's list when it is opened again (the snapshot cache in
// `src/modules/remotes/lib/listSnapshot.ts`).
//
// The question is whether flipping between two repositories in the remote panel spends the same request
// again, so the evidence is two-sided and both sides carry epoch milliseconds:
//
//   1) this script opens one repository's run list, another's, then the first one again (closing in
//      between through the panel's own close button) and prints the marks, and
//   2) `gh-process-watch.ps1` records every `gh` process start while that happens.
//
// The verdict is what the watcher saw, not a stopwatch: the second open of the first repository must
// produce no `gh` start for its run list, while the panel still has its rows. The time to first row is
// printed as well, since a cache hit and a network read differ by an order of magnitude (measured:
// 2227 ms and 2704 ms against 305 ms).
//
// Nothing is written to any repository: the run list is read, a confirm window is never opened. The only
// state touched is the panel's own snapshot cache, which is cleared first through the app's own
// `resetListSnapshots` so the contrast is real rather than inherited from an earlier run. Reading that
// module by its own URL gets the app's instance, not a copy: reading a key the app has already written
// proves it.
//
// Usage:
//   1) powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/probes/gh-process-watch.ps1
//   2) node scripts/dev/probes/repo-list-refresh.mjs
//   3) touch %TEMP%\v\gh-watch.stop, then read %TEMP%\v\gh-watch.log
//
// The two repository names are the account's own (the panel lists them as `owner/name`); a different
// account needs its own pair.
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const FIRST = "Zomcxj/TitleReviewManager";
const SECOND = "Zomcxj/ModelHarbor";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

const PRESS = `const press = (node) => {
  const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
  node.dispatchEvent(new PointerEvent("pointerdown", opts));
  node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
  node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  return true;
};`;
const PANEL = `const remoteTable = () => {
  const tables = [...document.querySelectorAll("table")];
  return tables.find((tb) => (tb.querySelector("tr")?.textContent || "").includes("仓库")) ?? null;
};`;

const report = { marks: [] };
const mark = (label) => report.marks.push([label, now()]);

try {
  report.storeCleared = await evaluate(`(async () => {
    const module = await import("/src/modules/remotes/lib/listSnapshot.ts");
    const before = module.readListSnapshot(${JSON.stringify(`runs:${FIRST}`)}, 600000) ? "hit" : "miss";
    module.resetListSnapshots();
    const after = module.readListSnapshot(${JSON.stringify(`runs:${FIRST}`)}, 600000) ? "hit" : "miss";
    return JSON.stringify({ before, after });
  })()`);

  const openPanel = await evaluate(`(() => {
    ${PRESS}
    const button = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "") === "本地项目与远程仓库");
    if (!button) return "no-projects-button";
    press(button);
    return "clicked";
  })()`);
  report.projectsButton = openPanel;
  await sleep(1200);
  report.remotesStop = await evaluate(`(() => {
    ${PRESS}
    const node = [...document.querySelectorAll("[data-sub-value]")].find((n) => (n.innerText || "").trim() === "远程仓库");
    if (!node) return "not-found";
    press(node);
    return "clicked";
  })()`);
  await sleep(1200);

  let listed = [];
  for (let attempt = 0; attempt < 30 && listed.length < 2; attempt += 1) {
    await sleep(700);
    listed = JSON.parse(
      await evaluate(`JSON.stringify((() => {
        ${PANEL}
        const table = remoteTable();
        if (!table) return [];
        const names = [];
        for (const tr of [...table.querySelectorAll("tr")]) {
          const cell = [...tr.querySelectorAll("td")].find((td) => /^[^\\s\\/]+\\/[^\\s\\/]+$/.test((td.textContent || "").trim()));
          if (cell && !names.includes(cell.textContent.trim())) names.push(cell.textContent.trim());
        }
        return names;
      })())`),
    );
  }
  report.listed = listed.slice(0, 4);
  if (!listed.includes(FIRST) || !listed.includes(SECOND)) {
    throw new Error(
      `面板里没同时列出 ${FIRST} 和 ${SECOND}（列表前三个是 ${JSON.stringify(listed.slice(0, 3))}）`,
    );
  }
  report.first = FIRST;
  report.second = SECOND;

  // Radix keeps a closed panel mounted for the length of its exit animation, so "is it open" is the
  // element that says `data-state=open`, not the element's existence.
  const dialogShape = () =>
    evaluate(`JSON.stringify((() => {
      const dialog = document.querySelector("[role=dialog][data-state=open]");
      if (!dialog) return { open: false };
      const text = (dialog.textContent || "").replace(/\\s+/g, " ");
      return {
        open: true,
        title: text.slice(0, 40),
        runs: [...dialog.querySelectorAll("tbody")].reduce((total, body) => total + body.querySelectorAll("tr").length, 0),
        excerpt: text.slice(0, 110)
      };
    })())`);

  const step = async (label, repo, budgetMs) => {
    mark(`${label}:click`);
    report[`${label}:row`] = await evaluate(`(() => {
      ${PRESS}
      ${PANEL}
      const row = [...remoteTable().querySelectorAll("tr")].find((tr) => (tr.textContent || "").includes(${JSON.stringify(repo)}));
      if (!row) return "no-row";
      press(row);
      return "opened";
    })()`);
    const clickedAt = report.marks.find(([l]) => l === `${label}:click`)[1];
    const until = now() + budgetMs;
    let dialog = null;
    let readyAt = null;
    while (now() < until) {
      dialog = JSON.parse(await dialogShape());
      if (
        dialog.open &&
        (dialog.runs > 0 || /还没有运行记录|失败|超时|Get "/.test(dialog.excerpt))
      ) {
        readyAt = now();
        break;
      }
      await sleep(150);
    }
    mark(`${label}:body`);
    report[`${label}:dialog`] = dialog;
    report[`${label}:waitedMs`] = readyAt ? readyAt - clickedAt : null;
    report[`${label}:closePressed`] = await evaluate(`(() => {
      ${PRESS}
      const dialog = document.querySelector("[role=dialog][data-state=open]");
      if (!dialog) return "no-open-dialog";
      const button = dialog.querySelector("[data-slot=dialog-close]");
      if (!button) return "no-close-button";
      press(button);
      return "pressed";
    })()`);
    const settleBy = now() + 5000;
    let open = true;
    while (now() < settleBy && open) {
      await sleep(250);
      open = JSON.parse(await dialogShape()).open;
    }
    report[`${label}:closed`] = !open;
    mark(`${label}:closed`);
    await sleep(500);
  };

  await step("A1", FIRST, 20000);
  await step("B1", SECOND, 20000);
  await step("A2", FIRST, 20000);
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();