// The window's own edge belongs to whichever region is at the end of the row: collapsing a panel must
// not leave the workspace flush against the window with a square corner.
//
// The claim is geometric, so it is measured rather than eyeballed: the outer margin is the first
// pane's distance from the window's content edge, the corner is the pane's computed radius, and which
// region owns it is a data attribute the stylesheet reads. Each panel is closed and reopened in turn,
// and the original layout is restored - the panel sizes are the user's, and this run only passes
// through them.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/shell-edge-collapse.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/");
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) => reject(new Error(String(e?.message ?? e))));
});
let nextId = 1;
const pending = new Map();
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
    throw new Error(`${what} in: ${expression.slice(0, 160)}`);
  }
  return result.result.value;
};

/**
 * One reading of the shell.
 *
 * A region's own box is what the resize panel gives it (0 when collapsed), and the pane inside it is
 * the card: the two are read together because "flush against the window" is a fact about the pane and
 * "collapsed" is a fact about the box.
 */
const SNAPSHOT = `(() => {
  const root = document.documentElement;
  const radius = getComputedStyle(root).getPropertyValue("--pane-radius").trim();
  const corner = (value) => Math.round(Number.parseFloat(value) || 0);
  const region = (name) => {
    const wrap = document.querySelector('[data-shell="' + name + '"]');
    const pane = wrap ? wrap.querySelector(".verta-pane") : null;
    if (!wrap || !pane) return null;
    const box = wrap.getBoundingClientRect();
    const rect = pane.getBoundingClientRect();
    const style = getComputedStyle(pane);
    return {
      boxWidth: Math.round(box.width),
      paneLeft: Math.round(rect.left),
      paneRight: Math.round(rect.right),
      paneWidth: Math.round(rect.width),
      radius: {
        topLeft: corner(style.borderTopLeftRadius),
        topRight: corner(style.borderTopRightRadius),
        bottomLeft: corner(style.borderBottomLeftRadius),
        bottomRight: corner(style.borderBottomRightRadius),
      },
      edgeLeft: wrap.hasAttribute("data-edge-left"),
      edgeRight: wrap.hasAttribute("data-edge-right"),
    };
  };
  // The window's content edge: main wraps the row and carries no padding of its own, so its box is
  // where the window ends and the margin begins.
  const main = document.querySelector("main");
  const mainRect = main ? main.getBoundingClientRect() : null;
  return JSON.stringify({
    shape: root.dataset.shape ?? null,
    paneRadius: corner(radius),
    viewport: { w: innerWidth, h: innerHeight },
    content: mainRect
      ? { left: Math.round(mainRect.left), right: Math.round(mainRect.right) }
      : { left: 0, right: innerWidth },
    sidebar: region("sidebar"),
    workspace: region("workspace"),
    right: region("right"),
  });
})()`;

const snapshot = async () => JSON.parse(await evaluate(SNAPSHOT));

/** Clicks a header toggle by its tooltip, which is what a person reads it by. */
const pressToggle = async (pattern) => {
  const pressed = await evaluate(`(() => {
    const wanted = ${JSON.stringify(pattern)};
    const button = [...document.querySelectorAll("button[title]")].find((node) =>
      new RegExp(wanted, "i").test(node.getAttribute("title") || ""),
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!pressed) fail(`no header button matching ${pattern}`);
  // The toggle animates the row's flex-grow. Two identical samples are not enough: a transition near
  // its end moves by less than a pixel between two reads, and the first run took the snapshot while
  // the sidebar was still 0px wide. Three quiet samples, 150ms apart, are.
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(150);
    const next = JSON.stringify(await snapshot());
    stable = next === previous ? stable + 1 : 0;
    previous = next;
    if (stable >= 3) return;
  }
};

/**
 * Presses the toggle only if that region is closed.
 *
 * A blind toggle is what the restore step used to be, and it stopped restoring anything the moment a
 * step above it left the layout somewhere else: closing an open panel is not opening it.
 */
const ensureOpen = async (pattern, region) => {
  if ((await snapshot())[region].boxWidth > 0) return;
  await pressToggle(pattern);
};

/** The outermost pane's distance from the window's content edge. */
const outerMargin = (state, side) => {
  if (side === "left") {
    const first = state.sidebar && state.sidebar.boxWidth > 0 ? state.sidebar : state.workspace;
    return first ? first.paneLeft - state.content.left : null;
  }
  const last = state.right && state.right.boxWidth > 0 ? state.right : state.workspace;
  return last ? state.content.right - last.paneRight : null;
};

try {
  const both = await snapshot();
  report.before = both;
  if (!both.workspace || !both.sidebar || !both.right) {
    fail("the three regions are not all in the document, so the row is not the one this checks");
  }
  if (both.sidebar.boxWidth === 0 || both.right.boxWidth === 0) {
    fail(
      `a panel is already collapsed (sidebar ${both.sidebar.boxWidth}px, right ${both.right.boxWidth}px): open both and run this again`,
    );
  }
  /** The corner the sheet draws at its edge today: a computed px, not the `calc(...)` variable. */
  const referenceRadius = both.sidebar.radius.topLeft;
  report.referenceRadius = referenceRadius;
  if (!(referenceRadius > 0)) {
    fail(`the sidebar's outer corner measures ${referenceRadius}px, so the sheet has no radius to keep`);
  }
  const marginBefore = { left: outerMargin(both, "left"), right: outerMargin(both, "right") };
  report.marginBefore = marginBefore;
  if (marginBefore.left < 6 || marginBefore.right < 6) {
    fail(
      `with both panels open the panes are ${marginBefore.left}px / ${marginBefore.right}px from the window's edge, so there is no margin to preserve`,
    );
  }
  if (both.shape === "boundless") {
    if (!both.sidebar.edgeLeft || !both.right.edgeRight) {
      fail(
        `the outer corners are not on the outer regions (sidebar ${JSON.stringify(both.sidebar.edgeLeft)}, right ${JSON.stringify(both.right.edgeRight)})`,
      );
    }
    if (both.sidebar.radius.topLeft !== referenceRadius || both.right.radius.topRight !== referenceRadius) {
      fail(
        `the sheet's outer corners are not the radius its edge draws (${referenceRadius}): sidebar ${both.sidebar.radius.topLeft}, right ${both.right.radius.topRight}`,
      );
    }
  }

  // ---- Sidebar closed: the workspace becomes the left end of the row ---------------------------
  await pressToggle("侧栏|sidebar");
  const leftClosed = await snapshot();
  report.sidebarClosed = leftClosed;
  if (leftClosed.sidebar.boxWidth !== 0) {
    fail(`the sidebar did not collapse (still ${leftClosed.sidebar.boxWidth}px wide)`);
  }
  const leftMargin = outerMargin(leftClosed, "left");
  report.leftMarginAfter = leftMargin;
  if (leftMargin === null || leftMargin < 6) {
    fail(
      `with the sidebar collapsed the workspace is ${leftMargin}px from the window's edge: it took the panel's place and is flush against the window`,
    );
  }
  if (Math.abs(leftMargin - marginBefore.left) > 1) {
    fail(
      `the window's margin changed when the sidebar closed: ${marginBefore.left}px with it open, ${leftMargin}px with it closed`,
    );
  }
  if (!leftClosed.workspace.edgeLeft) {
    fail("with the sidebar collapsed the workspace does not own the left edge, so its corner stays square");
  }
  if (leftClosed.shape === "boundless" && leftClosed.workspace.radius.topLeft !== referenceRadius) {
    fail(
      `the workspace's top-left corner is ${leftClosed.workspace.radius.topLeft}px with the sidebar closed, not the ${referenceRadius}px the sheet's edge uses`,
    );
  }
  if (leftClosed.shape === "boundless" && leftClosed.workspace.radius.bottomLeft !== referenceRadius) {
    fail(
      `the workspace's bottom-left corner is ${leftClosed.workspace.radius.bottomLeft}px with the sidebar closed`,
    );
  }
  // The seam it used to have is still square: the radius is an edge property, not a pane property.
  if (leftClosed.shape === "boundless" && leftClosed.workspace.radius.topRight !== 0) {
    fail(
      `the workspace's inner (right) corner is ${leftClosed.workspace.radius.topRight}px: the sheet would show a notch along its seam`,
    );
  }

  // ---- Sidebar open again: everything back where it was ---------------------------------------
  await pressToggle("侧栏|sidebar");
  const restored = await snapshot();
  report.restored = restored;
  if (restored.sidebar.boxWidth === 0 || !restored.sidebar.edgeLeft) {
    fail("reopening the sidebar did not give it its own edge back");
  }
  if (restored.shape === "boundless" && restored.workspace.radius.topLeft !== 0) {
    fail("the workspace kept its rounded corner after the sidebar came back");
  }

  // ---- Right panel closed: the same claim, mirrored -------------------------------------------
  await pressToggle("Git 面板|Git panel");
  const rightClosed = await snapshot();
  report.rightClosed = rightClosed;
  if (rightClosed.right.boxWidth !== 0) {
    fail(`the right panel did not collapse (still ${rightClosed.right.boxWidth}px wide)`);
  }
  const rightMargin = outerMargin(rightClosed, "right");
  report.rightMarginAfter = rightMargin;
  if (rightMargin === null || rightMargin < 6) {
    fail(`with the right panel collapsed the workspace is ${rightMargin}px from the window's right edge`);
  }
  if (Math.abs(rightMargin - marginBefore.right) > 1) {
    fail(
      `the window's right margin changed when the panel closed: ${marginBefore.right}px -> ${rightMargin}px`,
    );
  }
  if (!rightClosed.workspace.edgeRight) {
    fail("with the right panel collapsed the workspace does not own the right edge");
  }
  if (rightClosed.shape === "boundless" && rightClosed.workspace.radius.topRight !== referenceRadius) {
    fail(
      `the workspace's top-right corner is ${rightClosed.workspace.radius.topRight}px with the panel closed, not ${referenceRadius}px`,
    );
  }

  // ---- Both closed: one card, four rounded corners --------------------------------------------
  await pressToggle("侧栏|sidebar");
  const bothClosed = await snapshot();
  report.bothClosed = bothClosed;
  if (bothClosed.shape === "boundless") {
    const { workspace } = bothClosed;
    if (!workspace.edgeLeft || !workspace.edgeRight) {
      fail("with both panels closed the workspace does not own both edges");
    }
    const corners = ["topLeft", "topRight", "bottomLeft", "bottomRight"].map(
      (corner) => workspace.radius[corner],
    );
    if (corners.some((value) => value !== referenceRadius)) {
      fail(
        `with both panels closed the workspace's corners are ${corners.join("/")}, not ${referenceRadius} all round: it is the whole sheet now`,
      );
    }
  }

  // ---- The corner must not lag the panel ------------------------------------------------------
  //
  // Measured on the running app before this was fixed: the sidebar reached 0px at 330ms and the sheet
  // stayed square until 939ms, because the corner followed the flag the panels persist rather than the
  // layout. So the collapse is watched frame by frame - every sample where the panel is gone must
  // already have the workspace rounded, or that 600ms of square edge is back.
  const collapseKey = "侧栏|sidebar";
  // The steps above leave the sidebar closed (they are the two-panels-closed case), so it is opened
  // first: this block measures the way down, not the way up.
  await ensureOpen(collapseKey, "sidebar");
  const pressedWatch = await evaluate(`(() => {
    const wanted = ${JSON.stringify("侧栏|sidebar")};
    const button = [...document.querySelectorAll("button[title]")].find((node) =>
      new RegExp(wanted, "i").test(node.getAttribute("title") || ""),
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!pressedWatch) fail("no header button to collapse the sidebar with");
  const watched = [];
  for (let attempt = 0; attempt < 26; attempt += 1) {
    await sleep(60);
    watched.push(await snapshot());
  }
  report.collapseSamples = watched.map((sample) => ({
    sidebar: sample.sidebar.boxWidth,
    edgeLeft: sample.workspace.edgeLeft,
    radius: sample.workspace.radius.topLeft,
  }));
  const gone = watched.filter((sample) => sample.sidebar.boxWidth <= 1);
  if (gone.length === 0) {
    fail("the sidebar never reached 0px while being watched, so the collapse was not measured");
  }
  const square = gone.filter(
    (sample) => !sample.workspace.edgeLeft || sample.workspace.radius.topLeft === 0,
  );
  if (square.length > 0) {
    fail(
      `while the sidebar was 0px wide the sheet was square for ${square.length} of ${gone.length} samples: the corner is following the persisted flag, not the layout`,
    );
  }
  // And back open, so the layout this run borrowed is the layout it returns.
  await pressToggle(collapseKey);
  const reopened = await snapshot();
  if (reopened.sidebar.boxWidth === 0) fail("the sidebar did not come back after the collapse watch");

  // ---- Put the user's layout back -------------------------------------------------------------
  // Both are asked for by name, and only if they are closed: the steps above leave the row in whichever
  // state they ended in, and a blind toggle closes what it meant to open.
  await ensureOpen("侧栏|sidebar", "sidebar");
  await ensureOpen("Git 面板|Git panel", "right");
  const final = await snapshot();
  report.final = final;
  if (final.sidebar.boxWidth === 0 || final.right.boxWidth === 0) {
    fail("the layout was not restored: a panel is still closed");
  }

  console.log(
    `PASS: 两栏都开时窗口边距 ${marginBefore.left}px / ${marginBefore.right}px；收起左栏后工作区接管左外沿（edge-left=${leftClosed.workspace.edgeLeft}，左上圆角 ${leftClosed.workspace.radius.topLeft}px、内缝仍是 ${leftClosed.workspace.radius.topRight}px），距窗口左边 ${leftMargin}px（与收起前一致）；收起右栏同理（${rightMargin}px、右上圆角 ${rightClosed.workspace.radius.topRight}px）；两栏都收起时工作区四个角都是 ${referenceRadius}px —— 整张卡片仍然是一个圆角面板；结束后两栏都已还原。shape=${both.shape}，边的圆角=${referenceRadius}px。`,
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
