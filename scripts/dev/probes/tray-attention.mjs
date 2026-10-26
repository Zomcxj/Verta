// The case the whole slice exists for: the window is hidden in the tray, and the session the
// user was last on starts asking something.
//
// Before the window became part of "has the user looked at this", that question was invisible -
// the tab it was asked on still counted as being in front, so nothing latched, the bell stayed
// empty and the icon stayed plain. This probe puts the window in the tray, asks on the tab that
// was in front, and reads back everything that should have noticed:
//
//   --stage=hidden   (the case)      hidden window, question on the last tab in use.
//   --stage=watched  (the counter)   same screen with the window in front and that tab active:
//                                    nothing may be announced, because the user is looking at it.
//   --stage=looked   (the clearing)  bring the window back, which is what "looking" means here.
//
// What it cannot show is the notification itself: on Windows only an installed app's gets shown
// (measured - a burst of them puts nothing on the screen), so that belongs to the installed
// build. The tray dot is read off the screen by the picture tools, not from in here.
//
// The window is left as it is found: the probe's tab closed and the user's own tab back in
// front.
//
// Usage: node scripts/dev/probes/tray-attention.mjs --stage=hidden
//        node scripts/dev/probes/tray-attention.mjs --stage=watched
//        node scripts/dev/probes/tray-attention.mjs --stage=looked
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const stage = arg("stage") ?? "hidden";

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text,
    );
  }
  return r.result.result.value;
};

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const hits = urls.filter((n) => n.includes("/src/" + p)); return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p); };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

/** What the app says about itself: the latch, the bell, the strip, and who is in front. */
const state = () =>
  pageEval(`
    ${MODULES}
    const store = activity.useAgentActivityStore.getState();
    const strip = [...document.querySelectorAll("[role=tab]")];
    const active = strip.find((t) => t.getAttribute("data-tab-active") === "true");
    const bell = document.querySelector("[data-agent-bell]");
    return JSON.stringify({
      unseen: store.unseen,
      phases: store.phases,
      foreground: [...store.foregroundLeaves],
      inactive: document.documentElement.hasAttribute("data-window-inactive"),
      bell: bell ? (document.querySelector("[data-agent-bell-count]")?.textContent || "").trim() : null,
      activeLabel: active ? (active.textContent || "").trim() : null,
      dots: strip.map((t) => t.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null),
    });
  `).then(JSON.parse);

const windowEval = (body) =>
  pageEval(`
    const urls = performance.getEntriesByType("resource").map((e) => e.name);
    const w = (await import(urls.find((n) => n.includes("@tauri-apps_api_window")))).getCurrentWindow();
    ${body}
  `);

const press = (findJs) =>
  pageEval(`
    const node = ${findJs};
    if (!node) return "not-found";
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    return "pressed";
  `);

// pi's own screens, written from the captures the rules were made from.
const PI_RULE = "─".repeat(124);
const PI_WORKING = [
  'clear',
  `printf '用一句话说明 notes.txt 里写了什么\\n── ⠙ Working ─────────────────────────────────────────────────────────────\\n${PI_RULE}\\n~/AppData/Local/Temp/verta-pi-probe\\n1.6%%/262k (auto)                     (sensenova) sensenova-6.8-flash-lite • medium\\n'`,
].join(" ; ");
const PI_BLOCKED = [
  'clear',
  `printf ' 删除文件选择\\n 该删掉 a.txt 还是 b.txt？\\n → 删掉 a.txt — 移除 a.txt，保留 b.txt\\n   删掉 b.txt — 移除 b.txt，保留 a.txt\\n   Other (type your answer)\\n ↑↓ navigate  enter select  escape/ctrl+c cancel\\n${PI_RULE}\\n ↳ 请再用 ask_user 工具问我：该删掉 a.txt 还是 b.txt？\\n'`,
].join(" ; ");

const write = (leaf, command) =>
  pageEval(`
    ${MODULES}
    return api.writeToSession(${leaf}, ${JSON.stringify(`${command}\r`)});
  `);

const report = { stage };
let probeLeaf = null;
let probeLabel = null;
let userLabel = null;
try {
  await send("Page.bringToFront");
  // A freshly started window restores its own session a moment later; let it settle first.
  for (let i = 0; i < 40; i += 1) {
    const open = await pageEval(`return document.querySelectorAll("[role=tab]").length;`);
    if (typeof open === "number" && open > 0) break;
    await sleep(500);
  }
  await sleep(1500);
  report.before = await state();
  userLabel = report.before.activeLabel;

  if (stage !== "looked") {
    // A terminal of the probe's own, left in front: this is the tab the user "was on".
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: 2,
      key: "t",
      code: "KeyT",
      windowsVirtualKeyCode: 84,
      nativeVirtualKeyCode: 84,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 2,
      key: "t",
      code: "KeyT",
      windowsVirtualKeyCode: 84,
      nativeVirtualKeyCode: 84,
    });
    const known = new Set(
      JSON.parse(
        await pageEval(`
          ${MODULES}
          const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
          return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
        `),
      ),
    );
    let leaf = null;
    for (let i = 0; i < 40 && leaf === null; i += 1) {
      await sleep(500);
      const seen = JSON.parse(
        await pageEval(`
          ${MODULES}
          const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
          return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
        `),
      );
      leaf = seen.find((l) => !known.has(l)) ?? null;
    }
    if (leaf === null) throw new Error("新会话没起来");
    probeLeaf = leaf;
    probeLabel = (await state()).activeLabel;
    report.probeTab = probeLabel;

    let ready = false;
    for (let i = 0; i < 40 && !ready; i += 1) {
      await sleep(500);
      ready =
        (
          await pageEval(`
            ${MODULES}
            return api.leafScreenTail(${leaf}) ?? "";
          `)
        ).trim().length > 0;
    }
    if (!ready) throw new Error("shell 没起来");

    if (stage === "watched") {
      // The counter-case: the window is in front and this tab is the one being looked at.
      await write(leaf, PI_BLOCKED);
      await sleep(3500);
      report.after = await state();
    } else {
      // The case: the window goes into the tray first, so the question arrives while nobody
      // can see it. The screen is moved off the question first, so there is a change to notice.
      //
      // Being hidden only counts as "nobody is looking" once the window has been *told* it is
      // no longer in front, and that only happens if it was in front to begin with: so it is
      // focused the one way Windows grants focus (by asking right after showing it), hidden,
      // and asked the question - all inside one call, because focus is lost between calls.
      await write(leaf, PI_WORKING);
      await sleep(2000);
      report.case = JSON.parse(
        await pageEval(`
          ${MODULES}
          const all = performance.getEntriesByType("resource").map((e) => e.name);
          const w = (await import(all.find((n) => n.includes("@tauri-apps_api_window")))).getCurrentWindow();
          const store = () => activity.useAgentActivityStore.getState();
          const asleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const inactive = () => document.documentElement.hasAttribute("data-window-inactive");

          await w.show().catch(() => {});
          await w.setFocus().catch(() => {});
          let focused = false;
          for (let i = 0; i < 20 && !focused; i += 1) {
            await asleep(100);
            focused = !inactive();
          }
          await w.hide().catch(() => {});
          await asleep(1200);
          const hiddenInactive = inactive();
          const beforeQuestion = { unseen: { ...store().unseen }, foreground: [...store().foregroundLeaves], phases: { ...store().phases } };
          await api.writeToSession(${leaf}, ${JSON.stringify(`${PI_BLOCKED}\r`)});
          await asleep(3500);
          const strip = [...document.querySelectorAll("[role=tab]")];
          const bell = document.querySelector("[data-agent-bell]");
          return JSON.stringify({
            focusedBeforeHiding: focused,
            inactiveWhileHidden: hiddenInactive,
            beforeQuestion,
            after: {
              unseen: { ...store().unseen },
              phases: { ...store().phases },
              foreground: [...store().foregroundLeaves],
              inactive: inactive(),
              bell: bell ? (document.querySelector("[data-agent-bell-count]")?.textContent || "").trim() : null,
              dots: strip.map((t) => t.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null),
            },
            visibleNow: await w.isVisible(),
          });
        `),
      );
      report.after = report.case.after;
      report.visibleNow = report.case.visibleNow;
    }
  }

  if (stage === "looked") {
    report.raised = await windowEval(
      `await w.show(); await w.setFocus().catch(() => {}); await new Promise((r) => setTimeout(r, 2500)); return "raised";`,
    );
    report.after = await state();
    // Put the window back: the waiting tab closed, the user's own tab in front again.
    report.closed = await press(
      `[...document.querySelectorAll("[role=tab]")].find((t) => t.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") === "attention")?.querySelector("[data-no-drag][role=button]")`,
    );
    await sleep(900);
    if (userLabel !== null) {
      report.back = await press(
        `[...document.querySelectorAll("[role=tab]")].find((t) => (t.textContent || "").trim() === ${JSON.stringify(userLabel)})`,
      );
    }
    await sleep(900);
    report.afterAll = await state();
  }
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();
