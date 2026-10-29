// A toast: whether its text can be selected with a drag, whether it carries a close button and an
// action, and whether that action copies the whole message.
//
// The complaint was that an error in the bottom-right corner cannot be copied. Neither half of that
// is visible in a diff: sonner wraps every toast in a swipe handler with `touch-action: none`, so
// whether a drag selects the text or dismisses the toast is a fact about the rendered stack, and the
// only honest reading is a real drag followed by `window.getSelection()`.
//
// Usage:
//   node scripts/dev/probes/toast-copy.mjs --match=http://tauri.localhost/          # read what is up
//   node scripts/dev/probes/toast-copy.mjs --match=http://tauri.localhost/ --drag   # drag across the title
//   node scripts/dev/probes/toast-copy.mjs --match=http://tauri.localhost/ --copy   # press its action
//
// It does not raise a toast of its own: the application has no global handle on the library, so the
// caller makes one happen first (a folder name with a slash in it is enough) and then runs this.
// A run that finds no toast exits 2 - measuring nothing is not a pass.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match") ?? "http://tauri.localhost/";
const drag = process.argv.includes("--drag");
const copy = process.argv.includes("--copy");

const target = (await (await fetch("http://127.0.0.1:9222/json")).json()).find(
  (t) => t.type === "page" && t.url === match,
);
if (!target) {
  console.error(`没找到 ${match} 这个窗口`);
  process.exit(1);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  pending.get(m.id)?.(m);
  pending.delete(m.id);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evalIn = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reading = await evalIn(`
  return [...document.querySelectorAll("[data-sonner-toast]")].map((el) => {
    const s = getComputedStyle(el);
    const title = el.querySelector("[data-title]") || el;
    const t = title.getBoundingClientRect();
    const action = el.querySelector("[data-button]");
    const a = action?.getBoundingClientRect();
    return {
      text: (el.textContent || "").trim().slice(0, 120),
      type: el.getAttribute("data-type"),
      userSelect: s.userSelect || s.webkitUserSelect,
      touchAction: s.touchAction,
      actions: [...el.querySelectorAll("[data-button]")].map((b) => (b.textContent || "").trim()),
      hasClose: el.querySelector("[data-close-button]") !== null,
      titleBox: { left: Math.round(t.left + 8), right: Math.round(t.right - 8), y: Math.round(t.top + t.height / 2) },
      actionAt: a ? [Math.round(a.left + a.width / 2), Math.round(a.top + a.height / 2)] : null
    };
  });
`);

if (reading.length === 0) {
  console.error("屏幕上没有 toast：先让应用报一个错（比如新建一个名字带斜杠的文件夹），再跑这个探针。");
  process.exit(2);
}
console.log(`屏幕上有 ${reading.length} 条 toast`);
for (const toast of reading) {
  console.log(
    `  [${toast.type}] user-select=${toast.userSelect} touch-action=${toast.touchAction} ` +
      `关闭按钮=${toast.hasClose ? "有" : "没有"} 动作=${JSON.stringify(toast.actions)}`,
  );
  console.log(`    ${toast.text}`);
}

const failures = [];
const first = reading[0];
if (!first.hasClose) failures.push("报错条没有关闭按钮（想要它能留住、也能关掉）");
if (first.userSelect !== "text") failures.push(`报错条的文字不可选中（user-select: ${first.userSelect}）`);
if (first.actions.length === 0) failures.push("报错条没有「复制错误」这类动作");

if (drag) {
  // A real press-move-release: a synthesized selection API call would prove nothing about the
  // swipe handler that wraps the toast.
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: first.titleBox.left,
    y: first.titleBox.y,
    button: "left",
    clickCount: 1,
  });
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: first.titleBox.left + Math.round(((first.titleBox.right - first.titleBox.left) * i) / steps),
      y: first.titleBox.y,
      button: "left",
      buttons: 1,
    });
    await sleep(40);
  }
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: first.titleBox.right,
    y: first.titleBox.y,
    button: "left",
    clickCount: 1,
  });
  await sleep(400);
  const after = await evalIn(`
    const s = window.getSelection();
    return { selected: (s?.toString() || ""), toastsLeft: document.querySelectorAll("[data-sonner-toast]").length };
  `);
  console.log(`\n拖选后：选中 ${after.selected.length} 个字符「${after.selected.slice(0, 40)}」；报错条还剩 ${after.toastsLeft} 条`);
  if (after.selected.length === 0) failures.push("拖着选中报错条的文字没选中任何东西（拖拽被当成划走了）");
  if (after.toastsLeft === 0) failures.push("拖一下就把它划走了，根本来不及选中");
}

if (copy) {
  const at = first.actionAt;
  if (!at) {
    failures.push("没有可点的复制动作");
  } else {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
    }
    await sleep(800);
    const settled = await evalIn(`
      return [...document.querySelectorAll("[data-sonner-toast]")].map((el) => ({
        text: (el.textContent || "").trim().slice(0, 40),
        type: el.getAttribute("data-type")
      }));
    `);
    console.log(`\n按下复制后：${JSON.stringify(settled)}`);
    // The clipboard itself is not readable from the page without permission; the toast changing to
    // its confirmation is the visible half, and the caller can paste it to see the other half.
    if (!settled.some((t) => t.type === "success")) {
      failures.push("按下复制后没有出现「已复制」的确认");
    }
  }
}

if (failures.length === 0) {
  console.log(`\n通过：报错条可选中、有关闭与复制${drag ? "，真拖确实选中了文字" : ""}。`);
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
