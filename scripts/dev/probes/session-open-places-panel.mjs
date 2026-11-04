// Opening a session at a folder that is not itself a checkout: does the right panel find a repo?
//
// The report: "我打开了PTZ会话 没有找子仓库显示" - the session opened at `D:/VsPro/PTZ`, which is a
// folder of folders (`onnx/ptz_onnx`, `rdk/ptz_rdk`, `rknn/ptz_rknn`), and the panel stayed empty.
//
// Two things had to be true and neither was:
//  - the scan's answer has to be applied under the *folder's* scope. Built from the explorer's root
//    at that instant it landed under the root of the tab that was on screen *before* the click - a
//    scope the panel never asks about, so the pin was written and never read;
//  - a session whose tab is already open has to be asked about too: that branch returned before the
//    scan, and coming back to an open session is exactly how the report happened.
//
// `cd` in a plain terminal still must not do this, and this probe does not type one.
//
// The panel's repository is read off its own header (the repo's folder name above the branch), so
// "which repo is it on" is one string and not a guess about file names. The scan is asked the same
// question separately: the panel has to be on the newest of what the scan found.
//
// Usage: node scripts/dev/probes/session-open-places-panel.mjs --session=PTZ [--away=folder]
//   --away  open a tab at that folder first, so the panel starts somewhere else and has to be put
//           back by the click. A tab of its own, because the explorer follows the tab on screen and
//           the folder has to change for the panel to have anywhere else to be.
import { execFileSync } from "node:child_process";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const wanted = args("session");
const away = args("away");
if (!wanted) {
  console.error("--session=<part of the session title> is required");
  process.exit(2);
}

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

/**
 * Which repository the panel is on, read off its own header, and how wide the panel is.
 *
 * The header draws the repository's folder name above the branch, and the file rows carry paths
 * relative to it, so the name is the only place the panel says which repository it is showing.
 */
const panelState = () =>
  ev(`JSON.stringify((() => {
    const row = document.querySelector("[data-scm-path]");
    if (!row) return { repo: null, rows: 0, width: 0, text: null };
    let panel = row;
    for (let i = 0; i < 10 && panel.parentElement; i++) panel = panel.parentElement;
    const rect = panel.getBoundingClientRect();
    const first = (panel.innerText || "").split("\\n")[0].trim();
    return {
      repo: first || null,
      rows: document.querySelectorAll("[data-scm-path]").length,
      width: Math.round(rect.width),
      text: (panel.innerText || "").replace(/\\s+/g, " ").slice(0, 80),
    };
  })())`).then((raw) => JSON.parse(raw));

const clickTab = (title) =>
  ev(`(() => { ${press}
    const tab = [...document.querySelectorAll("[role=tab][data-tab-id]")]
      .find((n) => (n.textContent || "").trim() === ${JSON.stringify(title)});
    if (!tab) return "no such tab";
    press(tab);
    return "active";
  })()`);

let awayTab = null;
if (away) {
  // A tab at a folder of the probe's own, so the panel is looking at something that is not a
  // repository at all, and the click has to bring the project back by itself.
  awayTab = JSON.parse(
    await ev(`JSON.stringify(window.__vertaNewAgentTab(${JSON.stringify(away)}, "away-probe", "claude"))`),
  );
  let moved = await panelState();
  for (let i = 0; i < 40; i++) {
    if (moved.repo === null) break;
    await sleep(250);
    moved = await panelState();
  }
  console.log(`panel while away (tab ${awayTab.tabId}, root ${away}): repo=${moved.repo} rows=${moved.rows} width=${moved.width}`);
}

// The session list has to be the view on screen for its rows to exist.
const listed = await ev(`(async () => { ${press}
  for (let i = 0; i < 24; i++) {
    if (document.querySelector("[data-session-id]")) return "listed";
    const tab = [...document.querySelectorAll("button")].find((b) => /^(会话|Sessions)$/.test((b.textContent || "").trim()));
    if (tab) press(tab);
    await new Promise((r) => setTimeout(r, 250));
  }
  return "no session rows";
})()`);
console.log(`session list: ${listed}`);
if (listed !== "listed") {
  socket.close();
  process.exit(1);
}

const before = await panelState();
console.log(`panel before the click: repo=${before.repo} rows=${before.rows} width=${before.width}`);

const clicked = await ev(`(() => { ${press}
  const row = [...document.querySelectorAll("[data-session-id]")]
    .find((n) => (n.textContent || "").includes(${JSON.stringify(wanted)}));
  if (!row) return null;
  press(row);
  return (row.textContent || "").replace(/\\s+/g, " ").slice(0, 40);
})()`);
console.log(`clicked: ${clicked ?? "no such session row"}`);
if (clicked === null) {
  socket.close();
  process.exit(1);
}

let after = await panelState();
for (let i = 0; i < 40; i++) {
  if (after.repo !== null && after.repo !== before.repo) break;
  await sleep(250);
  after = await panelState();
}
console.log(`panel after the click: repo=${after.repo} rows=${after.rows} width=${after.width}`);

// The folder the session opened at: the explorer follows the tab on screen, so open it for a look.
const folder = await ev(`(async () => { ${press}
  for (let i = 0; i < 24; i++) {
    const first = document.querySelector("[data-fs-path]");
    if (first) {
      const p = first.getAttribute("data-fs-path");
      return p.replace(/\\\\/g, "/").split("/").slice(0, -1).join("/");
    }
    const view = [...document.querySelectorAll("button")].find((b) => /^(文件|Files)$/.test((b.textContent || "").trim()));
    if (view) press(view);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})()`);
console.log(`folder: ${folder}`);

const scanned = folder
  ? JSON.parse(
      await ev(`(async () => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        return JSON.stringify(await invoke("git_contained_repos", {
          folder: ${JSON.stringify(folder)},
          workspace: { kind: "local" },
        }));
      })()`),
    )
  : [];
const newestRepo = scanned[0]?.path ?? null;
const newestName = newestRepo ? newestRepo.replace(/\\/g, "/").split("/").at(-1) : null;
console.log(`scan says newest: ${newestRepo ?? "—"} (${scanned.length} found)`);

// A sanity check that the panel's own answer is a real repository in that folder.
if (newestRepo) {
  try {
    const head = execFileSync("git", ["-C", newestRepo.replace(/\//g, "\\"), "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    console.log(`newest repo HEAD: ${head}`);
  } catch {
    console.log("newest repo: git could not read it");
  }
}

const onNewest = newestName !== null && after.repo !== null && after.repo.toLowerCase() === newestName.toLowerCase();
const stayedOpen = after.width > 0;
console.log(
  onNewest && stayedOpen
    ? `\nPASS: opening the session put the panel on "${newestName}", the newest repository inside that folder, and the panel is on screen.`
    : `\nFAIL: onNewest=${onNewest} stayedOpen=${stayedOpen} (panel on ${after.repo ?? "—"}, newest is ${newestName ?? "—"})`,
);

if (awayTab) {
  console.log(`closing the probe tab: ${await ev(`(() => {
    const press = (node) => {
      const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
      node.dispatchEvent(new PointerEvent("pointerdown", opts));
      node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
      node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    };
    const tab = document.querySelector('[role=tab][data-tab-id="${awayTab.tabId}"]');
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (close) press(close);
    return close ? "closed" : "no tab";
  })()`)}`);
}

socket.close();
process.exit(onNewest && stayedOpen ? 0 : 1);
