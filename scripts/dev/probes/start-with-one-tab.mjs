// What a launch opens with: how many tabs, and where the active one is.
//
// The tab list on disk is deliberately no longer read, and the launch directory is deliberately no
// longer filled in when the launch was given none. Neither is visible in a unit test taken past the
// hook that does it - the count that matters is what the window ends up drawing after a real start,
// and the place it landed is inside a live shell. So this reads the drawn tab strip and, when asked,
// says which command to type to read the rest.
//
// The count is read, not taken on faith: a start that reattached last session's list is the whole
// of what was asked to stop, and it looks like any other window from the outside.
//
// Usage:
//   node scripts/dev/probes/start-with-one-tab.mjs                             # dev, print only
//   node scripts/dev/probes/start-with-one-tab.mjs --match=tauri.localhost/    # the installed build
//   node scripts/dev/probes/start-with-one-tab.mjs --match=tauri.localhost/ --title=agent2api
//   node scripts/dev/probes/start-with-one-tab.mjs --match=tauri.localhost/ --where
//
// `--title=<name>` requires the one tab to be labelled exactly that - how a folder handed to the
// launch shows up, since a terminal tab is named after its directory.
//
// `--where` goes on to type `pwd` in that tab's terminal and print the last lines of the interface's
// own readable copy of it, so the reading does not have to be taken off a screenshot by hand. It
// types into whatever holds the keyboard, so the window has to be focused and the terminal has to be
// the visible surface.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match");
const wantTitle = arg("title");
const wantWhere = process.argv.includes("--where");

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => {
  if (t.type !== "page") return false;
  if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
  return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
});
if (!page) {
  console.error("没找到主窗口的 page 目标（dev 或装机版起了吗？--match 对吗？）");
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

const reading = JSON.parse(
  await pageEval(`
    const strip = [...document.querySelectorAll("[data-tab-id]")].map((el) => ({
      id: el.getAttribute("data-tab-id"),
      label: (el.textContent || "").trim(),
      active: el.getAttribute("data-tab-active") === "true" ||
        el.getAttribute("aria-selected") === "true",
      // A chip that failed to render its label is a tab that is there and unreadable, which would
      // otherwise read as an empty name rather than as a broken chip.
      buttons: el.tagName
    }));
    return JSON.stringify({ strip });
  `),
);

const tabs = reading.strip;
const active = tabs.filter((t) => t.active);

console.log(`标签数：${tabs.length}`);
for (const t of tabs) {
  console.log(`  ${t.active ? "活动" : "    "} [${t.id}] ${t.label || "(没有名字)"}`);
}

const failures = [];
if (tabs.length !== 1) {
  failures.push(`打开了 ${tabs.length} 个标签，应该恰好一个`);
}
if (active.length !== 1) {
  failures.push(`活动标签 ${active.length} 个，应该恰好一个`);
}
if (wantTitle !== null) {
  // A terminal tab is named after the directory it started in, so this is how a folder handed to the
  // launch shows up - and it is the whole of what "opened there" means before the shell prints
  // anything.
  const label = active[0]?.label ?? "";
  if (label !== wantTitle) {
    failures.push(`活动标签叫「${label}」，不是「${wantTitle}」`);
  }
}

if (wantWhere) {
  // Typed as real key presses, one character at a time: a synthesized event never reaches the
  // terminal (that is what `scripts/dev/cdp-key.mjs` exists for), and what the shell does with the
  // line is the answer. `clear` first so the echo is the only thing on screen.
  const line = "clear; pwd";
  for (const character of line) {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: character,
      text: character,
      unmodifiedText: character,
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
    await sleep(30);
  }
  const enter = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  await sleep(1500);

  // Read from the interface's own accessible copy of the terminal rather than off a screenshot: it is
  // the same grid the screen draws, as text.
  const screen = JSON.parse(
    await pageEval(`
      const pres = [...document.querySelectorAll('pre[role="document"]')];
      const last = pres[pres.length - 1] ?? null;
      const lines = ((last?.textContent ?? "").split("\\n")).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
      return JSON.stringify({ panes: pres.length, lines: lines.slice(-6) });
    `),
  );
  console.log(`\n那个标签的终端最后几行（可读副本 ${screen.panes} 份）：`);
  for (const line of screen.lines) console.log(`  ${line}`);
  if (screen.lines.length === 0) {
    failures.push("终端没打印任何东西 —— pwd 的读数要靠它，别把空读数当成通过");
  }
}

if (failures.length === 0) {
  console.log(
    `\n通过：启动就一个标签${wantTitle === null ? "" : `，落在「${wantTitle}」`}。`,
  );
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
