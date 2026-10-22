// 往 dev 实例的 WebView2 发真实键盘事件（Input.dispatchKeyEvent）。
// 页面里合成的 KeyboardEvent 到不了终端（TUI 只认真按键），所以需要这一条通道。
// 用法：
//   1) WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//   2) node scripts/dev/cdp-key.mjs PageUp 4 [--port=9222]
//      node scripts/dev/cdp-key.mjs Ctrl+W       # 组合键：修饰键用 + 连（Ctrl / Shift / Alt / Meta）
//      node scripts/dev/cdp-key.mjs 812,300      # 点坐标（默认再滚一格，--no-wheel 跳过）
//      node scripts/dev/cdp-key.mjs --type=ls -la   # 往终端敲一整行并回车
const [, , key, times = "1", ...rest] = process.argv;
const port = rest.find((arg) => arg.startsWith("--port="))?.slice(7) ?? "9222";
const match = rest.find((arg) => arg.startsWith("--match="))?.slice(8);
if (!key) {
  console.error("用法: node scripts/dev/cdp-key.mjs <键名，如 PageUp> [次数] [--port=9222]");
  process.exit(2);
}

const KEYS = {
  PageUp: { code: "PageUp", keyCode: 33, text: "" },
  PageDown: { code: "PageDown", keyCode: 34, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
};

/** Click the point, then turn the wheel there, as a person would. */
const CLICK = /^(\d+),(\d+)$/.exec(key);
/** Type a whole line and press Enter, as characters the terminal accepts. */
const TYPE = /^--type=(.*)$/.exec(key);

// CDP 的 modifiers 是位掩码：Alt=1、Ctrl=2、Meta=4、Shift=8。
const MODIFIERS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  shift: 8,
};

/**
 * 解析 `Ctrl+W` / `Ctrl+Shift+Tab` 这类组合键，或 `PageUp` 这种单键名。
 *
 * 组合键是必需的：终端里的 Ctrl 系按键只有真实按键才到得了（合成的 KeyboardEvent 会被丢掉），
 * 而「某个快捷键到底有没有被终端吞掉」只能靠真机按一次来回答。
 */
function parseKeySpec(raw) {
  const parts = raw.split("+").filter(Boolean);
  const bare = parts.pop();
  if (!bare) return null;
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) return null;
    modifiers |= bit;
  }
  const named = KEYS[bare] ?? KEYS[bare[0].toUpperCase() + bare.slice(1).toLowerCase()];
  if (named) return { ...named, key: bare, modifiers };

  // 单字母 / 单数字：Ctrl+W 这类组合键的主力。
  if (/^[a-zA-Z]$/.test(bare) || /^[0-9]$/.test(bare)) {
    const upper = bare.toUpperCase();
    const key = (modifiers & 8) !== 0 ? upper : bare.toLowerCase();
    // 按住 Ctrl / Alt / Meta 是命令键，不是输入字符，不带 text。
    const text = (modifiers & (1 | 2 | 4)) !== 0 ? "" : key;
    return {
      key,
      code: /^[0-9]$/.test(bare) ? `Digit${bare}` : `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text,
      modifiers,
    };
  }
  return null;
}

const spec = CLICK || TYPE ? null : parseKeySpec(key);
if (!spec && !CLICK && !TYPE) {
  console.error(
    `未定义的键：${key}。可用：${Object.keys(KEYS).join(", ")}、单字母/单数字（可带 Ctrl+ / Shift+ / Alt+ / Meta+），` +
      "或 x,y 作为点击坐标，或 --type=<要输入的整行>",
  );
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter((target) => target.type === "page");
// 可能不止一个 page（设置窗口是新开的一个 page），默认挑第一个会挑错，所以给了 --match。
const page = match
  ? (pages.find((target) => target.url === match) ??
    pages.find(
      (target) => target.url.includes(match) || (target.title ?? "").includes(match),
    ))
  : pages[0];
if (!page) {
  console.error(
    `没找到 page 目标${match ? `（--match=${match}）` : ""}。当前目标：\n${JSON.stringify(
      pages.map((target) => ({ title: target.title, url: target.url })),
      null,
      2,
    )}`,
  );
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
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers: spec.modifiers ?? 0,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: "" });
  await new Promise((resolve) => setTimeout(resolve, 120));
}

socket.close();
console.log(`已发送 ${key} × ${count}`);