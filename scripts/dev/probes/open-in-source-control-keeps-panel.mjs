// Does "open in source control" show the panel, or hide one that was already open?
//
// The report: "可以通过右键在源代码管理中打开 但是有个bug,本来侧边打开的面板会被隐藏". The menu item ran
// `toggleRightPanel`, so the one case where the user had just asked to look at the panel - it was
// already open - closed it.
//
// Driven the way a user does it: right-click a folder row in the explorer, choose the item, read
// whether the panel is on screen and which repository it is on. A real right-button press through
// CDP, because a synthesized `contextmenu` event does not open this menu.
//
// "On screen" is measured on the container of the source control view, not on a file row: a
// repository with nothing uncommitted draws no rows at all, and an open panel must not be mistaken
// for a closed one because it happens to be clean.
//
// Usage: node scripts/dev/probes/open-in-source-control-keeps-panel.mjs [--folder=D:/VsPro/PTZ/rdk]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const folderArg = process.argv.find((a) => a.startsWith("--folder="))?.slice(9);

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let seq = 1;
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
  new Promise((res) => {
    const i = seq++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? ex.text);
  return r.result?.result?.value;
};
const press = `
  const press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
`;
const rightClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1 });
  await sleep(400);
};

/**
 * Is the source control panel on screen, and which repository is it on?
 *
 * Measured on the aside the panel lives in - an `<aside>` is the right panel, and its width is zero
 * when collapsed. The header inside it carries `data-scm-repo`: the only place the panel says which
 * repository it is showing, and absent while it has none.
 */
const panelState = () =>
  ev(`JSON.stringify((() => {
    const aside = document.querySelector("aside");
    const header = document.querySelector("[data-scm-repo]");
    return {
      width: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      repo: header?.getAttribute("data-scm-repo") ?? null,
      text: (aside?.innerText ?? "").replace(/\s+/g, " ").slice(0, 100),
    };
  })())`).then((raw) => JSON.parse(raw));

// A folder to right-click that is not the user's: a repository of this probe's own with one
// uncommitted file, so its panel has something to say either way.
const fixture = mkdtempSync(join(tmpdir(), "verta-probe-scopen-")).replace(/\\/g, "/");
const repo = `${fixture}/repo`;
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
execFileSync("git", ["-C", repo, "-c", "user.email=p@e", "-c", "user.name=P", "commit", "--allow-empty", "-m", "one"], {
  encoding: "utf8",
});
const target = folderArg ? folderArg.replace(/\\/g, "/") : repo;
const root = folderArg ? target.split("/").slice(0, -1).join("/") : fixture;
const name = target.split("/").at(-1);

// The shell this probe opened may still hold the folder for a moment after its tab closes.
const removeFixture = async () => {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(fixture, { recursive: true, force: true });
      return;
    } catch {
      await sleep(300);
    }
  }
};

// A tab of this probe's own, so the explorer is looking at a folder the probe owns.
const opened = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("workspace_authorize", { path: ${JSON.stringify(root)}, workspace: { kind: "local" } });
    return JSON.stringify(window.__vertaNewAgentTab(${JSON.stringify(root)}, "scopen-probe", "claude"));
  })()`),
);

const showExplorer = async () => {
  for (let i = 0; i < 24; i++) {
    if (await ev(`Boolean(document.querySelector('[data-fs-path="${target}"]'))`)) return true;
    await ev(`(() => { ${press}
      const view = [...document.querySelectorAll("button")].find((b) => /^(文件|Files)$/.test((b.textContent || "").trim()));
      if (view) press(view);
      return "clicked";
    })()`);
    await sleep(250);
  }
  return false;
};
if (!(await showExplorer())) {
  console.error(`explorer 里没有 ${target} 这一行。`);
  await ev(`(() => { ${press}
    const tab = document.querySelector('[role=tab][data-tab-id="${opened.tabId}"]');
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (close) press(close);
    return "closed";
  })()`);
  socket.close();
  await removeFixture();
  process.exit(1);
}

// Open the panel the way the app's own button does, but without depending on that button's label: a
// right-click on the repository row and then "open in source control" is one way in, and the top
// right toggle another - and the toggle is the control whose behaviour is under test, so it must not
// be the one setting the starting state. `openRightPanel` only ever opens; the command palette's
// entry is wired to the toggle, so it is not used here either.
const openPanel = async () => {
  // The panel starts wherever the last run left it, so press the toggle, wait, and look: up to four
  // presses, and the first width above zero is the state to test from.
  for (let attempt = 0; attempt < 4; attempt++) {
    for (let i = 0; i < 10; i++) {
      await sleep(250);
      if ((await panelState()).width > 0) return "open";
    }
    await ev(`(() => { ${press}
      const button = [...document.querySelectorAll("button")]
        .find((b) => /显示\\/隐藏 Git 面板|Toggle git panel/i.test(b.title || ""));
      if (button) press(button);
      return "pressed";
    })()`);
    await sleep(600);
  }
  return "still closed";
};
console.log(`opening the panel: ${await openPanel()}`);
const openBefore = await panelState();
console.log(`panel before the menu: width=${openBefore.width} repo=${openBefore.repo} text=${openBefore.text}`);
if (openBefore.width === 0) {
  console.error("面板没能先打开，测不了「已经开着」这一条。");
  socket.close();
  await removeFixture();
  process.exit(1);
}

// The right-click, on the folder row.
const rect = JSON.parse(
  await ev(`(() => {
    const row = document.querySelector('[data-fs-path="${target}"]');
    const r = row.getBoundingClientRect();
    return JSON.stringify({ x: r.left + 40, y: r.top + r.height / 2 });
  })()`),
);
await rightClick(rect.x, rect.y);
const menu = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll("[role=menuitem]")]
    .map((n) => (n.textContent || "").trim()))`),
);
console.log(`menu: ${JSON.stringify(menu)}`);
const chosen = await ev(`(() => { ${press}
  const item = [...document.querySelectorAll("[role=menuitem]")]
    .find((n) => /在源代码管理中打开|Open in source control/i.test(n.textContent || ""));
  if (!item) return "no such item";
  press(item);
  return "chosen";
})()`);
console.log(`menu item: ${chosen}`);

let after = await panelState();
for (let i = 0; i < 40; i++) {
  if (after.width > 0 && after.repo !== null && after.repo.toLowerCase().includes(name.toLowerCase())) break;
  await sleep(250);
  after = await panelState();
}
console.log(`panel after the menu: width=${after.width} repo=${after.repo} text=${after.text}`);

const stayedOpen = after.width > 0;
const namedTheRepo = after.repo !== null && after.repo.toLowerCase().includes(name.toLowerCase());
console.log(
  stayedOpen && namedTheRepo
    ? `\nPASS: the panel was open before the menu and open after it, naming "${name}".`
    : `\nFAIL: stayedOpen=${stayedOpen} namedTheRepo=${namedTheRepo}`,
);

await ev(`(() => { ${press}
  const tab = document.querySelector('[role=tab][data-tab-id="${opened.tabId}"]');
  const close = tab?.querySelector("[data-no-drag][role=button]");
  if (close) press(close);
  return "closed";
})()`);
await sleep(1200);
socket.close();
await removeFixture();
process.exit(stayedOpen && namedTheRepo ? 0 : 1);
