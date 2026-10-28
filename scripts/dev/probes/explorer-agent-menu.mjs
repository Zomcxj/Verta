// What a folder's right-click menu in the file tree offers, and what a file's does not.
//
// The entries this checks are the ones that hand a folder to an agent, and they are drawn as a row
// of icons at the top of the menu - the same shape the local project row offers them in. Nothing
// about that is readable from a unit test: which row was right-clicked, whether the menu opened at
// all, and whether the entries come first are all facts about a rendered Radix menu over a live
// file tree. So this right-clicks for real - a real contextmenu from CDP, because a synthesized
// event is not what a menu listens for - and then reads the menu the interface actually drew.
//
// It tests both kinds of row on purpose. An entry that appears on a file would be a feature the
// user asked not to have: an agent's session is a project directory, and a file has nothing to
// hand it.
//
// Usage:
//   node scripts/dev/probes/explorer-agent-menu.mjs --match=tauri.localhost/
//   node scripts/dev/probes/explorer-agent-menu.mjs --match=tauri.localhost/ --open=pi
//
// `--open=<tool>` goes on to click that agent's entry on the folder and report what happened - the
// new tab, which is named after the folder - so the entry can be shown to do what it says rather
// than only to be drawn. It starts a real session of that agent in the folder that was
// right-clicked; the console says which, so nothing is started by surprise.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match");
const openWith = arg("open");

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => {
  if (t.type !== "page") return false;
  if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
  return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
});
if (!page) {
  console.error("没找到主窗口的 page 目标（装机版起了吗？--match 对吗？）");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (q) {
    pending.delete(m.id);
    q(m);
  }
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real right-button press, then release: what Chromium turns into a contextmenu. */
const rightClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "right",
    buttons: 2,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "right",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(350);
};
const leftClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(250);
};
const pressEscape = async () => {
  const base = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(200);
};

/** The file tree's rows, with a clickable point inside each and whether it is on screen. */
const rowListing = () =>
  pageEval(`
    const scroller = [...document.querySelectorAll("[data-explorer-drop]")].find((el) => el.querySelector("[data-fs-path]")) ?? null;
    const box = scroller ? scroller.getBoundingClientRect() : null;
    return [...document.querySelectorAll("[data-fs-path]")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          path: el.getAttribute("data-fs-path"),
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          // A right-click has to land inside the scroll area that listens for it.
          inView: box ? r.top >= box.top - 1 && r.bottom <= box.bottom + 1 : true,
        };
      })
      .filter((row) => row.inView);
  `);

/** Every item the menu drew, in the order it drew them, with the icon it carries. */
const menuListing = () =>
  pageEval(`
    return [...document.querySelectorAll("[role=menuitem]")].map((el) => ({
      label: el.getAttribute("aria-label") || (el.textContent || "").trim(),
      icon: el.querySelector("svg, img") !== null,
    }));
  `);

const { statSync } = await import("node:fs");

/** Which of these rows are folders, by the filesystem itself rather than by the interface. */
function kindOf(path) {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return "unknown";
  }
}

// The tree lives in the sidebar, which may be showing the session list instead.
await pageEval(`
  const PRESS=(el)=>{const o={bubbles:true,cancelable:true,button:0,buttons:1,isPrimary:true,pointerId:1,pointerType:"mouse"};el.dispatchEvent(new PointerEvent("pointerdown",o));el.dispatchEvent(new PointerEvent("pointerup",{...o,buttons:0}));el.dispatchEvent(new MouseEvent("click",{...o,buttons:0}));};
  if (document.querySelector("[data-fs-path]") === null) {
    const rail = [...document.querySelectorAll("button[aria-label]")].find((b) => /文件|Files/.test(b.getAttribute("aria-label")));
    if (rail) PRESS(rail);
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
`);

const rows = await rowListing();
if (rows.length === 0) {
  console.error("文件树里一行都没有：侧栏没切到文件，或者这个根目录是空的。");
  process.exit(1);
}

const folders = rows.filter((row) => kindOf(row.path) === "dir");
const files = rows.filter((row) => kindOf(row.path) === "file");
console.log(
  `文件树：在视野里 ${rows.length} 行，其中文件夹 ${folders.length} 个、文件 ${files.length} 个。`,
);

const failures = [];
/** What the entries are expected to say, in the order the tools are listed. */
const AGENTS = ["opencode", "pi"];
const agentLabel = (tool) => `用 ${tool} 打开`;
const isAgentItem = (label) =>
  AGENTS.some((tool) => label === agentLabel(tool)) || /^用 .+ 打开$/.test(label);

// --- a folder -------------------------------------------------------------------------------
if (folders.length === 0) {
  console.error("视野里没有文件夹，没法量「用 agent 打开」这一组（往下滚一点再跑）。");
  process.exit(1);
}
const folder = folders[0];
console.log(`\n右键文件夹：${folder.path}`);
await rightClick(folder.x, folder.y);
const folderMenu = await menuListing();
for (const [i, item] of folderMenu.entries()) {
  console.log(`  ${i + 1}. ${item.label || "(无文案)"}${item.icon ? "  [图标]" : ""}`);
}
if (folderMenu.length === 0) {
  failures.push("文件夹上右键，菜单一条都没画出来");
} else {
  const agents = folderMenu.filter((item) => isAgentItem(item.label));
  if (agents.length !== AGENTS.length) {
    failures.push(
      `文件夹菜单里 agent 条目有 ${agents.length} 条，应是 ${AGENTS.length} 条（opencode / pi）`,
    );
  }
  const expected = AGENTS.map(agentLabel);
  if (agents.map((a) => a.label).join("|") !== expected.join("|")) {
    failures.push(
      `agent 条目的文案/顺序不对：读到 ${JSON.stringify(agents.map((a) => a.label))}，应是 ${JSON.stringify(expected)}`,
    );
  }
  if (agents.some((item) => !item.icon)) {
    failures.push("有 agent 条目没带图标（用户点的是图标）");
  }
  // "First" means before everything the menu used to offer, not merely present somewhere.
  const firstNonAgent = folderMenu.findIndex((item) => !isAgentItem(item.label));
  if (firstNonAgent !== -1 && firstNonAgent < agents.length) {
    failures.push(
      `agent 条目不在最前：第 ${firstNonAgent + 1} 条是「${folderMenu[firstNonAgent].label}」`,
    );
  }
  if (!folderMenu.some((item) => /在终端中打开|Open in terminal/i.test(item.label))) {
    console.log("  （注意：这个菜单里没有「在终端中打开」，说明它不是文件夹的菜单？）");
  }
}

// --- a file ---------------------------------------------------------------------------------
if (files.length > 0) {
  const file = files[0];
  await pressEscape();
  console.log(`\n右键文件：${file.path}`);
  await rightClick(file.x, file.y);
  const fileMenu = await menuListing();
  for (const [i, item] of fileMenu.entries()) {
    console.log(`  ${i + 1}. ${item.label || "(无文案)"}${item.icon ? "  [图标]" : ""}`);
  }
  if (fileMenu.length === 0) {
    failures.push("文件上右键，菜单一条都没画出来");
  } else {
    const strays = fileMenu.filter((item) => isAgentItem(item.label));
    if (strays.length > 0) {
      failures.push(
        `文件菜单里出现了 agent 条目（${strays.map((s) => s.label).join("、")}），只能给文件夹`,
      );
    }
    if (fileMenu.some((item) => /在终端中打开|Open in terminal/i.test(item.label))) {
      failures.push("这个「文件」的菜单里有「在终端中打开」：分类可能反了，量到的是文件夹");
    }
  }
} else {
  console.log("\n视野里没有文件，文件那一半没量（往下滚一点再跑）。");
}
await pressEscape();

// --- optionally, actually open it ------------------------------------------------------------
if (openWith !== null) {
  console.log(`\n真开一次：文件夹 ${folder.path} 上点「${agentLabel(openWith)}」`);
  const before = await pageEval(`
    return [...document.querySelectorAll("[role=tab][data-tab-id]")].map((t) => ({
      id: t.getAttribute("data-tab-id"),
      title: (t.textContent || "").trim(),
    }));
  `);
  await rightClick(folder.x, folder.y);
  const items = await menuListing();
  const wanted = items.findIndex((item) => item.label === agentLabel(openWith));
  if (wanted === -1) {
    failures.push(`菜单里找不到「${agentLabel(openWith)}」，开不了`);
    await pressEscape();
  } else {
    // The entries are a horizontal row, so each item's own box is what to click, not the menu's.
    const point = await pageEval(`
      const el = [...document.querySelectorAll("[role=menuitem]")].find((e) => e.getAttribute("aria-label") === ${JSON.stringify(agentLabel(openWith))});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    if (point === null) {
      failures.push("找不到那一条可点的位置");
      await pressEscape();
    } else {
      await leftClick(point.x, point.y);
      await sleep(9000);
      const after = await pageEval(`
        return [...document.querySelectorAll("[role=tab][data-tab-id]")].map((t) => ({
          id: t.getAttribute("data-tab-id"),
          title: (t.textContent || "").trim(),
          active: t.getAttribute("data-tab-active") === "true",
        }));
      `);
      const fresh = after.filter((t) => !before.some((b) => b.id === t.id));
      const base = folder.path.split(/[\\/]/).filter(Boolean).pop();
      console.log(`  点之前的标签：${before.map((t) => `${t.id}:${t.title}`).join("、") || "(无)"}`);
      console.log(`  点之后的标签：${after.map((t) => `${t.id}:${t.title}${t.active ? "(活动)" : ""}`).join("、") || "(无)"}`);
      console.log(`  新标签：${fresh.map((t) => `${t.id}:${t.title}`).join("、") || "(没有新标签)"}`);
      if (fresh.length === 0) {
        failures.push("点了那条，没有新标签出现");
      } else if (!fresh.some((t) => t.title === base)) {
        failures.push(
          `新标签的名字不是该文件夹的名字（应是 ${base}）：${fresh.map((t) => t.title).join("、")}`,
        );
      } else {
        // The name is the folder's, which is what the entry promised. Whether the agent's own
        // screen is running in that directory is for the eye: crop the terminal and look.
        console.log("  （该标签的目录还要看一眼屏幕：Ctrl+C 抢回 shell 后 pwd）");
      }
    }
  }
}

socket.close();
if (failures.length === 0) {
  console.log("\n通过：文件夹的菜单最前是带图标的 agent 条目（opencode、pi），文件上没有。");
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);