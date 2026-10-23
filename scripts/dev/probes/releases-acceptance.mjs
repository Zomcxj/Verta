// End-to-end acceptance for Releases and asset downloads: walk the UI first (row menu → list → detail →
// download button), then call the backend commands directly to verify the download pipeline (progress
// events, integrity, cancel, and a failure leaving the old file alone).
//
// The directory picker is a native dialog that cannot be automated, so the UI path stops at the download
// button; the pipeline itself goes through the same command.
// Usage: node scripts/dev/probes/releases-acceptance.mjs [--port=9222]
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port =
  process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const REPO = "Zomcxj/ModelHarbor";
const BIG_REPO = "Zomcxj/LabelForge";
const SHOTS = ".superpowers/shots";
const DIR = join(tmpdir(), "verta-releases-acceptance");

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

/** Start from a clean target directory: the acceptance run only touches its own temp copy. */
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 80) };
  })()`);

const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  // `buttons` is required: without it WebView2 never synthesizes a real click (a Radix menu still opens
  // off pointerdown, but a plain React onClick does not fire).
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
const waitFor = async (expression, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rect = await rectOf(expression);
    if (rect) return rect;
    await sleep(250);
  }
  return null;
};

try {
  // Under dev, IPC sometimes goes through the postMessage fallback first, so first paint takes a while.
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");

  // ---- 1. Open the remote repositories tab ----
  const remotesButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /远程仓库|Remote repositories/.test(b.getAttribute("title") || ""))`,
  );
  if (!remotesButton) fail("页头里没有远程仓库入口");
  await realClick(remotesButton.x, remotesButton.y);
  const filterBox = await waitFor(
    `document.querySelector('input[placeholder]') && [...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`,
    40000,
  );
  if (!filterBox) fail("远程仓库列表没有出现");
  report.remotesOpened = true;

  // ---- 2. Filter down to ModelHarbor and open "Releases..." from the row menu ----
  await evaluate(`(() => {
    const input = [...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "ModelHarbor");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const rowMenu = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").match(/更多操作|More actions/) )`,
    10000,
  );
  if (!rowMenu) fail("筛选后没有仓库行（或行菜单按钮）");
  await realClick(rowMenu.x, rowMenu.y);
  const releasesItem = await waitFor(
    `[...document.querySelectorAll('[role="menuitem"]')].find((n) => /Releases/.test(n.innerText || ""))`,
  );
  if (!releasesItem) fail("行菜单里没有 Releases 项");
  await realClick(releasesItem.x, releasesItem.y);

  // ---- 3. The list shows up; open the detail ----
  const firstRow = await waitFor(
    `[...document.querySelectorAll("li > button")].find((n) => /v\\d/.test(n.innerText || ""))`,
    15000,
  );
  if (!firstRow) fail("Releases 列表没有出现版本行");
  report.releaseRow = firstRow.text;
  await shot("releases-list.png");

  await realClick(firstRow.x, firstRow.y);
  const downloadButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /^(下载|Download)$/.test((b.innerText || "").trim()))`,
    15000,
  );
  if (!downloadButton) fail("详情里没有下载按钮");
  const detailText = await evaluate(
    `document.body.innerText.includes("个附件") || document.body.innerText.includes("assets")`,
  );
  report.detailHasAssets = detailText;
  await shot("releases-detail.png");

  // ---- 4. Download pipeline: a 13 MB asset, progress events plus integrity ----
  const small = await evaluate(`(async () => {
    const internals = window.__TAURI_INTERNALS__;
    const events = [];
    const handler = internals.transformCallback((e) => events.push(e.payload), false);
    await internals.invoke("plugin:event|listen", { event: "verta://github-download", target: { kind: "Any" }, handler });
    const listing = await internals.invoke("github_releases", { repo: "${REPO}", limit: 5 });
    const asset = listing.releases[0].assets[0];
    const id = "probe-" + Date.now();
    const started = Date.now();
    const download = await internals.invoke("github_release_download", {
      id, repo: "${REPO}", assetId: asset.id, name: asset.name, dir: ${JSON.stringify(DIR)}, total: asset.size,
    });
    return JSON.stringify({
      kind: listing.kind,
      releases: listing.releases.length,
      tag: listing.releases[0].tagName,
      assets: listing.releases[0].assets.length,
      asset: { id: asset.id, name: asset.name, size: asset.size },
      download, events: events.length,
      firstEvent: events[0] ?? null,
      lastEvent: events[events.length - 1] ?? null,
      ms: Date.now() - started,
    });
  })()`);
  const smallRun = JSON.parse(small);
  report.download = smallRun;
  if (smallRun.kind !== "ready") fail(`Release 列表没读到：${smallRun.kind}`);
  if (smallRun.download.kind !== "ok")
    fail(`下载没成功：${JSON.stringify(smallRun.download)}`);
  if (smallRun.events === 0) fail("一个进度事件都没收到");
  const landed = smallRun.download.path;
  if (!existsSync(landed)) fail(`目标文件不在：${landed}`);
  const size = statSync(landed).size;
  report.landed = { path: landed, size };
  if (size !== smallRun.asset.size)
    fail(`落盘大小 ${size} 与附件大小 ${smallRun.asset.size} 不一致`);
  if (existsSync(`${landed}.verta-part`)) fail("临时文件没被改名掉");
  const lastEvent = smallRun.lastEvent;
  if (!lastEvent || lastEvent.written !== smallRun.asset.size)
    fail(`最后一个进度事件不是完成态：${JSON.stringify(lastEvent)}`);

  // ---- 5. Cancel: stop a 155 MB asset midway, and the existing file must be left untouched ----
  const bigAsset = await evaluate(`(async () => {
    const listing = await window.__TAURI_INTERNALS__.invoke("github_releases", { repo: "${BIG_REPO}", limit: 2 });
    const asset = listing.releases[0].assets[0];
    return JSON.stringify({ id: asset.id, name: asset.name, size: asset.size });
  })()`);
  const big = JSON.parse(bigAsset);
  const guard = join(DIR, big.name);
  writeFileSync(guard, "existing-complete-file");
  const cancelRun = await evaluate(`(async () => {
    const internals = window.__TAURI_INTERNALS__;
    const id = "probe-cancel-" + Date.now();
    const events = [];
    const handler = internals.transformCallback((e) => events.push(e.payload), false);
    await internals.invoke("plugin:event|listen", { event: "verta://github-download", target: { kind: "Any" }, handler });
    const running = internals.invoke("github_release_download", {
      id, repo: "${BIG_REPO}", assetId: ${big.id}, name: ${JSON.stringify(big.name)}, dir: ${JSON.stringify(DIR)}, total: ${big.size},
    });
    await new Promise((r) => setTimeout(r, 800));
    await internals.invoke("github_release_download_cancel", { id });
    const result = await running;
    return JSON.stringify({ result, events: events.length, lastEvent: events[events.length - 1] ?? null });
  })()`);
  const cancelled = JSON.parse(cancelRun);
  report.cancel = cancelled;
  if (cancelled.result.kind !== "cancelled")
    fail(`取消得到的不是 cancelled：${JSON.stringify(cancelled.result)}`);
  if (!existsSync(guard)) fail("取消删掉了已存在的同名文件");
  if (readFileSync(guard, "utf8") !== "existing-complete-file")
    fail("取消把已存在的同名文件改了");
  if (existsSync(`${guard}.verta-part`)) fail("取消后留下了临时文件");

  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket.close();
}
