// Whether the panel's own ⇣ pull settles its row, and how fast.
//
// Everything happens in a **throwaway repository this probe creates itself** - a bare origin, a
// working clone added to the panel, a second clone that moves the origin. Nothing of the user's is
// pulled, and the only row this probe ever adds, pulls or removes is its own. (An earlier version of
// this file clicked ⇣ on whichever real row happened to be behind, which pulled a repository the user
// was working in; that is why the fixture exists.)
//
// The project list is the one thing that has to be changed, and how it is changed matters:
//
//   * the app's list lives in two places - the file `%APPDATA%/app.verta/verta-projects.json` and the
//     store plugin's in-memory copy inside the app process. **A reload does not re-read the file**:
//     measured, the plugin answered a one-project list while the file held thirty-two, and it then
//     wrote its own copy back over the file.
//   * so the fixture is added through the app's own store module (which writes the plugin's copy
//     *and* the file), and the list is put back the same way. Writing the file from outside is what
//     an earlier version of this file did, which left the user with a list of one project.
//   * the two copies must agree before anything is written. If they do not, the probe stops without
//     touching anything and says so.
//
// The row is looked up by name on every poll: a row that stops being behind sorts to a different
// place, and an index from before the pull would then describe some other project. The pull button is
// found by its glyph, not by index: the row's buttons are ⟳ / ⇣ / ⋯, and clicking by index picked the
// refresh - which is exactly why a first run looked like a pull that changed nothing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIST = join(process.env.APPDATA, "app.verta", "verta-projects.json");
const fileList = JSON.parse(readFileSync(LIST, "utf8")).projects;

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Verta Probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "Verta Probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: tmpdir(),
    },
  }).trim();

const root = mkdtempSync(join(tmpdir(), "verta-probe-pullbtn-"));
const suffix = root.replace(/\\/g, "/").split("/").pop().slice(-8);
const repoName = `probe-btn-${suffix}`;
const origin = join(root, "origin.git");
const repo = join(root, repoName);
const elsewhere = join(root, "elsewhere");
git(root, "init", "--bare", "-q", "-b", "main", origin);
git(root, "clone", "-q", origin, repo);
writeFileSync(join(repo, "a.txt"), "one\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "first");
git(repo, "push", "-q", "-u", "origin", "main");
const REPO = repo.replace(/\\/g, "/");
const TAIL = repoName;
console.log(`fixture: ${REPO}`);
console.log(`file list: ${fileList.length} project(s)`);

const targets = await (await fetch("http://localhost:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
  rmSync(root, { recursive: true, force: true });
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
  new Promise((res) => {
    const i = id++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result?.result?.value;
};
const click = async (expr) => {
  // `scrollIntoView` first: a table row can sit below the fold, and a dispatched mouse event at an
  // off-viewport coordinate hits nothing at all - which is what made a first version of this probe
  // report a pull that never started.
  const rect = await ev(
    `(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; })()`,
  );
  if (!rect || rect.w === 0) return false;
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(60);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
  return true;
};
const finder = `const urls = performance.getEntriesByType("resource").map((e) => e.name);
const find = (p) => { const h = urls.filter((n) => n.includes(p)); return h.filter((n) => n.includes("?t=")).pop() ?? h.pop(); };`;
const moduleStore = (body) =>
  `(async () => { ${finder}
  const m = await import(find("/src/modules/projects/lib/store.ts"));
  ${body} })()`;
const saveList = (paths) =>
  ev(moduleStore(`await m.saveProjectPaths(${JSON.stringify(paths)}); return "saved";`));
const readList = () => ev(moduleStore(`return await m.loadProjectPaths();`));
const rowText = () =>
  ev(`JSON.stringify((() => {
    const tr = [...document.querySelectorAll("table tbody tr")]
      .find((row) => (row.querySelector("td")?.innerText || "").trim() === ${JSON.stringify(TAIL)});
    if (!tr) return null;
    return [...tr.querySelectorAll("td")].map((td) => (td.innerText || "").replace(/\\s+/g, " ").trim()).join(" | ");
  })())`).then((t) => (t === null ? null : JSON.parse(t)));
const rowButton = (glyph) =>
  `[...[...document.querySelectorAll("table tbody tr")]
    .find((row) => (row.querySelector("td")?.innerText || "").trim() === ${JSON.stringify(TAIL)})
    ?.querySelectorAll("button") ?? []].find((b) => (b.innerText || "").trim() === ${JSON.stringify(glyph)})`;
const panelTab = () =>
  `[...document.querySelectorAll("[data-tab-id]")].find((el) => /本地项目|Projects/.test(el.innerText || ""))`;
const openPanelButton = () =>
  `[...document.querySelectorAll("button")].find((b) => /本地项目与远程仓库/.test(b.getAttribute("title") || ""))`;

/** Leaves the panel behind another tab and comes back, which is what makes it re-read the list. */
async function reenterPanel() {
  await click(
    `[...document.querySelectorAll("[data-tab-id]")].find((el) => !/本地项目|Projects/.test(el.innerText || ""))`,
  );
  await sleep(700);
  if (!(await click(panelTab()))) await click(openPanelButton());
}

let failed = false;
let measured = null;

try {
  const appList = await readList();
  console.log(`app list: ${appList.length} project(s)`);
  if (appList.length !== fileList.length) {
    throw new Error(
      `the app's list (${appList.length}) and the file (${fileList.length}) disagree; reopen the app and try again - nothing was written`,
    );
  }
  git(root, "clone", "-q", origin, elsewhere);
  writeFileSync(join(elsewhere, "b.txt"), "two\n");
  git(elsewhere, "add", "b.txt");
  git(elsewhere, "commit", "-q", "-m", "second");
  git(elsewhere, "push", "-q", "origin", "main");
  console.log("origin moved: 1 commit ahead of the fixture's checkout");

  await ev(
    `window.__TAURI_INTERNALS__.invoke("workspace_authorize", { path: ${JSON.stringify(REPO)}, workspace: { kind: "local" } })`,
  );
  await saveList([...appList, REPO]);
  await reenterPanel();

  let start = null;
  for (let i = 0; i < 60 && start === null; i++) {
    if (!(await rowText())) {
      await sleep(500);
      continue;
    }
    await click(rowButton("⟳"));
    for (let k = 0; k < 40; k++) {
      await sleep(500);
      const text = await rowText();
      if (!text) continue;
      if (text.includes("路径不存在") || text.includes("does not exist")) {
        throw new Error(`the fixture's row says its path does not exist: ${text}`);
      }
      if (!text.includes("未检查") && !text.includes("not checked")) {
        start = text;
        break;
      }
    }
  }
  if (start === null) throw new Error("the fixture's row never reached a checked state");
  const behind = /落后 (\d+)/.exec(start)?.[1] ?? "0";
  console.log(`row before the pull: ${start}`);

  // The row's ⇣ is disabled while the panel's own check is running (or while a pull of its own is
  // in flight), and a click on a disabled button does nothing at all - the first version of this
  // probe clicked it anyway and then reported a pull that never started.
  const blockedFor = Date.now();
  let pullReady = false;
  for (let i = 0; i < 240 && !pullReady; i++) {
    pullReady = !(await ev(
      `(() => { const b = ${rowButton("⇣")}; return b ? b.disabled : true; })()`,
    ));
    if (!pullReady) await sleep(250);
  }
  if (!pullReady) throw new Error("the row's ⇣ never became enabled");
  console.log(`⇣ became enabled after ${((Date.now() - blockedFor) / 1000).toFixed(1)}s`);

  const clicked = await click(rowButton("⇣"));
  const pulledAt = Date.now();
  console.log(`⇣ clicked: ${clicked}; polling the row only from here`);
  let last = start;
  let spinner = false;
  let settledAt = null;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const row = await rowText();
    if (!row) continue;
    if (row !== last) {
      console.log(`  +${((Date.now() - pulledAt) / 1000).toFixed(1)}s  ${row}`);
      last = row;
    }
    if (row.includes("正在拉取") || row.includes("Pulling")) spinner = true;
    if (settledAt === null && !/落后\s*\d/.test(row)) {
      settledAt = (Date.now() - pulledAt) / 1000;
    }
  }
  measured = settledAt;
  console.log(`spinner seen: ${spinner}`);
  console.log(
    settledAt === null
      ? `\nRESULT: the row still said "落后 ${behind}" 30s after the ⇣ click - the panel's own pull did not settle it`
      : `\nRESULT: the row settled ${settledAt.toFixed(1)}s after the ⇣ click (was "落后 ${behind}")`,
  );
  failed = settledAt === null;
} catch (error) {
  failed = true;
  console.log(`\nPROBE FAILED: ${error.message ?? error}`);
} finally {
  try {
    await saveList(fileList);
    await sleep(1500);
    const restored = JSON.parse(readFileSync(LIST, "utf8")).projects.length;
    const appNow = (await readList()).length;
    console.log(
      `list restored: file ${restored}, app ${appNow}${restored === fileList.length && appNow === fileList.length ? "" : "  <-- MISMATCH"}`,
    );
  } catch (error) {
    console.log(`could not restore the list: ${error.message ?? error}`);
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    console.log(`fixture removed: ${root}`);
  } catch {
    console.log(`fixture left at: ${root} (it is under %TEMP%)`);
  }
  socket.close();
  process.exitCode = failed ? 1 : 0;
  console.log(measured === null ? "" : `measured: ${measured.toFixed(1)}s`);
}
