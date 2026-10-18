// 往 dev 实例的 WebView2 发真实键盘事件（Input.dispatchKeyEvent）。
// 页面里合成的 KeyboardEvent 到不了终端（TUI 只认真按键），所以需要这一条通道。
// 用法：
//   1) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   2) node scripts/dev/cdp-key.mjs PageUp 4 [--port=9222]
//   node scripts/dev/cdp-key.mjs 3 1        # 直接发 Ctrl+C（key=3 = 取消，modifiers 里带 ctrl）
const [, , key, times = "1", ...rest] = process.argv;
const port = rest.find((arg) => arg.startsWith("--port="))?.slice(7) ?? "9222";
if (!key) {
  console.error("用法: node scripts/dev/cdp-key.mjs <键名，如 PageUp> [次数] [--port=9222]");
  process.exit(2);
}

const KEYS = {
  PageUp: { code: "PageUp", keyCode: 33, text: "" },
  PageDown: { code: "PageDown", keyCode: 34, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
};

/** Click the point, then turn the wheel there, as a person would. */
const CLICK = /^(\d+),(\d+)$/.exec(key);
/** Type a whole line and press Enter, as characters the terminal accepts. */
const TYPE = /^--type=(.*)$/.exec(key);
const spec = CLICK || TYPE ? null : KEYS[key];
if (!spec && !CLICK && !TYPE) {
  console.error(
    `未定义的键：${key}。可用：${Object.keys(KEYS).join(", ")}，或 x,y 作为点击坐标，或 --type=<要输入的整行>`,
  );
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page");
if (!page) {
  console.error("没找到 page 目标");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("连接超时")), 10_000);
  socket.addEventListener("open", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.addEventListener("error", (event) => {
    clearTimeout(timer);
    reject(new Error(`WebSocket 出错: ${event.message ?? "未知"}`));
  });
});

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

const count = Number.parseInt(times, 10) || 1;
if (CLICK) {
  const x = Number(CLICK[1]);
  const y = Number(CLICK[2]);
  if (rest.includes("--hover")) {
    // 只移动指针：用来触发 Radix 的悬停浮层，不点下去。
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    socket.close();
    console.log(`已移动到 ${x},${y}（悬停）`);
    process.exit(0);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  // A wheel turn is a mouse report the program itself handles, which is how a
  // TUI in the alternate screen scrolls. 点 UI（菜单之类）时用 --no-wheel 跳过：
  // 那一滚会被菜单当成外部滚动，把刚打开的菜单关掉。
  const delta = rest.includes("--down") ? 120 : -120;
  const turns = rest.includes("--no-wheel") ? 0 : count;
  for (let index = 0; index < turns; index += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: delta,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  socket.close();
  console.log(`已在 ${x},${y} 点击并滚轮 ${count} 次（deltaY ${delta}）`);
  process.exit(0);
}

if (TYPE) {
  const text = TYPE[1];
  if (!text) {
    console.error("--type= 后面要有内容");
    process.exit(2);
  }
  // 终端只认真按键，所以逐字符发 keyDown + text；最后单独发 \r 作为回车。
  for (const character of text) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: character,
      text: character,
      unmodifiedText: character,
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const enter = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  socket.close();
  console.log(`已输入 ${text.length} 个字符并回车`);
  process.exit(0);
}

for (let index = 0; index < count; index += 1) {
  const base = {
    key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: "" });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

socket.close();
console.log(`已发送 ${key} × ${count}`);