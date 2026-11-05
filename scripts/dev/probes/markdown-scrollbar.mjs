// Acceptance for "the rendered markdown has no scrollbar on the side".
//
// The shell hides every native scrollbar by default (`html * { scrollbar-width: none }`) and hands
// the affordance back per region; the code editor had its exception and the rendered document did
// not. That means the failure looks like nothing at all from the DOM: the container scrolls, its
// `scrollHeight` is correct, the wheel works - only the bar is missing, and the bar is what tells a
// reader there is more below the fold.
//
// So this probe measures the two things a hidden bar takes away and a drawn bar gives back:
//   * the computed `scrollbar-width`, which is `thin` for the exception and `none` for the default;
//   * the layout gutter, `offsetWidth - clientWidth`, which a classic (Windows) scrollbar occupies
//     and a hidden one does not - and which is 0 with the class removed and non-zero with it on,
//     making the class itself, rather than anything else on screen, the cause.
//
// The fixture is a ~400-section Markdown document written into a directory of its own under the
// system temp directory and removed again, so nothing else on the machine is touched. It is opened by
// handing the app the path the way an "Open With" does (`verta:open-file`), not by driving the file
// tree: the tree shows whatever folder the user is working in, and a fixture written into that folder
// puts probe files in their project. Usage:
//   node scripts/dev/probes/markdown-scrollbar.mjs [--port=9222]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const DIR = mkdtempSync(join(tmpdir(), "verta-md-probe-"));
const FILE = `long-${Math.random().toString(36).slice(2, 8)}.md`;
const LINES = Array.from(
  { length: 400 },
  (_, i) => `## Section ${i}\n\nParagraph ${i} of a document that is meant to be much taller than the pane, so the bar has something to report.`,
).join("\n\n");

const report = {};
// Failures are thrown rather than exited on: `process.exit` skips `finally`, which is what left a
// deleted fixture's tab open in the app after an earlier run.
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url.endsWith("1420/")) ??
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
const clickOn = async (expression, label, timeoutMs = 30000) => {
  if (!(await waitFor(expression, timeoutMs))) fail(`could not find ${label}`);
  await sleep(200);
  const rect = await rectOf(expression);
  if (!rect) fail(`${label} has no box to click`);
  await realClick(rect.x, rect.y);
  return rect;
};

/** The rendered panes of other tabs stay mounted, so only the visible one counts. */
const SCROLLER = `[...document.querySelectorAll(".verta-doc-scroll")].find((el) => !el.closest('[aria-hidden="true"]'))`;

/** Everything a bar decides, read off the live element. `gutter` is the layout space the bar takes:
 *  zero while the shell's `scrollbar-width: none` applies, the bar's own width once the exception
 *  does. */
const measure = () =>
  evaluate(`(() => {
    const el = ${SCROLLER};
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      scrollbarWidth: cs.scrollbarWidth,
      scrollbarGutter: cs.scrollbarGutter,
      scrollbarColor: cs.scrollbarColor,
      overflowY: cs.overflowY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      offsetWidth: el.offsetWidth,
      clientWidth: el.clientWidth,
      gutter: el.offsetWidth - el.clientWidth,
      textLength: (el.innerText || "").length,
    };
  })()`);

/** The same reading with the class taken off: the global `scrollbar-width: none` is then the only
 *  rule left, which is what the pane looked like before the change. */
const measureWithoutClass = () =>
  evaluate(`(() => {
    const el = ${SCROLLER};
    if (!el) return null;
    el.classList.remove("verta-doc-scroll");
    void el.offsetWidth;
    const cs = getComputedStyle(el);
    const without = {
      scrollbarWidth: cs.scrollbarWidth,
      gutter: el.offsetWidth - el.clientWidth,
    };
    el.classList.add("verta-doc-scroll");
    void el.offsetWidth;
    return without;
  })()`);

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
  if (!(await waitFor(`!!(${expression})`, 10000))) fail(`could not find ${label}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const rect = await rectOf(expression);
    if (rect) await realClick(rect.x, rect.y);
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

/** Hands a path to the app the way an "Open With" does, and waits for its tab to come forward. */
const openedTabs = new Set();
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

const cleanup = () => {
  rmSync(DIR, { recursive: true, force: true });
};
process.on("exit", cleanup);

try {
  // ---- The fixture ----
  writeFileSync(join(DIR, FILE), `# Long document\n\n${LINES}\n`);
  await openFile(join(DIR, FILE), "the markdown document");

  const visibleButton = (pattern) =>
    `[...document.querySelectorAll("button")].filter((b) => !b.closest('[aria-hidden="true"]')).find((b) => ${pattern}.test((b.innerText || "").trim()))`;
  // A Markdown file may open either way; the rendered stop is what puts the document on screen, and
  // only then does the scroll container exist at all.
  if (!(await waitFor(`!!(${SCROLLER})`, 8000))) {
    await clickVerified(
      visibleButton(`/^(渲染|Rendered)$/`),
      `!!(${SCROLLER})`,
      "the rendered stop of the markdown control",
    );
  }
  // Waiting for the container is not enough: it exists the moment the pane mounts, and a document
  // still being read leaves it as tall as the pane, which measures as "no bar needed".
  const scrollerReady = `(() => {
    const el = ${SCROLLER};
    return !!el && el.scrollHeight > el.clientHeight + 100;
  })()`;
  if (!(await waitFor(scrollerReady, 20000))) {
    report.stops = await evaluate(
      `JSON.stringify([...document.querySelectorAll("button")].filter((b) => !b.closest('[aria-hidden="true"]')).map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 30))`,
    );
    report.notReady = await measure();
    fail("the rendered document never filled its pane, so there is nothing to scroll");
  }

  report.withClass = await measure();
  console.log(`with the class:    ${JSON.stringify(report.withClass)}`);
  report.withoutClass = await measureWithoutClass();
  console.log(`without it:        ${JSON.stringify(report.withoutClass)}`);
  // The reading after the class was put back, so a failed assertion below still reports the state
  // the pane was left in.
  report.restored = await measure();

  const w = report.withClass ?? {};
  const wo = report.withoutClass ?? {};
  if (!(w.scrollHeight > w.clientHeight + 100)) {
    fail(
      `the document does not overflow its pane (scrollHeight ${w.scrollHeight} vs clientHeight ${w.clientHeight}), so this run says nothing about the bar`,
    );
  }
  if (w.scrollbarWidth !== "thin") {
    fail(`the rendered pane's scrollbar-width is ${w.scrollbarWidth}, not thin`);
  }
  if (w.scrollbarGutter !== "stable") {
    fail(`the rendered pane does not reserve its gutter (scrollbar-gutter: ${w.scrollbarGutter})`);
  }
  if (!(w.gutter >= 6)) {
    fail(`the bar takes ${w.gutter}px of layout, so it is not drawn (a hidden bar takes none)`);
  }
  if (wo.scrollbarWidth !== "none" || wo.gutter !== 0) {
    fail(
      `removing the class left scrollbar-width ${wo.scrollbarWidth} and a ${wo.gutter}px gutter, so the bar is not this class's doing`,
    );
  }
  if (!(report.restored?.gutter >= 6)) fail("the class was not put back after the measurement");

  // ---- The side preview column: same class, but its scrubbing markers sit on that edge, so they
  // have to clear the bar rather than be drawn over it. ----
  const sideScroller = `[...document.querySelectorAll('[data-side-preview][data-state="open"] .verta-doc-scroll')].find((el) => !el.closest('[aria-hidden="true"]'))`;
  const rawStop = visibleButton(`/^(源码|Raw)$/`);
  if (await waitFor(rawStop, 8000)) {
    await clickVerified(rawStop, `!(${SCROLLER})`, "the source stop of the markdown control");
    const previewStop = visibleButton(`/^(预览|Preview)$/`);
    if (await waitFor(previewStop, 10000)) {
      await clickVerified(
        previewStop,
        `!!([...document.querySelectorAll('[data-side-preview][data-state="open"]')].find((el) => !el.closest('[aria-hidden="true"]')))`,
        "the preview stop of the markdown control",
      );
      // The column animates its width from zero, and measured mid-animation it is a collapsed box
      // with nothing to scroll - which reads as "no bar" when the bar is simply not there yet.
      const settled = `(() => {
        const el = ${sideScroller};
        return !!el && el.offsetWidth > 100 && el.scrollHeight > el.clientHeight + 100;
      })()`;
      if (!(await waitFor(settled, 10000))) {
        // Say what is there instead: a missing column and an unloaded document are different
        // failures, and the message has to point at the right one.
        report.sidePreviewUnsettled = await evaluate(`(() => {
          const el = ${sideScroller};
          const pane = [...document.querySelectorAll("[data-side-preview]")].find((node) => !node.closest('[aria-hidden="true"]'));
          return {
            found: !!el,
            width: el ? el.offsetWidth : null,
            scrollHeight: el ? el.scrollHeight : null,
            clientHeight: el ? el.clientHeight : null,
            paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : null,
            paneState: pane ? pane.getAttribute("data-state") : null,
            stops: [...document.querySelectorAll(".cm-content, .markdown-rendered, .markdown-doc")].map((node) => node.className.split(" ")[0]),
          };
        })()`);
        fail("the side preview column never settled at a size with a document taller than it");
      }
      if (await waitFor(`!!(${sideScroller})`, 10000)) {
        report.sidePreview = await evaluate(`(() => {
          const el = ${sideScroller};
          const cs = getComputedStyle(el);
          const marks = [...el.parentElement.querySelectorAll("div")].filter(
            (node) => /(^|\\s)absolute(\\s|$)/.test(node.className) && /(^|\\s)w-1(\\s|$)/.test(node.className),
          );
          return {
            scrollbarWidth: cs.scrollbarWidth,
            scrollbarGutter: cs.scrollbarGutter,
            overflowX: cs.overflowX,
            overflowY: cs.overflowY,
            gutter: el.offsetWidth - el.clientWidth,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            width: el.offsetWidth,
            marks: marks.map((node) => getComputedStyle(node).right),
          };
        })()`);
        console.log(`side preview:      ${JSON.stringify(report.sidePreview)}`);
      }
    }
  }

  const side = report.sidePreview;
  if (side) {
    if (side.scrollbarWidth !== "thin" || !(side.gutter >= 6)) {
      fail(
        `the side preview's column has no bar (scrollbar-width ${side.scrollbarWidth}, gutter ${side.gutter}px)`,
      );
    }
    for (const right of side.marks ?? []) {
      // Against the measured bar, not a constant: a marker drawn 8px in still lands on the last
      // two pixels of a 10px bar.
      if (Number.parseFloat(right) < side.gutter) {
        fail(
          `a scrubbing marker sits at right: ${right} inside a ${side.gutter}px bar`,
        );
      }
    }
  }

  report.clicks = clicks;
  report.ok = true;
  console.log(
    `PASS: 渲染态的 md 文档有可见侧边滚动条（scrollbar-width: thin，独占 ${w.gutter}px 布局宽度，gutter 预留 stable）；把类去掉后立刻退回全局的"无滚动条"（width: none、gutter 0px），说明条就是这条规则画的。`,
  );
  if (clicks.some((entry) => entry.endsWith("click handler"))) {
    console.log(`记录：${clicks.join("；")}——指针点击在这些视图开关上不可靠，回退到控件自己的点击。`);
  }
  console.log(JSON.stringify(report, null, 2));
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
