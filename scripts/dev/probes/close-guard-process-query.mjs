// "Is a command still running in this terminal?" is what the close guard asks before
// letting the window go, and on Windows the answer decides whether the user sees a
// prompt at all: `confirmCloseRunningTerminal` defaults to on, so the guard runs on
// every close.
//
// The query is a kernel fact, so the honest way to check it is to put a real terminal
// through the states a user puts one in and read the native answers: a shell at its
// prompt must read "nothing running", a command must read "running", and the prompt the
// command comes back to must read "nothing running" again. The screen is read alongside
// so a wrong answer can be told apart from a wrong reading of the screen.
//
// Windows is why this exists. Git starts its shell through `bin\bash.exe`, a stub whose
// only child is `usr\bin\bash.exe`; asked about the stub, "does this shell have children"
// is yes for as long as the tab lives, and an idle terminal reads as busy. The fix walks
// past the stub, and this is the check that the walk lands on the process the user is
// actually typing into.
//
// What this probe also records, because it is a limit of the platform and not of the
// walk: a command whose image is an MSYS one (`sleep`, `yes`, `git`, ...) runs under a
// transient process that exits at once, so Windows reports its parent as a pid that is
// gone and the command is **not** a child of the shell. A native command (`node`,
// `python`, `ping`, and the agents) hangs off the shell's own fork and is seen. So the
// guard answers correctly at the prompt (the bug this fixes) and for native commands,
// and misses MSYS commands - it stays quiet instead of warning. Job objects are the way
// out, and the queue carries that as a follow-up.
//
// Commands go in through `submitToLeaf`, the app's own "run this" path, rather than raw
// bytes: a keystroke stream can sit in the line editor unsent, which would leave the
// shell idle while the check believes a command is running.
//
// It opens a terminal of its own and closes it again, so the user's tabs are read but
// never typed into.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result.result.value;
};

const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (p) => { const hits = urls.filter((n) => n.includes("/src/" + p)); return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + p); };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
`;
const NEWLINE = "String.fromCharCode(10)";

/**
 * The three answers for one leaf: the guard's own helper, and the two IPC commands
 * underneath it, next to what the screen shows.
 */
const answers = (leaf) =>
  pageEval(`
    ${MODULES}
    const guard = await api.leafHasForegroundProcess(${leaf});
    const pty = api.ptyIdForLeaf(${leaf});
    let process = "no-pty";
    let job = "no-pty";
    if (pty !== null) {
      try { process = await window.__TAURI_INTERNALS__.invoke("pty_has_foreground_process", { id: pty }); } catch (error) { process = String(error); }
      try { job = await window.__TAURI_INTERNALS__.invoke("pty_has_foreground_job", { id: pty }); } catch (error) { job = String(error); }
    }
    const tail = api.leafScreenTail(${leaf}) ?? "";
    const lines = tail.split(${NEWLINE}).map((l) => l.trim()).filter(Boolean);
    return JSON.stringify({ leaf: ${leaf}, pty, guard, process, job, screenTail: lines.slice(-3) });
  `);

const submit = (leaf, text) =>
  pageEval(`
    ${MODULES}
    api.submitToLeaf(${leaf}, ${JSON.stringify(text)});
    return true;
  `);

/** Poll one answer until both flags read `want`, or give up after `attempts` half-seconds. */
const until = async (leaf, want, attempts = 40) => {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = JSON.parse(await answers(leaf));
    if (last.guard === want && last.process === want) return last;
    await sleep(500);
  }
  return last;
};

const report = { liveTabsAtPrompt: [], phases: {} };
try {
  await send("Page.bringToFront");
  await sleep(600);

  // Every terminal that is already open must read "nothing running" while it sits at a
  // prompt. This is the reported bug: on Windows they all read busy.
  report.liveTabsAtPrompt = JSON.parse(
    await pageEval(`
      ${MODULES}
      const out = [];
      for (const session of sessions.ghosttySessionDiagnostics()) {
        let process = "err";
        try { process = await window.__TAURI_INTERNALS__.invoke("pty_has_foreground_process", { id: session.pty }); } catch (error) { process = String(error); }
        out.push({ leafId: session.leafId, pty: session.pty, process });
      }
      return JSON.stringify(out);
    `),
  );

  const before = JSON.parse(
    await pageEval(`
      ${MODULES}
      return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
    `),
  );

  // A terminal of the probe's own, opened the way a user opens one.
  for (const type of ["rawKeyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type,
      modifiers: 2,
      key: "t",
      code: "KeyT",
      windowsVirtualKeyCode: 84,
      nativeVirtualKeyCode: 84,
    });
  }
  const known = new Set(before);
  let leaf = null;
  for (let attempt = 0; attempt < 40 && leaf === null; attempt += 1) {
    await sleep(500);
    const now = JSON.parse(
      await pageEval(`
        ${MODULES}
        return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
      `),
    );
    leaf = now.find((candidate) => !known.has(candidate)) ?? null;
  }
  if (leaf === null) throw new Error("新会话没起来");
  report.leaf = leaf;

  // Wait for the shell to draw something, then let it settle at its prompt.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const tail = await pageEval(`
      ${MODULES}
      return api.leafScreenTail(${leaf}) ?? "";
    `);
    if (tail.trim().length > 0) break;
    await sleep(500);
  }
  await sleep(1500);

  // A: idle at the prompt. Every answer must be false.
  report.phases.prompt = JSON.parse(await answers(leaf));

  // B: a native command that outlives the check. Its process is a child of the shell on
  // Windows, so every answer must be true.
  await submit(leaf, "ping.exe -n 40 127.0.0.1");
  report.phases.nativeRunning = await until(leaf, true);

  // C: it comes back to the prompt. Ctrl+C is what a user presses to get there early,
  // and what follows it must read idle again.
  await pageEval(`
    ${MODULES}
    return api.interruptLeaf(${leaf});
  `);
  report.phases.nativeAfter = await until(leaf, false);

  // D: an MSYS command, for the record. Windows reports its parent as a process that is
  // already gone, so the shell cannot see it and the answer stays false. Not asserted:
  // this is the platform limit the header comment describes.
  await submit(leaf, "sleep 200");
  await sleep(2500);
  report.phases.msysRunning = JSON.parse(await answers(leaf));
  await pageEval(`
    ${MODULES}
    return api.interruptLeaf(${leaf});
  `);

  report.ok =
    report.phases.prompt.guard === false &&
    report.phases.prompt.process === false &&
    report.phases.prompt.job === false &&
    report.phases.nativeRunning.guard === true &&
    report.phases.nativeRunning.process === true &&
    report.phases.nativeAfter.guard === false &&
    report.phases.nativeAfter.process === false;

  // The probe's own tab goes away, the way a user closes one. The window's own strip
  // only: launcher panels carry [role=tab] too (they are the session list's switches),
  // and they have no close control.
  report.close = await pageEval(`
    const strip = [...document.querySelectorAll("[role=tab]")].filter((node) =>
      node.closest("[data-tauri-drag-region]"),
    );
    const tab = strip[strip.length - 1];
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (!close) return "no-close-control";
    const title = tab.textContent.trim();
    close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    close.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
    return title;
  `);
  await sleep(1500);
  report.after = JSON.parse(
    await pageEval(`
      ${MODULES}
      return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
    `),
  );
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();