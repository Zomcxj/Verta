// Acceptance for the HTML render stop, measured on a page that reads itself back.
//
// The stop hands the file to a sandboxed iframe over the asset protocol, so the questions are about
// what the page can do in there: does it render, do its own stylesheets apply - the one beside it and
// the one a directory up - does its script run, and can that script reach the Tauri IPC or navigate
// the window it is drawn in. None of that can be asked from the parent's side: the frame is a
// different origin, and in this webview a different process, so the fixture answers on request over
// `postMessage` with raw facts about itself (a computed colour, a global it set, the answer of an
// attempted IPC call) which the probe asserts on.
//
// The second half does the same with a real page, copied in with that harness appended: the point is
// that a 900-line page with its own styles and its own script renders and still works - including its
// own theme button, which the harness presses from inside and reads back.
//
// Everything lives in a directory of its own under the system temp directory, and it is opened by
// handing the app the path the way an "Open With" does (`verta:open-file`), not by driving the file
// tree: the tree is showing whatever folder the user is working in, and writing a fixture into that
// folder would put probe files in their project - measured the hard way, on a window whose explorer
// was pointed at the Desktop. The directory and the tabs this opened are removed at the end.
//
// Usage: node scripts/dev/probes/html-preview.mjs [--port=9222] [--real=C:/path/to/page.html]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const realPath =
  process.argv.find((a) => a.startsWith("--real="))?.slice(7) ??
  "C:/Users/cxj/Desktop/终端智能体兵器谱-液态玻璃.html";
const FILE = "page.html";
const REAL_FILE = "real-page.html";
const HEAD_COLOR = "rgb(12, 34, 56)";
const SIBLING_COLOR = "rgb(0, 128, 0)";
const MARK = "html-preview-probe";
const OUTSIDE_ERROR = `<link id="outside" rel="stylesheet" href="../outside.css" onerror="window.__OUTSIDE_FAILED__ = true" />`;

const REPORT_SCRIPT = `<script>
  window.addEventListener("message", async () => {
    const colorOf = (id) => {
      const node = document.getElementById(id);
      return node ? getComputedStyle(node).color : null;
    };
    const sheets = [...document.styleSheets].map((sheet) => {
      try {
        return { href: sheet.href, rules: sheet.cssRules.length };
      } catch (error) {
        return { href: sheet.href, rules: String(error) };
      }
    });
    // Which commands the frame can call. It shares the webview's bridge object - __TAURI_INTERNALS__ is
    // injected into it - so the boundary is the ACL, and this is what measures it: every one of these
    // is read-only, and none of them may be answered. C:/Windows/win.ini is a file outside anything
    // the app was pointed at, which is the point.
    const ipc = [];
    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
      const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
      for (const [label, command, args] of [
        ["workspace_current_dir", "workspace_current_dir", {}],
        ["fs_read_file", "fs_read_file", { path: "C:/Windows/win.ini" }],
        ["fs_read_dir", "fs_read_dir", { path: "C:/Windows" }],
      ]) {
        try {
          const value = await invoke(command, args);
          ipc.push(label + ": ALLOWED " + JSON.stringify(value).slice(0, 60));
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          ipc.push(label + ": refused" + (/ACL/.test(message) ? " by ACL" : ""));
        }
      }
    } else {
      ipc.push("no bridge");
    }
    let parentFrame = "null";
    try {
      parentFrame = window.frameElement ? "reachable" : "null";
    } catch (error) {
      parentFrame = "cross-origin";
    }
    // Its own button, pressed from inside: a page is not "rendered" if its script cannot run. Pressed
    // twice, because the page keeps its choice - localStorage is per origin and every rendered file
    // shares one - so a probe that left it flipped would change what the user sees next time.
    const toggle = document.getElementById("themeToggle");
    const theme = document.documentElement.getAttribute("data-theme");
    if (toggle) toggle.click();
    const themeAfter = document.documentElement.getAttribute("data-theme");
    if (toggle) toggle.click();
    const themeRestored = document.documentElement.getAttribute("data-theme");
    window.parent.postMessage(
      {
        mark: ${JSON.stringify(MARK)},
        title: document.title,
        text: (document.body.innerText || "").replace(/\\s+/g, " ").trim(),
        textLength: (document.body.innerText || "").length,
        headColor: colorOf("head"),
        siblingColor: colorOf("sibling"),
        scriptRan: window.__PROBE_RAN__ === true,
        outsideFailed: window.__OUTSIDE_FAILED__ === true,
        sheets,
        ipc,
        parentFrame,
        errors: (window.__PAGE_ERRORS__ || []).slice(0, 5),
        theme,
        themeAfter,
        themeRestored,
      },
      "*",
    );
  });
</script>`;

const PAGE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>probe</title>
    <link rel="stylesheet" href="./style.css" />
    ${OUTSIDE_ERROR}
  </head>
  <body>
    <h1 id="head">Probe heading</h1>
    <p id="sibling">script has not run</p>
    <script src="./script.js"></script>
    ${REPORT_SCRIPT}
  </body>
</html>
`;

const report = {};
// Failures are thrown rather than exited on, so the socket is closed and the fixture removed on the
// way out.
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost")) ??
  targets.find((t) => t.type === "page");
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
const waitFor = async (expression, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`(() => { const n = ${expression}; return n ? true : false; })()`)) {
      return true;
    }
    await sleep(250);
  }
  return false;
};
const waitForValue = async (expression, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
};
const visibleButton = (pattern) =>
  `[...document.querySelectorAll("button")].filter((b) => !b.closest('[aria-hidden="true"]')).find((b) => ${pattern}.test((b.innerText || "").trim()))`;

/**
 * Clicks a control and checks that it did something, because a pointer click is not reliable here.
 *
 * A real click is what a user does, so it is tried first and twice. It was measured to be flaky on
 * these view stops - the button can be replaced by a React render between press and release, and the
 * browser then delivers the click to the container, so the stop silently does nothing - and the
 * fallback is the stop's own click handler. Which one worked is collected for the report.
 */
const clicks = [];
const clickVerified = async (expression, verifyExpression, label) => {
  if (!(await waitFor(`!!(${expression})`, 15000))) fail(`could not find ${label}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const rect = await evaluate(`(() => {
      const node = ${expression};
      if (!node) return null;
      const r = node.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (rect) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: rect.x,
        y: rect.y,
        button: "none",
      });
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: rect.x,
        y: rect.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await sleep(30);
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: rect.x,
        y: rect.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
    }
    if (await waitFor(verifyExpression, 3000)) {
      clicks.push(`${label}: pointer`);
      return;
    }
  }
  const clicked = await evaluate(
    `(() => { const node = ${expression}; if (!node) return false; node.click(); return true; })()`,
  );
  if (!clicked) fail(`${label} vanished before it could be used`);
  if (!(await waitFor(verifyExpression, 15000))) fail(`${label} had no effect`);
  clicks.push(`${label}: click handler`);
};

/** The fixture directory, named so the frames it opens can be told from anything else on screen. */
const DIR = mkdtempSync(join(tmpdir(), "verta-html-probe-"));
const DIR_NAME = DIR.split(sep).pop();
const openedTabs = new Set();

/** Hands a path to the app the way an "Open With" does, and waits for its tab to come forward. */
const openFile = async (path, label) => {
  const name = path.split(/[\\/]/).pop();
  const asked = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "verta:open-file", payload: [${JSON.stringify(path)}] }).then(() => true).catch(() => false)`,
  );
  if (!asked) fail(`${label}: the app has no IPC to hand a path to`);
  const active = `([...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.innerText || "").includes(${JSON.stringify(name)})`;
  if (!(await waitFor(active, 30000))) {
    report.tabs = await evaluate(
      `JSON.stringify([...document.querySelectorAll("[data-tab-id]")].map((el) => (el.innerText || "").trim()))`,
    );
    fail(`${label}: ${name} was handed to the app and its tab never came forward`);
  }
  const tabId = await evaluate(
    `[...document.querySelectorAll("[data-tab-id][data-tab-active='true']")][0]?.getAttribute("data-tab-id") ?? null`,
  );
  if (tabId) openedTabs.add(tabId);
};

/** The frame this probe just opened: the only visible one whose URL names its own temp directory. */
const probeFrame = `[...document.querySelectorAll("iframe")].filter((node) => !node.closest('[aria-hidden="true"]') && node.offsetParent !== null).find((node) => (node.getAttribute("src") || "").includes(${JSON.stringify(DIR_NAME)})) ?? null`;

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);

/**
 * Asks the page to report on itself, and keeps asking until something answers.
 *
 * The frame element exists as soon as the pane renders, but the document inside it arrives after
 * that, and a message posted into the empty document is delivered there and dropped. That is not
 * theoretical: the fixture is small enough to win the race and the real 60 KB page lost it, reporting
 * nothing on the first ask and answering on the next one. The mailbox is emptied first so a stray
 * answer from an earlier frame cannot be taken for this one's.
 */
const askFrame = async (timeoutMs = 25000) => {
  await evaluate("window.__probeInbox = []");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const asked = await evaluate(`(() => {
      const frame = ${probeFrame};
      if (!frame || !frame.contentWindow) return false;
      frame.contentWindow.postMessage("report", "*");
      return true;
    })()`);
    if (!asked) fail("the frame has no window to ask");
    await sleep(600);
    const inbox = await evaluate("window.__probeInbox");
    if (Array.isArray(inbox) && inbox.length > 0) return inbox[inbox.length - 1];
  }
  return null;
};

/** Opens a file, renders it, and asks the page to report on itself. */
async function renderAndAsk({ file, label }) {
  const path = join(DIR, file);
  await openFile(path, label);
  const sourceReady = await waitFor(
    `!!([...document.querySelectorAll(".cm-content")].find((el) => !el.closest('[aria-hidden="true"]')))`,
    20000,
  );
  if (!sourceReady) fail(`${label}: the file never opened as source`);

  await clickVerified(visibleButton(`/^(渲染|Rendered)$/`), `!!(${probeFrame})`, "the rendered stop");
  if (!(await waitFor(`!!(${probeFrame})`, 15000))) {
    report.frames = await evaluate(
      `JSON.stringify([...document.querySelectorAll("iframe")].map((node) => node.getAttribute("src")))`,
    );
    fail(`${label}: the frame never appeared`);
  }

  const frameSrc = await evaluate(`(${probeFrame})?.getAttribute("src") ?? null`);
  const sandbox = await evaluate(`(${probeFrame})?.getAttribute("sandbox") ?? null`);
  if (!(frameSrc ?? "").includes("asset.localhost")) {
    fail(`${label}: the frame is not pointing at the asset protocol (src ${frameSrc})`);
  }
  if (!(sandbox ?? "").includes("allow-scripts")) {
    fail(`${label}: the frame does not grant allow-scripts`);
  }
  if ((sandbox ?? "").includes("allow-top-navigation")) {
    fail(`${label}: the frame grants top navigation, which would expose the Tauri window to the page`);
  }

  const inside = await askFrame();
  if (!inside) {
    fail(`${label}: the page never reported back, so the frame did not load or its script did not run`);
  }
  return { frameSrc, sandbox, inside };
}

/** Leaves the rendered stop (so the next file opens as source) and drops the mailbox. */
async function reset() {
  if (await waitFor(visibleButton(`/^(源码|Raw)$/`), 4000)) {
    await clickVerified(visibleButton(`/^(源码|Raw)$/`), `!(${probeFrame})`, "the source stop");
    await sleep(300);
  }
  await evaluate("window.__probeInbox = []").catch(() => {});
}

try {
  // ---- The fixture: a page, a stylesheet beside it, another one a directory up, a script beside
  // it. Both sheets matter: the `../` one is what the single-segment asset URL could not reach. ----
  mkdirSync(join(DIR, "inner"), { recursive: true });
  writeFileSync(join(DIR, "inner", FILE), PAGE);
  writeFileSync(join(DIR, "inner", "style.css"), `#head { color: ${HEAD_COLOR}; }\n`);
  writeFileSync(join(DIR, "outside.css"), `#sibling { color: ${SIBLING_COLOR}; }\n`);
  writeFileSync(
    join(DIR, "inner", "script.js"),
    "window.__PROBE_RAN__ = true;\ndocument.getElementById('sibling').textContent = 'script ran';\n",
  );
  report.fixtureDir = DIR;

  await evaluate(`(() => {
    window.__probeInbox = [];
    window.addEventListener("message", (event) => {
      if (event.data && event.data.mark === ${JSON.stringify(MARK)}) window.__probeInbox.push(event.data);
    });
    return true;
  })()`);

  const synthetic = await renderAndAsk({
    file: join("inner", FILE),
    label: "fixture",
  });
  report.fixture = { src: synthetic.frameSrc, sandbox: synthetic.sandbox, inside: synthetic.inside };
  console.log(`fixture frame:     ${synthetic.frameSrc}`);
  console.log(`inside the frame:  ${JSON.stringify(synthetic.inside)}`);

  const inside = synthetic.inside ?? {};
  if (!(inside.text ?? "").includes("Probe heading")) {
    fail(`the frame did not render the page (read ${JSON.stringify(inside.text)})`);
  }
  if (inside.headColor !== HEAD_COLOR) {
    fail(`the stylesheet beside the page did not apply: #head is ${inside.headColor}, not ${HEAD_COLOR}`);
  }
  if (inside.siblingColor !== SIBLING_COLOR) {
    fail(
      `the stylesheet one directory up did not apply: #sibling is ${inside.siblingColor}, not ${SIBLING_COLOR} - a relative reference must resolve as a path`,
    );
  }
  if (inside.outsideFailed === true) {
    fail("the frame reported the ../ stylesheet as failed while its rules are applied");
  }
  if (inside.scriptRan !== true) {
    fail("the page's script did not run, so the sandbox does not grant what the design assumes");
  }
  report.ipcAttempt = inside.ipc;
  // The page shares the webview's bridge object, so what stops it calling into the app is the ACL:
  // an origin the app rendered is not a capability holder. That is a security property, not a detail
  // - a page handed a Tauri window must not be able to read or write the machine - so it is asserted
  // rather than described.
  for (const attempt of inside.ipc ?? []) {
    if (!/refused|no bridge/.test(attempt)) {
      fail(`the rendered page could call into the app: ${attempt}`);
    }
  }
  if ((inside.ipc ?? []).length === 0) {
    fail("the frame reported nothing about the IPC, so the boundary was not measured");
  }

  // ---- The same, with a real page: copied in with the harness appended, so a page with its own
  // styles and its own script is measured rather than a fixture written to be measured. ----
  if (existsSync(realPath)) {
    const source = readFileSync(realPath, "utf8");
    const withErrors = source.replace(
      /<head(\s[^>]*)?>/i,
      (tag) =>
        `${tag}\n<script>window.__PAGE_ERRORS__ = [];window.addEventListener("error", (e) => window.__PAGE_ERRORS__.push(String(e.message)));</script>`,
    );
    const harnessed = withErrors.includes("</body>")
      ? withErrors.replace(/<\/body>/i, `${REPORT_SCRIPT}</body>`)
      : `${withErrors}${REPORT_SCRIPT}`;
    writeFileSync(join(DIR, REAL_FILE), harnessed);

    await reset();
    const real = await renderAndAsk({ file: REAL_FILE, label: "real page" });
    report.realPage = {
      src: real.frameSrc,
      title: real.inside?.title,
      textLength: real.inside?.textLength,
      sheets: real.inside?.sheets,
      errors: real.inside?.errors,
      theme: real.inside?.theme,
      themeAfter: real.inside?.themeAfter,
      themeRestored: real.inside?.themeRestored,
      ipc: real.inside?.ipc,
    };
    console.log(`real page:         ${JSON.stringify(report.realPage)}`);
    if (!(real.inside?.textLength > 500)) {
      fail(`the real page drew ${real.inside?.textLength} characters of text`);
    }
    if ((real.inside?.errors ?? []).length > 0) {
      fail(`the real page raised ${JSON.stringify(real.inside.errors)}`);
    }
    if (real.inside?.theme === real.inside?.themeAfter) {
      fail("the real page's own theme button did not change the document, so its script is inert");
    }
    // And it was pressed back: leaving the user's page on the other theme is not a probe's business.
    if (real.inside?.themeRestored !== real.inside?.theme) {
      fail(
        `the real page was left on theme ${real.inside?.themeRestored} instead of ${real.inside?.theme}`,
      );
    }
  } else {
    report.realPageSkipped = realPath;
    console.log(`real page skipped: ${realPath} 不存在`);
  }

  await reset();
  report.clicks = clicks;
  report.ok = true;
  console.log(
    "PASS: HTML 渲染停在沙箱 iframe 里跑起来：页面文本、同目录 ./style.css、上一级 ../outside.css 都生效，页面脚本执行；sandbox 不含 allow-top-navigation。真页面（自带样式与脚本）也渲染并可交互。",
  );
  console.log(
    `记录：子框架里能否碰到 IPC = ${JSON.stringify(report.ipcAttempt)}；子框架看父窗口 = ${inside.parentFrame}。`,
  );  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // Only the tabs this run opened, and only through their own close chip.
  try {
    await evaluate(`(() => {
      const ids = ${JSON.stringify([...openedTabs])};
      let closed = 0;
      for (const el of document.querySelectorAll("[data-tab-id]")) {
        if (!ids.includes(el.getAttribute("data-tab-id"))) continue;
        const chip = el.querySelector('[role="button"]');
        if (chip) {
          chip.click();
          closed += 1;
        }
      }
      return closed;
    })()`);
    await sleep(600);
  } catch {
    // A dead webview still leaves the directory removed below, which is the part that matters.
  }
  cleanup();
  socket.close();
}
