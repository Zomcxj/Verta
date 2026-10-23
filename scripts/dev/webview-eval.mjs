// Run a piece of JS inside the dev instance's WebView2 and print the result, for acceptance runs that need
// to interact with the UI.
// Usage:
//   1) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   2) node scripts/dev/webview-eval.mjs scripts/dev/probes/xxx.js
//      Optional --reload: reload the page first (gets the new code running when HMR failed).
//      Optional --match=<fragment>: pick the page by URL or title (the settings window is its own page, and
//      the default picks the main window).
//      Optional --shot=<path>: also take a CDP screenshot of the page (menus and popovers included); it does
//      not touch window focus, so it does not dismiss a freshly opened menu the way PrintWindow does.
// More reliable than clicking by pixel: it reads DOM rects and text directly and can also fire real clicks on the DOM.
import { readFileSync, writeFileSync } from "node:fs";

const [, , file, ...rest] = process.argv;
const port = rest.find((arg) => arg.startsWith("--port="))?.slice(7) ?? "9222";
const shotPath = rest.find((arg) => arg.startsWith("--shot="))?.slice(7);
const match = rest.find((arg) => arg.startsWith("--match="))?.slice(8);
const reload = rest.includes("--reload");
if (!file) {
  console.error("用法: node scripts/dev/webview-eval.mjs <要执行的 js 文件> [--port=9222]");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((target) => target.type === "page");
// Match the exact URL first: the settings window lives at `http://localhost:1420/settings.html`, which also
// contains the `localhost:1420/` fragment, so substring matching alone picks the wrong window.
const page = match
  ? (pages.find((target) => target.url === match) ??
    pages.find(
      (target) =>
        target.url.includes(match) || (target.title ?? "").includes(match),
    ))
  : pages[0];
if (!page) {
  console.error(
    `没找到 page 目标${match ? `（--match=${match}）` : ""}。当前目标：\n${targets
      .map((t) => `  ${t.type} ${t.title ?? ""} ${t.url}`)
      .join("\n")}`,
  );
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const expression = readFileSync(file, "utf8");

let nextId = 1;
const pending = new Map();
const opened = new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (event) =>
    reject(new Error(`WebSocket 出错: ${event.message ?? "未知"}`)),
  );
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry(message);
});

/** Send one CDP command and wait for its reply (ids are counted here so concurrent commands never cross). */
async function send(method, params) {
  await opened;
  const id = nextId++;
  const answer = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return answer;
}

if (reload) {
  // When HMR reported a failed reload, this is what actually gets the patched frontend code running.
  await send("Page.reload", { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

const result = await send("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});

if (shotPath) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const data = shot.result?.data;
  if (data) writeFileSync(shotPath, Buffer.from(data, "base64"));
  else console.error("截图失败:", JSON.stringify(shot.error ?? shot.result));
}

socket.close();

if (result.error) {
  console.error("CDP 报错:", JSON.stringify(result.error));
  process.exit(1);
}
const { result: value, exceptionDetails } = result.result;
if (exceptionDetails) {
  console.error("页面内异常:", exceptionDetails.text, exceptionDetails.exception?.description ?? "");
  process.exit(1);
}
console.log(typeof value.value === "string" ? value.value : JSON.stringify(value.value, null, 2));