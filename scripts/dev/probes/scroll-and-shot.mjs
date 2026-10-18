import { writeFileSync } from "node:fs";
const idx = Number(process.argv[2] ?? 0);
const out = process.argv[3] ?? "shot.png";
const scrollTo = process.argv[4] ?? "bottom";
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const s = targets.find((t) => t.url.includes("settings.html"));
if (!s) { console.log("设置窗口未开"); process.exit(1); }
const ws = new WebSocket(s.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 1;
const send = (method, params = {}) => new Promise((resolve) => {
  const myId = id++;
  const onMsg = (e) => { const m = JSON.parse(e.data); if (m.id === myId) { ws.removeEventListener("message", onMsg); resolve(m.result); } };
  ws.addEventListener("message", onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true }))?.result?.value;
await send("Page.enable");
await ev(`document.querySelectorAll('[role="tab"]')[${idx}].focus()`);
for (const type of ["keyDown", "keyUp"]) {
  await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
await new Promise((r) => setTimeout(r, 900));
await ev(`(() => { const m = document.querySelector("main"); if (m) m.scrollTop = ${scrollTo === "bottom" ? "m.scrollHeight" : "0"}; })()`);
await new Promise((r) => setTimeout(r, 700));
const text = await ev(`(document.querySelector("main")?.innerText || "").slice(-500)`);
console.log("末尾内容: " + String(text).replace(/\n/g, " / "));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("已保存 " + out);
ws.close();
