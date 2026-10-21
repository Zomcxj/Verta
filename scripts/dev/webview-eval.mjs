// 在 dev 实例的 WebView2 里执行一段 JS 并打印结果，用于验收需要交互的界面。
// 用法：
//   1) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   2) node scripts/dev/webview-eval.mjs scripts/dev/probes/xxx.js
//      可选 --reload：先让页面重载（HMR 失败时用它把新代码跑起来）。
//      可选 --match=<片段>：按 URL 或标题挑页面（设置窗口是新开的一个 page，默认会挑到主窗口）。
//      可选 --shot=<路径>：顺手用 CDP 截一张页面图（含菜单、浮层），不碰窗口焦点，
//      所以不会像 PrintWindow 那样把刚打开的菜单弄没。
// 比按像素点击可靠：直接读 DOM 的矩形与文本，也能在 DOM 上触发真实点击。
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
// 先按 URL 全等找：设置窗口的 URL 是 `http://localhost:1420/settings.html`，
// 它也会命中 `localhost:1420/` 这个片段，只按片段找会挑错窗口。
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

/** 发一条 CDP 命令并等它的应答（id 自己数，多条命令之间不会串）。 */
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
  // HMR 报过 reload 失败时，靠它把改后的前端代码真正跑起来。
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