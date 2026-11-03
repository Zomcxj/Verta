// Whether a project row catches up with a `git pull` run in a terminal - the flow as it is really
// used: the terminal is the tab on screen, the panel is behind it, and the panel is looked at
// afterwards.
//
// Everything happens in a **throwaway repository this probe creates itself**, pushed to a bare
// origin it also creates, inside one temporary directory. Nothing outside that directory is touched
// and no command is run in any of the user's repositories: an earlier version of this file rewound a
// real repository to set its state up, and this one builds its own.
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
//     touching anything and says so: appending to a stale copy is how the list of one happened.
//
// The terminal renders to a canvas, so the screen is read through the session's own text accessor,
// which is also how the probe proves the pull really ran before it reads the row for it.
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
    // A fixed identity and no user config: the fixture must not depend on, or write to, the machine.
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

const root = mkdtempSync(join(tmpdir(), "verta-probe-pull-"));
// A name unique to this run: an earlier run's fixture is also called `probe-repo`, and a row found
// by that name alone matched the leftover path of a fixture whose directory had already been
// deleted - the probe then measured a row that was never the repository it pulled.
const suffix = root.replace(/\\/g, "/").split("/").pop().slice(-8);
const repoName = `probe-repo-${suffix}`;
const origin = join(root, "origin.git");
const repo = join(root, repoName);
const elsewhere = join(root, "elsewhere");
git(root, "init", "--bare", "-q", "-b", "main", origin);
git(root, "clone", "-q", origin, repo);
writeFileSync(join(repo, "a.txt"), "one\n");
git(repo, "add", "-A");
git(repo, "commit", "-q", "-m", "first");
git(repo, "push", "-q", "-u", "origin", "main");
// Forward slashes: the paths go through the app's own path handling.
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
  // off-viewport coordinate hits nothing at all.
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
const otherTab = (not) =>
  `[...document.querySelectorAll("[data-tab-id]")].find((el) => !${not}.test(el.innerText || ""))`;

/** Brings the panel to the front, creating its tab when it is not open. */
async function showPanel() {
  if (!(await click(panelTab()))) {
    await click(openPanelButton());
  }
}
/** Leaves the panel behind another tab and comes back, which is what makes it re-read the list. */
async function reenterPanel() {
  await click(otherTab(/本地项目|Projects/));
  await sleep(700);
  await showPanel();
}

let failed = false;
let leafId = null;
let measured = null;

try {
  const appList = await readList();
  console.log(`app list: ${appList.length} project(s)`);
  if (appList.length !== fileList.length) {
    throw new Error(
      `the app's list (${appList.length}) and the file (${fileList.length}) disagree; reopen the app and try again - nothing was written`,
    );
  }

  // The fixture is behind before the panel ever reads it, so the row has something to be wrong
  // about that no click of this probe caused.
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

  // The row, given a state of its own: the panel's own check fetches all 32 real projects on this
  // list before it answers any row, so waiting on that here would be waiting on other people's
  // remotes. The row's ⟳ is this probe's own fixture.
  let before = null;
  for (let i = 0; i < 60 && before === null; i++) {
    const text = await rowText();
    if (text) break;
    if (i % 10 === 9) {
      console.log(
        `  still no row; the panel lists ${await ev(
          `JSON.stringify([...document.querySelectorAll("table tbody tr")].map((tr) => (tr.querySelector("td")?.innerText || "").trim()).slice(0, 4))`,
        )}`,
      );
    }
    await sleep(500);
  }
  for (let attempt = 0; attempt < 3 && before === null; attempt++) {
    await click(rowButton("⟳"));
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const text = await rowText();
      if (!text) continue;
      if (text.includes("路径不存在") || text.includes("does not exist")) {
        throw new Error(`the fixture's row says its path does not exist: ${text}`);
      }
      if (!text.includes("未检查") && !text.includes("not checked")) {
        before = text;
        break;
      }
    }
  }
  if (before === null) throw new Error("the fixture's row never reached a checked state");
  console.log(`row before the pull: ${before}`);

  // A terminal at the fixture, which takes the screen: from here the panel is behind another tab,
  // exactly as it is when a person pulls. The text goes in through the session's own submit, so no
  // canvas has to be clicked and no focus has to be arranged first.
  const opened = await ev(
    `JSON.stringify(window.__vertaNewAgentTab(${JSON.stringify(REPO)}, "probe", "claude"))`,
  );
  ({ leafId } = JSON.parse(opened));
  await sleep(2500);
  const atTerminal = await click(
    `[...document.querySelectorAll("[data-tab-id]")].find((el) => /probe/.test(el.innerText || ""))`,
  );
  await sleep(1200);
  const shownTab = await ev(
    `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").trim()`,
  );
  console.log(
    `terminal tab opened (leaf ${leafId}), switched to it: ${atTerminal}, tab on screen: ${JSON.stringify(shownTab)}`,
  );
  if (/本地项目|Projects/.test(shownTab)) {
    throw new Error("the projects tab is still the one on screen; the pull below would not be the reported flow");
  }

  const screenTail = () =>
    ev(`(async () => { ${finder}
      const api = find("/src/modules/terminal/lib/terminalSessionApi.ts");
      if (!api) return null;
      const terminal = await import(api);
      return terminal.leafScreenTail(${leafId}); })()`);

  const baseline = ((await screenTail()) ?? "").split("PULLED").length - 1;
  const typedAt = Date.now();
  await ev(`(async () => { ${finder}
    const api = find("/src/modules/terminal/lib/terminalSessionApi.ts");
    const terminal = await import(api);
    terminal.submitToLeaf(${leafId}, "git pull --ff-only && echo PULLED");
    return "submitted"; })()`);
  let screen = null;
  for (let i = 0; i < 100; i++) {
    await sleep(400);
    const text = await screenTail();
    if (text && text.split("PULLED").length - 1 > baseline) {
      screen = text;
      break;
    }
  }
  if (screen === null) throw new Error("the pull never printed PULLED in the terminal");
  const pulledAt = Date.now();
  console.log(
    `pull finished ${((pulledAt - typedAt) / 1000).toFixed(1)}s after Enter: ${screen.split("\n").filter((l) => l.trim()).slice(-2).join(" / ")}`,
  );

  // From here nothing is clicked but the tab switch a person makes to look at the panel.
  const wentBack = await click(panelTab());
  const lookedAt = Date.now();
  const first = await rowText();
  console.log(`switched back: ${wentBack}, row the moment it comes to the front: ${first}`);
  let settledAt = first && !/落后\s*\d/.test(first) ? 0 : null;
  let last = first;
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const row = await rowText();
    if (!row || row === last) continue;
    console.log(`  +${((Date.now() - lookedAt) / 1000).toFixed(1)}s  ${row}`);
    last = row;
    if (settledAt === null && !/落后\s*\d/.test(row)) {
      settledAt = (Date.now() - pulledAt) / 1000;
    }
  }
  measured = settledAt;
  console.log(
    settledAt === null
      ? "\nRESULT: the row still said \"落后\" 30s after the panel was looked at - a terminal pull did not reach it"
      : `\nRESULT: the pull ran in the terminal with the panel behind it, and the row was ${
          settledAt === 0
            ? "already right the moment the panel came to the front"
            : `right ${settledAt.toFixed(1)}s after the Enter`
        } (nothing clicked but the tab)`,
  );
  failed = settledAt === null;
} catch (error) {
  failed = true;
  console.log(`\nPROBE FAILED: ${error.message ?? error}`);
} finally {
  // The list back, through the same module that added the fixture, so the app's copy and the file
  // both end up as they were.
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
    // The terminal this probe opened stands in the fixture's directory, and Windows will not delete
    // what a live process is standing in: the session is closed first.
    if (leafId !== null) {
      await ev(`(async () => { ${finder}
        const api = find("/src/modules/terminal/lib/terminalSessionApi.ts");
        const terminal = await import(api);
        terminal.disposeSession(${leafId});
        return "disposed"; })()`).catch(() => null);
      await sleep(1500);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    console.log(`fixture removed: ${root}`);
  } catch {
    console.log(`fixture left at: ${root} (a session is still in it; it is under %TEMP%)`);
  }
  socket.close();
  process.exitCode = failed ? 1 : 0;
  console.log(measured === null ? "" : `measured: ${measured.toFixed(1)}s`);
}
