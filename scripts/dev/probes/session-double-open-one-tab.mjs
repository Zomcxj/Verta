// Click one session row twice and read whether the app opens one tab or two.
//
// The defect it answers: every agent here writes its own session file, and two agents on one file
// take turns overwriting each other's turns - reported as "pi 多终端开同一会话会写乱". The fix is
// `openTabForSession` in `openSession.ts`, called from `handleOpenSession`: a second click on a row
// whose session is already open returns to that tab instead of starting another agent.
//
// A unit test can only prove the matcher; the claim is about the running app, so this drives the
// app's own path and reads the tab strip - the only thing the user can see. `useTabs` is a React
// hook rather than a store, so there is nothing to `.getState()`: the count comes from the tabs the
// strip renders under `data-tab-id`, and "did the click move the selection" from which of them the
// strip draws as active. Every tab the run opened is closed again.
//
// Usage: node scripts/dev/probes/session-double-open-one-tab.mjs [--title=...] [--seconds=60]
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const title = arg("title", "");
const sessionId = arg("session", "");
const timeoutSec = Number(arg("seconds", "60"));
const port = arg("port", "9222");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? ex.text);
  return r.result?.result?.value;
};

// The strip: every tab it draws, its id, its label, and which one it draws as active.
const READ = `JSON.stringify((() => {
  const strip = [...document.querySelectorAll("[data-tab-id]")];
  const rows = strip.map((el) => {
    const id = Number(el.getAttribute("data-tab-id"));
    return {
      id,
      label: (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 30),
      active: el.getAttribute("data-tab-active") === "true",
    };
  });
  return { tabs: rows, count: rows.length };
})())`;

// A row is matched by its session id when one was given, and by title otherwise: the row's text is
// painted per character by the theme, so reading it back can miss letters and a title match is the
// weaker of the two.
const MATCH = `(el) => (${JSON.stringify(sessionId)} !== ""
  ? el.getAttribute("data-session-id") === ${JSON.stringify(sessionId)}
  : (el.textContent || "").includes(${JSON.stringify(title)}))`;

const pickRow = async () =>
  JSON.parse(
    await ev(`(async () => {
      const visible = () => [...document.querySelectorAll("[data-session-id]")]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (visible().length === 0) {
        const tab = [...document.querySelectorAll("button")]
          .find((b) => /^(会话|Sessions)$/.test((b.getAttribute("aria-label") || "").trim()));
        if (!tab) return JSON.stringify({ ok: false, why: "sidebar has no 会话 button" });
        tab.click();
        await new Promise((r) => setTimeout(r, 1500));
      }
      const match = ${MATCH};
      const rows = visible().filter(match);
      if (rows.length === 0) {
        return JSON.stringify({
          ok: false,
          why: "no visible row matches",
          visibleRows: visible().map((el) => el.getAttribute("data-session-id")),
        });
      }
      const row = rows[0];
      return JSON.stringify({
        ok: true,
        sessionId: row.getAttribute("data-session-id"),
        label: (row.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 48),
      });
    })()`),
  );

const clickRow = async () =>
  ev(`(() => {
    const match = ${MATCH};
    const rows = [...document.querySelectorAll("[data-session-id]")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && match(el);
    });
    if (rows.length === 0) return "row gone";
    const row = rows[0];
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      row.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    row.click();
    return "clicked";
  })()`);

const row = await pickRow();
if (!row.ok) {
  console.log(JSON.stringify(row, null, 2));
  socket.close();
  process.exit(1);
}
console.log(`row: ${row.label}  (session ${row.sessionId})`);

const before = JSON.parse(await ev(READ));
console.log(
  `before: ${before.count} tabs [${before.tabs.map((t) => t.label).join(" | ")}]`,
);

// --- first click ------------------------------------------------------------------------------
await clickRow();
const deadline = Date.now() + timeoutSec * 1000;
let afterFirst = null;
while (Date.now() < deadline) {
  await sleep(500);
  const snap = JSON.parse(await ev(READ));
  if (snap.count > before.count) {
    afterFirst = snap;
    break;
  }
}
if (afterFirst === null) {
  afterFirst = JSON.parse(await ev(READ));
  console.log(`first click: no new tab after ${timeoutSec}s (already open? continuing)`);
} else {
  console.log(`first click: ${before.count} -> ${afterFirst.count} tabs`);
}
// Let the agent come up, so what the second click meets is a live session, not a starting one.
await sleep(4000);

// Park on another tab first: with the session's tab already active, "did the click return to it"
// cannot be told apart from "the click did nothing". Switching away makes the second click's effect
// visible - it has to bring that tab back.
const sessionTab = afterFirst.tabs.find((t) => !before.tabs.some((b) => b.id === t.id));
const parkTarget = afterFirst.tabs.find((t) => t.id !== sessionTab?.id);
if (parkTarget) {
  await ev(`(() => {
    const el = document.querySelector('[data-tab-id="${parkTarget.id}"]');
    if (!el) return "gone";
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    el.click();
    return "parked";
  })()`);
  await sleep(1500);
}
const beforeSecond = JSON.parse(await ev(READ));
console.log(
  `parked on tab ${beforeSecond.tabs.find((t) => t.active)?.id}; session tab is ${sessionTab?.id}`,
);

// --- second click: must return to the session's tab and add none ------------------------------
await clickRow();
await sleep(3000);
const afterSecond = JSON.parse(await ev(READ));

const added = afterSecond.count - beforeSecond.count;
const landedOn = afterSecond.tabs.find((t) => t.active)?.id;
const verdict = {
  sessionId: row.sessionId,
  sessionTabId: sessionTab?.id ?? null,
  tabsBefore: before.count,
  tabsAfterFirst: afterFirst.count,
  tabsBeforeSecond: beforeSecond.count,
  tabsAfterSecond: afterSecond.count,
  addedBySecondClick: added,
  parkedOn: beforeSecond.tabs.find((t) => t.active)?.id ?? null,
  landedOn: landedOn ?? null,
  returnedToSessionTab: sessionTab !== undefined && landedOn === sessionTab.id,
  pass: added === 0 && sessionTab !== undefined && landedOn === sessionTab.id,
};
console.log("\n" + JSON.stringify(verdict, null, 2));

// --- clean up: close the tab this run opened --------------------------------------------------
const opened = afterSecond.tabs.find((t) => !before.tabs.some((b) => b.id === t.id));
if (opened) {
  await ev(`(() => {
    const el = document.querySelector('[data-tab-id="${opened.id}"]');
    const closer = el?.querySelector('[aria-label*="关闭"], [aria-label*="Close"]');
    if (closer) { closer.click(); return "closed"; }
    return "no close button";
  })()`);
  await sleep(1200);
}
const final = JSON.parse(await ev(READ));
console.log(`after cleanup: ${final.count} tabs`);

console.log(
  verdict.pass
    ? "\nPASS: the second click added no tab and brought back the session's own tab."
    : `\nFAIL: added ${added} tab(s) (${beforeSecond.count} -> ${afterSecond.count}), landed on ${landedOn}.`,
);
socket.close();
process.exit(verdict.pass ? 0 : 1);
