// Sample the page continuously (to catch errors that flash by) while real CDP mouse events open
// "plus → terminal → some distro". It has to happen in one debug client: two clients block each other, and
// events synthesized in the page cannot open a Radix menu (it cares about pointer-event details).
//
// Usage: node scripts/dev/click-watch.mjs [--port=9222] [--distro=Ubuntu-22.04]
import { readFileSync } from "node:fs";

const [, , ...rest] = process.argv;
const port = rest.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const distro = rest.find((a) => a.startsWith("--distro="))?.slice(9) ?? "";
const sampler = readFileSync("scripts/dev/probes/sampling-explorer.js", "utf8");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没找到 page 目标");
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

/** Evaluate a small expression in the page and return its value (concurrent with the sampling, no interference). */
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "页面内异常");
  }
  return result.result.value;
};

const move = (x, y) =>
  send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });

const click = async (x, y) => {
  await move(x, y);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};

/** Find the centre of a menu item (or of the plus button). */
const centerOf = (selector, text) =>
  evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = ${text === null ? "nodes[0]" : `nodes.find((n) => n.textContent?.trim().startsWith(${JSON.stringify(text)}))`};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: node.textContent?.trim() };
  })()`);

const steps = [];

// Kick off the sampling first (not awaited); it runs for 20 seconds on its own.
const sampling = send("Runtime.evaluate", {
  expression: sampler,
  awaitPromise: true,
  returnByValue: true,
});
await sleep(300);

const plus = await centerOf("button[title]", null);
const plusNode = await evaluate(`(() => {
  const node = [...document.querySelectorAll("button")].find((n) => /标签页|New tab/i.test(n.getAttribute("title") ?? ""));
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
void plus;
if (!plusNode) {
  console.error("没找到加号按钮");
  process.exit(1);
}
steps.push({ 步骤: "点加号", at: plusNode });
await click(plusNode.x, plusNode.y);

const terminal = await (async () => {
  for (let i = 0; i < 20; i += 1) {
    const found = await centerOf("[role='menuitem']", "终端");
    if (found) return found;
    await sleep(150);
  }
  return null;
})();
if (!terminal) {
  console.error("菜单里没找到「终端」", steps);
  process.exit(1);
}
steps.push({ 步骤: "点终端", at: terminal });
await click(terminal.x, terminal.y);

const entry = await (async () => {
  for (let i = 0; i < 30; i += 1) {
    const found = await centerOf("[role='menuitem']", distro ? `WSL：${distro}` : "WSL：");
    if (found) return found;
    await sleep(150);
  }
  return null;
})();
if (!entry) {
  const labels = await evaluate(
    `[...document.querySelectorAll("[role='menuitem']")].map((n) => n.textContent?.trim())`,
  );
  console.error("悬浮窗里没找到发行版项", steps, labels);
  process.exit(1);
}
steps.push({ 步骤: "点发行版", at: entry });
const tabsBefore = await evaluate(`document.querySelectorAll("[role='tab']").length`);
await click(entry.x, entry.y);

// Wait for a new tab to appear (the terminal really opened), then linger so the sampling covers the steady state.
for (let i = 0; i < 250; i += 1) {
  const now = await evaluate(`document.querySelectorAll("[role='tab']").length`);
  if (now > tabsBefore) break;
  await sleep(100);
}
const tabsAfter = await evaluate(`document.querySelectorAll("[role='tab']").length`);

const sampled = await sampling;
steps.push({ 步骤: "结束", 点击前标签数: tabsBefore, 点击后标签数: tabsAfter });
console.log(JSON.stringify({ steps, ...JSON.parse(sampled.result.value) }, null, 2));
socket.close();