import { writeFileSync } from "node:fs";

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const settings = targets.find((t) => t.url.includes("settings.html"));
if (!settings) {
  console.log("没有找到设置窗口");
  process.exit(1);
}
const ws = new WebSocket(settings.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const send = (id, method, params = {}) =>
  new Promise((resolve) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); resolve(m.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send(1, "Page.enable");
const shot = await send(2, "Page.captureScreenshot", { format: "png" });
writeFileSync(process.argv[2] ?? "shot.png", Buffer.from(shot.data, "base64"));
console.log("已保存 " + (process.argv[2] ?? "shot.png"));
ws.close();
