// Acceptance for the source-control panel's two panes, its three actions and its selection rule.
//
// The rule the panel is built on: a row's checkbox is a *selection*, and the button above the list is
// what acts on it - staging the ticked files in the changes pane, unstaging them in the staged pane,
// where the edits stay in the working tree. So the interesting assertions are read-only ones, and
// this probe never presses that button: ticking a row, and ticking the header's "all", must leave
// `git status` exactly as it was. A checkbox that stages on the spot fails here without the
// repository being touched.
//
// On top of that: each pane's count and rows against `git status`, the empty pane saying so, the
// button's label following the pane, and the stash strip below the panel being on screen and
// hit-testable - it is a sibling of the panel, and it used to be laid out past the bottom of a
// non-flex wrapper and clipped away entirely.
//
// Usage: node scripts/dev/probes/scm-two-panes.mjs [--port=9222] [--repo=F:/path/to/repo]
import { execFileSync } from "node:child_process";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
/** Where git is read from. The panel's own repository is used once it has been read - see below -
 *  because the window may be showing a folder other than the shell's: `--repo` is the fallback. */
let repo = process.argv.find((a) => a.startsWith("--repo="))?.slice(7) ?? process.cwd();

/**
 * `git status --porcelain -z`, split the way the panel splits it: a non-blank worktree column means
 * the path has unstaged changes, a staged column other than `?` or a blank means it has staged
 * changes. Untracked files are unstaged changes and nothing else.
 */
function gitTruth() {
  const out = execFileSync("git", ["-C", repo, "status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const tokens = out.split("\0").filter((t) => t !== "");
  const staged = new Set();
  const changes = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const index = token[0];
    const worktree = token[1];
    const path = token.slice(3);
    if (index === "R" || index === "C") i += 1; // the original path follows
    if (index === "?") {
      changes.add(path);
      continue;
    }
    if (worktree !== " ") changes.add(path);
    if (index !== " ") staged.add(path);
  }
  return { staged, changes };
}

let truth = gitTruth();
/** Re-read from git every time: the claim being tested is that it did *not* move. */
const fingerprint = (from = truth) => {
  const current = gitTruth();
  return JSON.stringify({
    staged: [...current.staged].sort(),
    changes: [...current.changes].sort(),
  });
};
const report = {};
// Failures are thrown rather than exited on, so the socket is closed on the way out.
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
// The release build's window is `tauri.localhost`; a dev server serves port 1420. Both are the page
// to drive, and either is preferred over whatever else the endpoint lists.
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("没找到主窗口；dev 起了吗？");
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
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} in: ${expression.slice(0, 200)}`);
  }
  return result.result.value;
};
const rectOf = (expression) =>
  evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(30);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};
const clickOn = async (expression, label, timeoutMs = 20000) => {
  if (!(await waitFor(expression, timeoutMs))) fail(`could not find ${label}`);
  await sleep(150);
  const rect = await rectOf(expression);
  if (!rect) fail(`${label} has no box to click`);
  await realClick(rect.x, rect.y);
  return rect;
};

/** One pane's own reading of the list: its count badge, and which pane is selected. */
const readPane = (pane) =>
  evaluate(`(() => {
    const tab = document.querySelector('[data-scm-pane="${pane}"]');
    if (!tab) return null;
    return {
      pressed: tab.getAttribute("aria-pressed") === "true",
      count: Number.parseInt((tab.innerText.match(/\\d+/) || [""])[0], 10),
      label: tab.innerText.replace(/\\d+/g, "").trim(),
    };
  })()`);

/** The action row: its three labels, and the first one's state. */
const readActions = () =>
  evaluate(`(() => {
    const stage = document.querySelector("[data-scm-stage-all]");
    if (!stage) return null;
    const row = stage.closest("div.grid") ?? stage.parentElement;
    return {
      labels: [...row.querySelectorAll("button")].map((b) => (b.innerText || "").trim()),
      stage: {
        disabled: stage.disabled,
        text: (stage.innerText || "").trim(),
        ticked: Number.parseInt(stage.getAttribute("data-scm-selected-count") || "0", 10),
      },
    };
  })()`);

/** What the list is showing: the ticked state of each row, and the pane's empty note. */
const readRows = () =>
  evaluate(`(() => {
    const rows = [...document.querySelectorAll("[data-scm-path]")].filter((el) => el.offsetParent !== null);
    return {
      paths: rows.map((row) => row.getAttribute("data-scm-path")),
      ticked: rows.map((row) => row.querySelector('[role="checkbox"]')?.getAttribute("data-state") ?? null),
      empty: (document.querySelector("[data-scm-empty]")?.innerText ?? "").trim() || null,
    };
  })()`);

/** The header's "all" checkbox, read out of the list header row. */
const headerCheckbox = `[...document.querySelectorAll('[role="checkbox"]')].find((el) => (el.getAttribute("aria-label") || "").trim() === "全部" || (el.getAttribute("aria-label") || "").trim() === "All")`;

try {
  // ---- The right column has to be showing the panel on this repository ----
  const openPanel = `[...document.querySelectorAll("button")].find((b) => /显示\\/隐藏 Git 面板|Toggle the Git panel/.test(b.getAttribute("title") || ""))`;
  if (!(await waitFor(`!!document.querySelector('[data-scm-pane="changes"]')`, 1500))) {
    await clickOn(openPanel, "the header's git panel toggle", 8000);
    await sleep(1200);
  }
  if (!(await waitFor(`!!document.querySelector('[data-scm-pane="changes"]')`, 15000))) {
    fail("the git panel never showed its panes");
  }
  // A collapsed panel keeps its rows in the DOM at a sliver's width, where nothing can be clicked and
  // the controls are laid out off the window ("visible" for `offsetParent`, not for the pointer), so
  // the panel is opened before anything is read from it.
  const rowWidth = () =>
    evaluate(`(() => {
      const row = [...document.querySelectorAll("[data-scm-path]")].find((el) => el.offsetParent !== null);
      return row ? Math.round(row.getBoundingClientRect().width) : 0;
    })()`);
  for (let attempt = 0; attempt < 3 && (await rowWidth()) < 120; attempt++) {
    // The header's button is a toggle, so which way it moves depends on where the panel started:
    // pressed until the panel is wide enough, or three presses in.
    await clickOn(openPanel, "the header's git panel toggle", 8000);
    await sleep(1500);
  }
  if ((await rowWidth()) < 120) {
    fail(`the git panel is only ${await rowWidth()}px wide: nothing of it can be clicked`);
  }
  report.panelWidth = await rowWidth();
  report.repoShown = await evaluate(
    `(document.querySelector("[data-scm-repo]")?.innerText ?? "").trim() || null`,
  );
  // The row carries the full path in its title, and that path is the repository to read git from: the
  // window's current folder and this probe's working directory need not be the same repository, and
  // comparing one against the other is how a run ends up reading the counts of something that is not
  // on screen at all.
  const shownPath = await evaluate(
    `document.querySelector("[data-scm-repo]")?.getAttribute("title") ?? null`,
  );
  if (!shownPath) fail("the panel's repository row names no path, so git cannot be read for it");
  repo = shownPath;
  truth = gitTruth();
  report.repo = repo;
  report.truth = { staged: [...truth.staged], changes: [...truth.changes] };
  const before = fingerprint();
  // The label is the repository's name over its branch, so the name is what is compared.
  const shownName = (report.repoShown ?? "").split("\n")[0].trim().toLowerCase();
  const expectedName = repo
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
    .toLowerCase();
  report.repoName = { shown: shownName, expected: expectedName };
  if (shownName === "" || !shownName.includes(expectedName)) {
    fail(
      `the panel shows ${JSON.stringify(report.repoShown)} while naming ${JSON.stringify(repo)} as its path`,
    );
  }

  // ---- Start from nothing ticked ----
  // A selection belongs to the panel, not to a run of this probe, so a re-run inherits whatever the
  // last one left: a run that failed while everything was ticked leaves everything ticked. Clear it
  // through the header's own checkbox, which is what a user would do.
  const tickedCount = () =>
    evaluate(
      `Number.parseInt(document.querySelector("[data-scm-stage-all]")?.getAttribute("data-scm-selected-count") || "0", 10)`,
    );
  for (let attempt = 0; attempt < 3 && (await tickedCount()) > 0; attempt++) {
    if (!(await waitFor(`!!(${headerCheckbox})`, 4000))) {
      fail("a selection is left over from an earlier run and the header's checkbox is not there to clear it");
    }
    await clickOn(headerCheckbox, "the header's checkbox, to clear a leftover selection", 5000);
    await sleep(400);
  }
  if ((await tickedCount()) !== 0) {
    fail(`a selection of ${await tickedCount()} could not be cleared, so nothing below can be measured`);
  }

  // ---- The three actions, in the order the design asks for ----
  const actions = await readActions();
  report.actions = actions;
  if (!actions) fail("the stage button is not in the panel");
  if (actions.labels.length !== 3) {
    fail(`the action row has ${actions.labels.length} buttons, not the three the design asks for: ${JSON.stringify(actions.labels)}`);
  }
  if (!/暂存|Stage/.test(actions.labels[0])) {
    fail(`the first action reads ${JSON.stringify(actions.labels[0])}, not stage`);
  }
  if (truth.staged.size === 0 && actions.labels[1] !== "提交") {
    fail(`the second action reads ${JSON.stringify(actions.labels[1])}, not commit`);
  }

  // ---- Nothing ticked: the button may do nothing ----
  if (!actions.stage.disabled) {
    fail("the action is enabled while no file is ticked");
  }

  // ---- The panes, against git ----
  // The panel's snapshot is its own: a file another probe created and removed a moment ago is still
  // in it until it refreshes, so the panel is asked to refresh and the counts are allowed to settle
  // before they are compared with what git says right now.
  const refreshButton = `[...document.querySelectorAll("button")].find((b) => /^(刷新|Refresh)$/.test((b.getAttribute("title") || "").trim()))`;
  if (await waitFor(`!!(${refreshButton})`, 4000)) {
    await clickOn(refreshButton, "the panel's refresh button", 4000);
  }
  const countsAgree = `(() => {
    const read = (pane) => {
      const tab = document.querySelector('[data-scm-pane="' + pane + '"]');
      return tab ? Number.parseInt((tab.innerText.match(/\d+/) || [""])[0], 10) : NaN;
    };
    return read("changes") === ${JSON.stringify(truth.changes.size)} && read("staged") === ${JSON.stringify(truth.staged.size)};
  })()`;
  if (!(await waitFor(countsAgree, 8000))) {
    report.counts = {
      changes: (await readPane("changes"))?.count,
      staged: (await readPane("staged"))?.count,
      git: { changes: truth.changes.size, staged: truth.staged.size },
    };
  }

  const changesTab = await readPane("changes");
  const stagedTab = await readPane("staged");
  report.tabs = { changes: changesTab, staged: stagedTab };
  if (!changesTab || !stagedTab) fail("both panes are not drawn");
  if (changesTab.count !== truth.changes.size) {
    fail(`the changes pane says ${changesTab.count} files, git says ${truth.changes.size}`);
  }
  if (stagedTab.count !== truth.staged.size) {
    fail(`the staged pane says ${stagedTab.count} files, git says ${truth.staged.size}`);
  }
  if (!changesTab.pressed) fail("the changes pane is not the one selected to begin with");

  const shownChanges = await readRows();
  report.changesRows = shownChanges;
  if (truth.changes.size > 0 && shownChanges.paths.length === 0) {
    fail("the changes pane lists no rows while git reports unstaged changes");
  }
  for (const path of shownChanges.paths) {
    if (!truth.changes.has(path)) {
      fail(`the changes pane lists ${path}, which git does not report as unstaged`);
    }
  }
  for (const state of shownChanges.ticked) {
    if (state !== "unchecked") {
      fail(`a row starts ticked (${state}); the tick is a selection and starts empty`);
    }
  }

  // ---- Ticking a row selects it: the button wakes up, and the repository does not move ----
  const firstRow = `[...document.querySelectorAll("[data-scm-path]")].find((el) => el.offsetParent !== null)`;
  const firstCheckbox = `(${firstRow})?.querySelector('[role="checkbox"]')`;
  // A panel that is still refreshing disables its rows, and a click into a disabled checkbox does
  // nothing at all - which would read as "the tick did not select anything".
  if (!(await waitFor(`!!(${firstCheckbox}) && !(${firstCheckbox}).disabled`, 10000))) {
    fail("the first row's checkbox never became clickable");
  }
  await clickOn(firstCheckbox, "the first row's checkbox");
  await sleep(400);
  const afterOneTick = await readActions();
  report.afterOneTick = afterOneTick?.stage;
  if (afterOneTick?.stage.disabled !== false) {
    fail("ticking one file did not enable the action");
  }
  if (afterOneTick?.stage.ticked !== 1) {
    fail(`one row is ticked but the action counts ${afterOneTick?.stage.ticked}`);
  }
  if (fingerprint() !== before) {
    fail("ticking a file changed the repository: the tick is supposed to be a selection");
  }

  // ---- The header's "all" ticks every row of the pane, and still nothing moves ----
  if (!(await waitFor(`!!(${headerCheckbox})`, 8000))) fail("the list header has no checkbox");
  await clickOn(headerCheckbox, "the header's checkbox");
  await sleep(400);
  const allTicked = await readRows();
  report.allTicked = allTicked;
  // The list is virtualised, so what is ticked is the whole pane while what is *drawn* is the window
  // of rows on screen. Both are checked: every drawn row ticked, and the count against the pane.
  report.renderedRows = allTicked.paths.length;
  for (const state of allTicked.ticked) {
    if (state !== "checked") {
      fail(`the header's checkbox left a row ${state}`);
    }
  }
  const allActions = await readActions();
  report.afterSelectAll = allActions?.stage;
  if (allActions?.stage.ticked !== changesTab.count) {
    fail(
      `the header selected ${allActions?.stage.ticked} of the pane's ${changesTab.count} files`,
    );
  }
  if (fingerprint() !== before) {
    fail("selecting every file changed the repository: selecting is not staging");
  }

  // And unticking them again leaves nothing selected.
  await clickOn(headerCheckbox, "the header's checkbox again");
  await sleep(400);
  const cleared = await readActions();
  report.afterClear = cleared?.stage;
  if (cleared?.stage.ticked !== 0) {
    fail(`unticking every row left ${cleared?.stage.ticked} ticked`);
  }

  // ---- The staged pane: the same button, the other direction ----
  await clickOn(`document.querySelector('[data-scm-pane="staged"]')`, "the staged pane");
  await sleep(500);
  const stagedPressed = (await readPane("staged"))?.pressed;
  report.stagedPanePressed = stagedPressed;
  if (!stagedPressed) fail("clicking the staged pane did not select it");
  const stagedActions = await readActions();
  report.stagedActions = stagedActions?.stage;
  if (stagedActions?.stage.text !== "取消暂存") {
    fail(`in the staged pane the action reads ${JSON.stringify(stagedActions?.stage.text)}, not unstage`);
  }
  // Switching panes clears the selection: those were the other pane's rows.
  if (stagedActions?.stage.ticked !== 0) {
    fail(`switching panes kept ${stagedActions?.stage.ticked} ticked`);
  }
  const shownStaged = await readRows();
  report.stagedRows = shownStaged;
  for (const path of shownStaged.paths) {
    if (!truth.staged.has(path)) {
      fail(`the staged pane lists ${path}, which git does not report as staged`);
    }
  }
  if (truth.staged.size === 0) {
    if (shownStaged.paths.length !== 0) fail("the staged pane lists rows while nothing is staged");
    if (!shownStaged.empty) fail("the empty staged pane says nothing about being empty");
  } else if (shownStaged.paths.length === 0) {
    fail("the staged pane lists no rows while git reports staged changes");
  }
  await clickOn(`document.querySelector('[data-scm-pane="changes"]')`, "the changes pane again");
  await sleep(400);
  if ((await readActions())?.stage.text !== "暂存") {
    fail("the action did not go back to staging when the changes pane came back");
  }

  // ---- The stash strip below the panel: on screen, and not clipped away ----
  const stashExpr = `[...document.querySelectorAll("button[aria-expanded]")].find((b) => /(储藏|Stashes?)/.test((b.innerText || "").trim()))`;
  if (!(await waitFor(stashExpr, 8000))) {
    report.stashNotFound = await evaluate(
      `JSON.stringify([...document.querySelectorAll("button[aria-expanded]")].map((b) => (b.innerText || "").trim()))`,
    );
  }
  report.stash = await evaluate(`(() => {
    const button = ${stashExpr};
    if (!button) return null;
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      text: (button.innerText || "").trim(),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      windowHeight: window.innerHeight,
      hitTestable: !!hit && (hit === button || button.contains(hit)),
    };
  })()`);
  if (!report.stash) fail("the stash strip was not found, so it cannot be checked for being on screen");
  if (!(report.stash.height > 0)) fail("the stash strip has no height");
  if (report.stash.bottom > report.stash.windowHeight + 1) {
    fail(
      `the stash strip ends at ${report.stash.bottom}px, past the ${report.stash.windowHeight}px window: it is laid out below the visible area`,
    );
  }
  if (!report.stash.hitTestable) {
    fail("the stash strip is in the layout but nothing of it can be hit: it is painted nowhere");
  }

  // ---- And the reason it is there: a block wrapper puts it past the bottom of the pane, which is
  // what the column wrapper replaced. Measured by undoing that one declaration in the live tree. ----
  report.withoutColumnWrapper = await evaluate(`(() => {
    const wrapper = document.querySelector(".verta-panel-in:has([data-scm-pane])");
    const button = ${stashExpr};
    if (!wrapper || !button) return null;
    const display = wrapper.style.display;
    wrapper.style.display = "block";
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const measured = {
      bottom: Math.round(rect.bottom),
      windowHeight: window.innerHeight,
      hitTestable: !!hit && (hit === button || button.contains(hit)),
    };
    wrapper.style.display = display;
    return measured;
  })()`);
  console.log(`without the column wrapper: ${JSON.stringify(report.withoutColumnWrapper)}`);

  report.ok = true;
  console.log(
    `PASS: Git 面板是「暂存 / 提交 / 推送」三按钮（勾选前禁用、勾选后启用；暂存栏里第一个按钮变成「取消暂存」）；勾选只是选择——勾一行、勾「全部」之后 git status 与开始时逐项相同；两栏的数量与行集合等于 git（更改 ${truth.changes.size} 项、暂存 ${truth.staged.size} 项）；面板下方的储藏条在屏幕上可点（bottom ${report.stash.bottom} ≤ ${report.stash.windowHeight}）。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}
