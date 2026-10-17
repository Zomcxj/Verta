// 在 dev 实例的 WebView2 里执行一段 JS 并打印结果，用于验收需要交互的界面。
// 用法：
//   1) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   2) node scripts/dev/webview-eval.mjs scripts/dev/probes/xxx.js
// 比按像素点击可靠：直接读 DOM 的矩形与文本，也能在 DOM 上触发真实点击。
import { readFileSync } from "node:fs";

const [, , file, ...rest] = process.argv;
const port = rest.find((arg) => arg.startsWith("--port="))?.slice(7) ?? "9222";
if (!file) {
  console.error("用法: node scripts/dev/webview-eval.mjs <要执行的 js 文件> [--port=9222]");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) {
  console.error(
    `没找到 page 目标。当前目标：\n${targets.map((t) => `  ${t.type} ${t.url}`).join("\n")}`,
  );
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
const expression = readFileSync(file, "utf8");

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("执行超时")), 30_000);
  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message);
  });
  socket.addEventListener("error", (event) => {
    clearTimeout(timer);
    reject(new Error(`WebSocket 出错: ${event.message ?? "未知"}`));
  });
});

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