// 仓库管理（改描述 / 切可见性 / 删仓库 / 克隆到本地）的真机验收。
//
// 默认这一轮会在一个**临时仓库**上真跑完整条链路：读设置 → 改描述 → 切私有再切回公开
// → 手输全名删掉；顺带把 ModelHarbor 克隆到临时目录，核对目录与项目清单。除了这个临时仓库，
// 别的仓库一律不碰（只读它们的设置用来做对照）。
//
// 这台机器上 gh 偶尔会来一次 `Post "https://api.github.com/graphql": EOF`（代理抽风），
// 所以每步都是「点一下 → 轮询确认 → 没成再来一次」，并且把最后一次读到的结果与页面上的
// 浮层文案记进报告，失败时能看出是「真失败」还是「读回失败」。
//
// 只读那一轮（`--readonly`）用可控实验：临时把 Rust 侧 `can_admin` 钉成 false，看设置弹窗
// 是不是真的不给按钮（本机 gh 列出来的仓库全是我自己的 ADMIN；页面里
// `__TAURI_INTERNALS__.invoke` 是 non-configurable，桩也打不进去）。
//
// 用法：node scripts/dev/probes/repo-admin-acceptance.mjs [--readonly] [--port=9222]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECT_READ_ONLY = process.argv.includes("--readonly");
const port =
  process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
/** 验收用的临时仓库：这一轮真的会被删掉。 */
const TEMP_REPO = "Zomcxj/verta-acceptance-tmp";
/** 别人的公开仓库：拿来做「不是管理员」的对照。 */
const OTHERS_REPO = "facebook/react";
/** 克隆验收用的仓库（自己的，验完只删本地目录）。 */
const CLONE_REPO = "Zomcxj/ModelHarbor";
const CLONE_DIR = join(tmpdir(), "verta-repo-admin-acceptance");
const NEW_DESCRIPTION = `Verta 验收写回：这条描述是被软件改的（${Date.now()}）`;
const SHOTS = ".superpowers/shots";
/** 路径比较用：这台机器上同一个目录可能被写成正斜杠或反斜杠。 */
const norm = (path) => String(path ?? "").replace(/\\/g, "/");

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("没找到 page 目标；dev 起了吗？");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) =>
    reject(new Error(String(e.message ?? e))),
  );
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
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "页面内异常",
    );
  }
  return result.result.value;
};

const rectOf = (expression) =>
  evaluate(`(() => {
    const node = ${expression};
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: (node.innerText || node.textContent || "").trim().slice(0, 60) };
  })()`);

const waitFor = async (expression, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await rectOf(expression);
    if (found) return found;
    await sleep(250);
  }
  return null;
};

const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  // `buttons` 不能省：WebView2 少了它就不合成真正的 click。
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(60);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};

const clickButton = async (label, selector) => {
  const rect = await waitFor(modalButton(label, selector), 15000);
  if (!rect) return false;
  await realClick(rect.x, rect.y);
  return true;
};

const pressEscape = async () => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    });
  }
  await sleep(300);
};

const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${SHOTS}/${name}`, Buffer.from(data, "base64"));
};

const toastTexts = () =>
  evaluate(`[...document.querySelectorAll("[data-sonner-toast]")].map((n) => (n.innerText || "").trim()).join(" | ")`);

const modalButton = (
  label,
  selector = '[role="dialog"] button, [role="alertdialog"] button',
) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => (b.innerText || "").trim() === ${JSON.stringify(label)})`;

const dialogText = () =>
  evaluate(
    `[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => d.innerText).join("\\n=== \\n")`,
  );

/** 在弹窗里填一个输入框（React 受控组件要靠原生 setter + input 事件）。 */
const fillInput = (index, value) =>
  evaluate(`(() => {
    const input = [...document.querySelectorAll('[role="dialog"] input')][${index}];
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

/** 直接调后端命令，读这个临时仓库的设置。 */
const readSettings = async (tries = 3) => {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await invokeRaw("github_repo_settings", { repo: TEMP_REPO });
    if (last.kind === "ready") return last;
    await sleep(1200);
  }
  return last;
};

const invokeRaw = (cmd, args) =>
  evaluate(
    `(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})))()`,
  ).then((text) => JSON.parse(text));

/** 项目清单（走应用自己的存储 API，而不是从外面改那份 json）。 */
const STORE_MODULE = "/src/modules/projects/lib/store.ts";
const readProjects = () =>
  evaluate(
    `(async () => JSON.stringify(await (await import(${JSON.stringify(STORE_MODULE)})).loadProjectPaths()))()`,
  ).then((text) => JSON.parse(text));
const writeProjects = (paths) =>
  evaluate(
    `(async () => { const m = await import(${JSON.stringify(STORE_MODULE)}); await m.saveProjectPaths(${JSON.stringify(paths)}); return "ok"; })()`,
  );

/** 独立的第三方核对：直接问 gh 这个仓库还在不在。 */
const ghSaysRepoExists = () => {
  try {
    execFileSync("gh", ["repo", "view", TEMP_REPO, "--json", "name"], {
      stdio: "pipe",
      timeout: 60000,
    });
    return true;
  } catch (e) {
    const text = `${e.stderr ?? ""}${e.stdout ?? ""}${e.message ?? ""}`;
    if (/could not resolve|not found|HTTP 404/i.test(text)) return false;
    // 说不清就往上抛，别把网络错当成「删掉了」。
    throw new Error(`gh repo view 没能给出结论：${text.slice(0, 200)}`);
  }
};

/** 点一次列表上的刷新（应用启动时读的那份可能还没有刚建好的仓库）。 */
const refreshRepos = async () => {
  const button = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /^(刷新|Refresh)$/.test((b.innerText || "").trim()))`,
    15000,
  );
  if (!button) fail("远程仓库面板里没有刷新按钮");
  await realClick(button.x, button.y);
  // 读完之前按钮上写的是「正在读取…」，等它回到「刷新」。
  await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /^(刷新|Refresh)$/.test((b.innerText || "").trim()))`,
    60000,
  );
  await sleep(500);
};

const openRowMenu = async (needle, itemLabel) => {
  await evaluate(`(() => {
    const input = [...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(needle)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  let rowMenu = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").match(/更多操作|More actions/))`,
    20000,
  );
  if (!rowMenu) {
    // 还没读到那一行就刷一次再来（新建的仓库不在启动时那份列表里）。
    await refreshRepos();
    rowMenu = await waitFor(
      `[...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").match(/更多操作|More actions/))`,
      20000,
    );
  }
  if (!rowMenu) fail(`筛选「${needle}」后没有仓库行（或行菜单按钮）`);
  await realClick(rowMenu.x, rowMenu.y);
  const item = await waitFor(
    `[...document.querySelectorAll('[role="menuitem"]')].find((n) => (n.innerText || "").trim() === ${JSON.stringify(itemLabel)})`,
    15000,
  );
  if (!item) fail(`行菜单里没有「${itemLabel}」`);
  await realClick(item.x, item.y);
};

const openAdminDialog = async (needle) => {
  await openRowMenu(needle, "仓库设置…");
  const dialog = await waitFor(
    `[...document.querySelectorAll('[role="dialog"]')].find((d) => /仓库设置/.test(d.innerText || ""))`,
    30000,
  );
  if (!dialog) fail("设置弹窗没打开");
  const input = await waitFor(
    `document.querySelector('[role="dialog"] input')`,
    30000,
  );
  if (!input) fail("设置弹窗里没有输入框（还在读设置？）");
  return dialog;
};

/** 切可见性：点按钮 → 认后果 → 确认 → 轮询确认；读回失败/值没变就再走一遍。 */
const changeVisibility = async (toPrivate) => {
  const label = toPrivate ? "改为私有" : "改为公开";
  const wanted = toPrivate ? "PRIVATE" : "PUBLIC";
  for (let attempt = 0; attempt < 3; attempt++) {
    // 也许上一次其实已经成了，只是读回失败。
    const before = await readSettings();
    if (before.kind === "ready" && before.visibility === wanted) return before;

    if (!(await clickButton(label))) fail(`设置弹窗里没有「${label}」按钮`);
    const confirmDialog = await waitFor(
      `[...document.querySelectorAll('[role="alertdialog"]')].find((d) => /改为${toPrivate ? "私有" : "公开"}/.test(d.innerText || ""))`,
      15000,
    );
    if (!confirmDialog) fail(`「${label}」的确认框没出现`);
    const text = await dialogText();
    report[`confirmText${toPrivate ? "Private" : "Public"}`] = text.slice(0, 300);
    const wants = toPrivate
      ? /协作者|Pages|fork/
      : /提交历史|抓取|镜像/;
    if (!wants.test(text))
      fail(`「${label}」的确认框没把后果说清楚：${text.slice(0, 200)}`);
    if (toPrivate) await shot("repo-admin-visibility-private.png");
    if (!(await clickButton("确认"))) fail("确认框里没有「确认」");
    // 确认框关掉之后，设置弹窗自己必须还在（否则用户得重新打开才能看结果 —— 那是 bug）。
    await sleep(800);
    const stillOpen = await evaluate(
      `[...document.querySelectorAll('[role="dialog"]')].some((d) => /仓库设置/.test(d.innerText || ""))`,
    );
    report[`settingsStillOpenAfter${toPrivate ? "Private" : "Public"}`] = stillOpen;
    if (!stillOpen) fail(`确认「${label}」之后设置弹窗被一起关掉了`);

    for (let i = 0; i < 8; i++) {
      await sleep(1200);
      const back = await readSettings(1);
      report[`visibilityTry${attempt}`] = back;
      if (back.kind === "ready" && back.visibility === wanted) return back;
      // 确认框还开着就是真失败了：把原文记下来再重试一次。
      if (back.kind !== "ready") report.lastVisibilityError = back.error;
    }
    report.toasts = await toastTexts();
  }
  return null;
};

// ---- 起手：清干净上一次留下的弹窗与本地目录 ----
rmSync(CLONE_DIR, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });
/** 验收前那份项目清单；跑完还原，不给用户留痕。 */
let originalProjects = null;

try {
  // ---- 0. 等首屏 ----
  const booted = await waitFor(
    `document.querySelectorAll("button").length > 3 && document.querySelector("button")`,
    120000,
  );
  if (!booted) fail("界面一直没有渲染出来");
  for (let attempt = 0; attempt < 4; attempt++) {
    const open = await evaluate(
      `document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`,
    );
    if (open === 0) break;
    await pressEscape();
    await evaluate(`(() => {
      const close = document.querySelector('[role="dialog"] [data-slot="dialog-close"]');
      if (close) close.click();
      const cancel = [...document.querySelectorAll('[role="alertdialog"] button')]
        .find((b) => /取消|Cancel/.test((b.innerText || "").trim()));
      if (cancel) cancel.click();
      return true;
    })()`);
    await sleep(500);
  }
  const leftover = await evaluate(
    `document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`,
  );
  if (leftover > 0) fail(`起始状态还有 ${leftover} 个弹窗没收掉`);

  // ---- 1. 后端：临时仓库在、别人的仓库不是管理员、查不动的按能改算 ----
  const temp = await invokeRaw("github_repo_settings", { repo: TEMP_REPO });
  const others = await invokeRaw("github_repo_settings", { repo: OTHERS_REPO });
  const missing = await invokeRaw("github_repo_settings", {
    repo: "no-such-owner-xyz/nope",
  });
  report.backend = { temp, others, missing };
  if (EXPECT_READ_ONLY) {
    // 这一轮后端被临时钉成「不是管理员」：拿自己的仓库验那一下真的生效了。
    const mine = await invokeRaw("github_repo_settings", { repo: "Zomcxj/ModelHarbor" });
    report.readonlyBackend = mine;
    if (mine.kind !== "ready" || mine.canAdmin)
      fail(`--readonly 这轮后端应该是不可管理：${JSON.stringify(mine)}`);
  } else {
    if (temp.kind !== "ready" || !temp.canAdmin)
      fail(`临时仓库应该是 ready 且可管理：${JSON.stringify(temp)}`);
    if (temp.visibility !== "PUBLIC" && temp.visibility !== "PRIVATE")
      fail(`临时仓库的可见性说不清：${JSON.stringify(temp.visibility)}`);
  }
  if (others.kind !== "ready" || others.canAdmin)
    fail(`facebook/react 不该算管理员：${JSON.stringify(others)}`);
  if (missing.canAdmin !== true)
    fail(`查不动时应该按「能改」算：${JSON.stringify(missing)}`);

  // ---- 2. 打开远程仓库标签页 ----
  const remotesButton = await waitFor(
    `[...document.querySelectorAll("button")].find((b) => /远程仓库|Remote repositories/.test(b.getAttribute("title") || ""))`,
  );
  if (!remotesButton) fail("页头里没有远程仓库入口");
  await realClick(remotesButton.x, remotesButton.y);
  const filterBox = await waitFor(
    `[...document.querySelectorAll("input[placeholder]")].find((i) => /筛选仓库|Filter repositories/.test(i.getAttribute("placeholder") || ""))`,
  );
  if (!filterBox) fail("远程仓库列表没有出现");

  // ---- 3. 只读那一轮：非管理员时设置弹窗不给任何改动入口 ----
  if (EXPECT_READ_ONLY) {
    await openAdminDialog("ModelHarbor");
    const labels = JSON.parse(
      await evaluate(`JSON.stringify(
        [...document.querySelectorAll('[role="dialog"] button')]
          .map((b) => (b.innerText || "").trim())
          .filter(Boolean)
      )`),
    );
    report.readOnlyButtons = labels;
    for (const label of ["保存描述", "改为公开", "改为私有", "删除仓库"]) {
      if (labels.includes(label))
        fail(`只读时不该有「${label}」：${JSON.stringify(labels)}`);
    }
    const hintShown = await evaluate(
      `document.body.innerText.includes("你不是这个仓库的管理员")`,
    );
    if (!hintShown) fail("只读时应该有一句提示");
    report.readOnlyHint = hintShown;
    await shot("repo-admin-readonly.png");
    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
    socket.close();
    process.exit(0);
  }

  // ---- 4. 改描述 ----
  await openAdminDialog("verta-acceptance-tmp");
  const prefilled = await evaluate(
    `document.querySelector('[role="dialog"] input').value`,
  );
  report.prefilledDescription = prefilled;
  if (prefilled !== (temp.description ?? ""))
    fail(
      `描述输入框没有预填当前描述：弹窗里是 ${JSON.stringify(prefilled)}，后端读到 ${JSON.stringify(temp.description)}`,
    );
  await shot("repo-admin-settings.png");

  let afterSave = null;
  for (let attempt = 0; attempt < 3 && !afterSave; attempt++) {
    if (!(await fillInput(0, NEW_DESCRIPTION))) fail("找不到描述输入框");
    if (!(await clickButton("保存描述"))) fail("没有「保存描述」按钮");
    for (let i = 0; i < 8 && !afterSave; i++) {
      await sleep(1200);
      const back = await readSettings(1);
      report[`saveTry${attempt}`] = back;
      if (back.kind === "ready" && back.description === NEW_DESCRIPTION) {
        afterSave = back;
      } else if (back.kind !== "ready") {
        report.lastSaveError = back.error;
      }
    }
  }
  report.afterSave = afterSave;
  report.toasts = await toastTexts();
  if (!afterSave)
    fail(`描述没写回 GitHub（最后一次读到：${JSON.stringify(report.lastSaveError ?? report.saveTry1 ?? report.saveTry0)}）`);

  // ---- 5. 可见性：先切到相反那一档，再切回来（两个方向的确认框都要过一遍） ----
  const startedPrivate = temp.visibility === "PRIVATE";
  report.startedPrivate = startedPrivate;

  const flipped = await changeVisibility(!startedPrivate);
  report.afterFirstFlip = flipped;
  if (!flipped) fail(`可见性没切成 ${startedPrivate ? "公开" : "私有"}`);

  const back = await changeVisibility(startedPrivate);
  report.afterSecondFlip = back;
  if (!back) fail(`可见性没切回 ${startedPrivate ? "私有" : "公开"}`);

  // ---- 6. 克隆到本地（行菜单入口要预填地址与「已有项目同一级」的目录） ----
  // 「落在已有项目同一级」得先有一条项目：用应用自己的存储 API 种一条（原清单记下来，跑完还原）。
  originalProjects = await readProjects();
  report.projectsBefore = originalProjects;
  await writeProjects([...originalProjects, CLONE_DIR]);

  await pressEscape();
  await openRowMenu("ModelHarbor", "克隆到本地…");
  const cloneDialog = await waitFor(
    `[...document.querySelectorAll('[role="dialog"]')].find((d) => /克隆/.test(d.innerText || ""))`,
    20000,
  );
  if (!cloneDialog) fail("克隆弹窗没打开");
  const cloneFields = await (async () => {
    for (let i = 0; i < 20; i++) {
      const values = JSON.parse(
        await evaluate(`JSON.stringify(
          [...document.querySelectorAll('[role="dialog"] input')].map((i) => i.value)
        )`),
      );
      if (values.length >= 2 && values[0]) return values;
      await sleep(300);
    }
    return [];
  })();
  report.cloneFields = cloneFields;
  if (!String(cloneFields[0] ?? "").includes(CLONE_REPO))
    fail(`克隆地址没有预填：${JSON.stringify(cloneFields)}`);
  // 清单里有一条可用项目（验收开跑前由脚本种下），所以目标目录该落在它的同一级。
  if (!norm(cloneFields[1]).endsWith("ModelHarbor"))
    fail(`目标目录没按「已有项目同一级」预填：${JSON.stringify(cloneFields)}`);

  // 真正落地换成验收自己的临时目录，别写进用户平时放项目的地方。
  if (!(await fillInput(1, CLONE_DIR))) fail("找不到克隆目标目录输入框");
  if (!(await clickButton("克隆"))) fail("克隆弹窗里没有「克隆」按钮");
  // `.git` 是克隆刚开始就出现的，所以等的是弹窗自己关掉（= 命令跑完），不是 `.git`。
  const cloneFinished = await (async () => {
    const deadline = Date.now() + 300000;
    while (Date.now() < deadline) {
      const open = await evaluate(
        `[...document.querySelectorAll('[role="dialog"]')].some((d) => /克隆仓库/.test(d.innerText || ""))`,
      );
      if (!open) return true;
      await sleep(1000);
    }
    return false;
  })();
  if (!cloneFinished) {
    report.cloneDialogText = await dialogText();
    fail("克隆弹窗一直没关（克隆失败或被卡住）");
  }
  if (!existsSync(join(CLONE_DIR, ".git")))
    fail(`克隆目录里没有 .git：${CLONE_DIR}`);
  report.cloned = {
    entries: readdirSync(CLONE_DIR).slice(0, 8),
    hasGit: existsSync(join(CLONE_DIR, ".git")),
  };
  await shot("repo-admin-clone.png");
  const listedToast = await (async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(`document.body.innerText.includes("已克隆并加入项目清单")`))
        return true;
      await sleep(500);
    }
    return false;
  })();
  report.cloneListed = listedToast;
  if (!listedToast) fail("克隆成功后没有「已加入项目清单」的提示");

  // 清单里现在有刚才那一条（就是 CLONE_DIR），再开一个仓库的克隆弹窗，
  // 目标目录该落在它的同一级 —— 这才是「复用项目页克隆」那条要求里真正要验的预填。
  await pressEscape();
  await openRowMenu("LabelForge", "克隆到本地…");
  const secondDialog = await waitFor(
    `[...document.querySelectorAll('[role="dialog"]')].find((d) => /克隆/.test(d.innerText || ""))`,
    20000,
  );
  if (!secondDialog) fail("第二个克隆弹窗没打开");
  const secondFields = await (async () => {
    for (let i = 0; i < 20; i++) {
      const values = JSON.parse(
        await evaluate(`JSON.stringify(
          [...document.querySelectorAll('[role="dialog"] input')].map((i) => i.value)
        )`),
      );
      if (values.length >= 2 && values[0]) return values;
      await sleep(300);
    }
    return [];
  })();
  report.cloneFieldsBeside = secondFields;
  const beside = norm(secondFields[1]);
  const wanted = norm(join(tmpdir(), "LabelForge"));
  if (beside !== wanted)
    fail(`目标目录没有落在已有项目（${CLONE_DIR}）同一级：${JSON.stringify(secondFields)}，期望 ${wanted}`);
  await pressEscape();

  // ---- 7. 删仓库：先输错（按钮不给），再输全名 ----
  await pressEscape();
  await openAdminDialog("verta-acceptance-tmp");
  const deleteButtonState = async () => {
    const rect = await rectOf(modalButton("删除仓库"));
    if (!rect) return null;
    const disabled = await evaluate(
      `(() => { const b = ${modalButton("删除仓库")}; return b ? b.disabled : null; })()`,
    );
    return { ...rect, disabled };
  };

  if (!(await fillInput(1, "verta-acceptance"))) fail("找不到删除确认输入框");
  await sleep(400);
  const wrongTyped = await deleteButtonState();
  report.wrongTyped = wrongTyped;
  if (!wrongTyped || !wrongTyped.disabled)
    fail(`名字不对时删除按钮应该不可点：${JSON.stringify(wrongTyped)}`);

  if (!(await fillInput(1, TEMP_REPO))) fail("找不到删除确认输入框");
  await sleep(400);
  const rightTyped = await deleteButtonState();
  report.rightTyped = rightTyped;
  if (!rightTyped || rightTyped.disabled)
    fail(`名字对了删除按钮应该可点：${JSON.stringify(rightTyped)}`);
  await shot("repo-admin-delete-armed.png");

  await realClick(rightTyped.x, rightTyped.y);
  const deleteConfirm = await waitFor(
    `[...document.querySelectorAll('[role="alertdialog"]')].find((d) => /确认删除/.test(d.innerText || ""))`,
    15000,
  );
  if (!deleteConfirm) fail("删除确认框没出现");
  await shot("repo-admin-delete-confirm.png");
  if (!(await clickButton("确认"))) fail("删除确认框里没有「确认」");

  // 独立核对：直接问 gh 这个仓库还在不在（后端自己也会回查一次 404）。
  let gone = false;
  for (let i = 0; i < 15 && !gone; i++) {
    await sleep(2000);
    gone = !ghSaysRepoExists();
  }
  report.existedAfterDelete = !gone;
  if (!gone) fail("删除之后 gh 还能看到这个仓库");
  report.toastsAfterDelete = await toastTexts();

  // 列表里那一行也该没了。注意：独立 gh 探到的「没了」比应用自己的回查确认更早，
  // 所以要等应用这边跟上，不能立刻判。
  const rowGone = await (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const listed = await evaluate(
        `[...document.querySelectorAll("table tbody tr")].some((tr) => (tr.innerText || "").includes(${JSON.stringify(TEMP_REPO)}))`,
      );
      if (!listed) return true;
      await sleep(1000);
    }
    return false;
  })();
  report.rowGone = rowGone;
  if (!rowGone) fail("删掉之后列表里还留着那一行");

  const adminClosed = await (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const open = await evaluate(
        `[...document.querySelectorAll('[role="dialog"]')].some((d) => /仓库设置/.test(d.innerText || ""))`,
      );
      if (!open) return true;
      await sleep(1000);
    }
    return false;
  })();
  report.adminDialogClosedAfterDelete = adminClosed;
  if (!adminClosed) fail("删完之后设置弹窗还开着");

  report.ok = true;
  if (originalProjects !== null) {
    await writeProjects(originalProjects).catch(() => {});
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // 失败也要还原清单：`fail()` 会直接退进程，所以得在这里先还原。
  if (originalProjects !== null) {
    await writeProjects(originalProjects).catch(() => {});
  }
  fail(error instanceof Error ? error.message : String(error));
} finally {
  socket.close();
}
