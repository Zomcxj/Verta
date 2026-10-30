// Drive an agent in a scratch directory and record what its screen does.
//
// The state rules each agent family is judged by have to come from its real screen: a rule
// written from a guess is worse than no rule, because a false positive shows the user an
// agent that is waiting when nothing is. This is the tool that produces those screens: it
// opens a terminal tab, walks it to a scratch directory, starts the agent, and then records
// every distinct screen frame with the millisecond it appeared, while the caller types at it
// from outside (`--stage=say` / `--stage=key`).
//
// Frames are appended as they appear rather than written at the end, so the recorder can run
// in the background while another stage drives the agent, and so a crashed run still leaves
// what it saw. Everything it starts is meant to be thrown away afterwards: the scratch
// directory is the caller's, and so is the session the agent creates inside it.
//
// Usage:
//   node scripts/dev/probes/agent-lab.mjs --stage=start --dir="C:/Users/x/Temp/verta-probe" --agent=pi
//   node scripts/dev/probes/agent-lab.mjs --stage=sample --seconds=40 --out="C:/.../pi.jsonl"
//   node scripts/dev/probes/agent-lab.mjs --stage=say --text="列出这个目录里的文件"
//   node scripts/dev/probes/agent-lab.mjs --stage=key --chord=Enter
//   node scripts/dev/probes/agent-lab.mjs --stage=cwd
//   node scripts/dev/probes/agent-lab.mjs --stage=frames --out="C:/.../pi.jsonl"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
const stage = arg("stage");
const dir = arg("dir");
const agent = arg("agent") ?? "pi";
const out = arg("out");
const text = arg("text");
const chord = arg("chord");
const seconds = Number(arg("seconds") ?? "40");

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

/** The app's own modules, reached the way the probes already do it. */
const MODULES = `
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
`;

/** The leaf the user is looking at: the visible one of the active tab, plus its screen. */
const VISIBLE = `
  ${MODULES}
  const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
  const leaf = visible ? visible.leafId : null;
  const tab = document.querySelector("[data-terminal-tab]");
  const state = {
    leaf,
    cwd: leaf === null ? null : api.leafCwd(leaf),
    tabOpacity: tab ? getComputedStyle(tab).opacity : null,
    tabCount: document.querySelectorAll("[data-terminal-tab]").length,
    alt: leaf === null ? null : api.leafUsesAlternateScreen(leaf),
    bytes: leaf === null ? null : api.leafOutputBytes(leaf),
    screen: leaf === null ? null : (api.leafScreenTail(leaf) ?? ""),
  };
`;

/** A real key press, the way the terminal sees one. */
const CHORDS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r", modifiers: 0 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27, text: "", modifiers: 0 },
  "Ctrl+C": { key: "c", code: "KeyC", keyCode: 67, text: "", modifiers: 2 },
  "Ctrl+D": { key: "d", code: "KeyD", keyCode: 68, text: "", modifiers: 2 },
  "Ctrl+T": { key: "t", code: "KeyT", keyCode: 84, text: "", modifiers: 2 },
};

const pressChord = async (name) => {
  const spec = CHORDS[name];
  if (!spec) throw new Error(`未定义的键：${name}`);
  const base = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    nativeVirtualKeyCode: spec.keyCode,
    modifiers: spec.modifiers,
  };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: spec.text });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: "" });
};

const report = { stage, dir, agent };

try {
  await send("Page.bringToFront");
  await sleep(400);

  if (stage === "start") {
    const before = JSON.parse(await pageEval(`${VISIBLE}\n  return JSON.stringify(state);`));
    report.before = { leaf: before.leaf, cwd: before.cwd, tabs: before.tabCount };
    // A default terminal tab, then the scratch directory is reached by typing into it,
    // which is what a person does and leaves the tab's cwd as the scratch one.
    await pressChord("Ctrl+T");
    let leaf = null;
    for (let i = 0; i < 40 && leaf === null; i += 1) {
      await sleep(250);
      const state = JSON.parse(await pageEval(`${VISIBLE}\n  return JSON.stringify(state);`));
      if (state.leaf !== null && state.leaf !== before.leaf) leaf = state.leaf;
    }
    if (leaf === null) throw new Error("Ctrl+T 之后没看到新的终端叶子");
    report.leaf = leaf;
    await sleep(1200);
    const cwd = dir.replace(/\\/g, "/");
    await pageEval(
      `${MODULES}\n  return api.writeToSession(${leaf}, ${JSON.stringify(`cd "${cwd}"\r`)});`,
    );
    await sleep(1500);
    await pageEval(
      `${MODULES}\n  return api.writeToSession(${leaf}, ${JSON.stringify(`${agent}\r`)});`,
    );
    report.after = JSON.parse(
      await pageEval(`${VISIBLE}\n  return JSON.stringify({ cwd: state.cwd, alt: state.alt });`),
    );
  }

  if (stage === "sample") {
    if (!out) throw new Error("--out 要给出采样文件");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, "");
    const started = Date.now();
    let previous = null;
    let frames = 0;
    while (Date.now() - started < seconds * 1000) {
      const sample = JSON.parse(await pageEval(`${VISIBLE}\n  return JSON.stringify(state);`));
      const key = `${sample.alt}|${sample.screen}`;
      if (key !== previous) {
        previous = key;
        frames += 1;
        appendFileSync(
          out,
          `${JSON.stringify({ ms: Date.now() - started, alt: sample.alt, bytes: sample.bytes, screen: sample.screen })}\n`,
        );
      }
      await sleep(200);
    }
    report.frames = frames;
    report.out = out;
  }

  if (stage === "say") {
    if (!text) throw new Error("--text 要给出内容");
    const state = JSON.parse(await pageEval(`${VISIBLE}\n  return JSON.stringify(state);`));
    if (state.leaf === null) throw new Error("没有可见的终端");
    report.leaf = state.leaf;
    report.cwd = state.cwd;
    await pageEval(
      `${MODULES}\n  return api.writeToSession(${state.leaf}, ${JSON.stringify(`${text}\r`)});`,
    );
    report.said = text;
  }

  if (stage === "key") {
    await pressChord(chord);
    report.key = chord;
  }

  if (stage === "cwd") {
    const state = JSON.parse(await pageEval(`${VISIBLE}\n  return JSON.stringify(state);`));
    report.cwd = state.cwd;
    report.alt = state.alt;
    report.leaf = state.leaf;
    report.tail = (state.screen ?? "").split("\n").slice(-16);
  }

  if (stage === "close-guarded") {
    // The close guard sits behind a preference the user can turn off (and on this machine
    // they have: it is off, so the guard is skipped outright and nothing would be proven
    // by clicking). This stage turns it on, clicks the active tab's close button the way a
    // person does, reads what the app did, and puts the preference back.
    const flip = await pageEval(`
      ${MODULES}
      const settings = await import(find("modules/settings/store.ts"));
      const prefs = await import(find("modules/settings/preferences.ts"));
      const before = prefs.usePreferencesStore.getState().confirmCloseRunningTerminal;
      await settings.setConfirmCloseRunningTerminal(true);
      return JSON.stringify({ before });
    `);
    report.preferenceBefore = JSON.parse(flip).before;
    await sleep(400);
    report.preferenceArmed = JSON.parse(
      await pageEval(`
        ${MODULES}
        const prefs = await import(find("modules/settings/preferences.ts"));
        return JSON.stringify({ value: prefs.usePreferencesStore.getState().confirmCloseRunningTerminal });
      `),
    ).value;

    const target = await pageEval(`
      const tab = document.querySelector('[role=tab][data-tab-active="true"]');
      if (!tab) return null;
      const close = tab.querySelector("[data-no-drag][role=button]");
      if (!close) return null;
      const r = close.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, title: (tab.textContent || "").trim().slice(0, 30) });
    `);
    if (!target) throw new Error("没找到活动标签的关闭按钮");
    const at = JSON.parse(target);
    report.closeButton = at;
    for (let i = 0; i < 2; i += 1) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
      await sleep(120);
    }
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await sleep(900);
    report.afterClick = JSON.parse(
      await pageEval(`
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((el) => ({
          title: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 90),
        }));
        return JSON.stringify({
          dialogs,
          tabs: [...document.querySelectorAll('[role=tab]')].map((t) => (t.textContent || "").trim().slice(0, 24)),
        });
      `),
    );

    const restore = await pageEval(`
      ${MODULES}
      const settings = await import(find("modules/settings/store.ts"));
      const prefs = await import(find("modules/settings/preferences.ts"));
      await settings.setConfirmCloseRunningTerminal(${JSON.stringify(report.preferenceBefore)});
      return JSON.stringify({ value: prefs.usePreferencesStore.getState().confirmCloseRunningTerminal });
    `);
    await sleep(400);
    report.preferenceRestored = JSON.parse(
      await pageEval(`
        ${MODULES}
        const prefs = await import(find("modules/settings/preferences.ts"));
        return JSON.stringify({ value: prefs.usePreferencesStore.getState().confirmCloseRunningTerminal });
      `),
    ).value;
    report.preferenceRestoredWrite = JSON.parse(restore).value;
  }

  if (stage === "close") {
    // Click the active tab's close button as a person does, then read what the app did
    // about it. The close guards are what this stage exists for: the claim under test is
    // that a running agent is noticed even when the kernel query cannot see it.
    const target = await pageEval(`
      const tab = document.querySelector('[role=tab][data-tab-active="true"]');
      if (!tab) return null;
      const close = tab.querySelector("[data-no-drag][role=button]");
      if (!close) return null;
      const r = close.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, title: (tab.textContent || "").trim().slice(0, 30) });
    `);
    if (!target) throw new Error("没找到活动标签的关闭按钮");
    const at = JSON.parse(target);
    report.closeButton = at;
    for (let i = 0; i < 2; i += 1) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
      await sleep(120);
    }
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
    await sleep(800);
    report.afterClick = JSON.parse(
      await pageEval(`
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((el) => ({
          title: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
          label: el.getAttribute("aria-label"),
        }));
        return JSON.stringify({
          dialogs,
          tabs: [...document.querySelectorAll('[role=tab]')].map((t) => (t.textContent || "").trim().slice(0, 24)),
        });
      `),
    );
  }

  if (stage === "state") {
    // What the app itself decided: the activity store's phase for the visible leaf, and
    // the dot the strip draws from it. The judge's unit tests prove the decision over
    // text; this is the evidence that a live pi screen reaches it.
    const state = JSON.parse(
      await pageEval(`
        ${MODULES}
        const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
        const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
        const leaf = visible ? visible.leafId : null;
        const pty = leaf === null ? null : api.ptyIdForLeaf(leaf);
        const store = activity.useAgentActivityStore.getState();
        return JSON.stringify({
          leaf,
          pty,
          agent: pty === null ? null : (store.agents[pty] ?? null),
          phase: pty === null ? null : (store.phases[pty] ?? null),
          // The kernel's own answer, for comparison with what the screen says.
          hasChild: leaf === null ? null : await api.leafHasForegroundProcess(leaf),
          tabs: [...document.querySelectorAll("[role=tab]")].map((tab) => {
            const dot = tab.querySelector("[data-agent-state]");
            return {
              title: (tab.textContent || "").trim().slice(0, 24),
              active: tab.getAttribute("data-tab-active") === "true",
              dot: dot ? dot.getAttribute("data-agent-state") : null,
              label: dot ? dot.getAttribute("aria-label") : null,
            };
          }),
        });
      `),
    );
    report.state = state;
  }

  if (stage === "dump") {
    // The whole screen, verbatim, into a file: a rule is written from a screen, so the
    // screen has to be kept exactly as the terminal model reported it.
    if (!out) throw new Error("--out 要给出落盘文件");
    const state = JSON.parse(await pageEval(`${VISIBLE}\n  return JSON.stringify(state);`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, state.screen ?? "");
    report.out = out;
    report.cwd = state.cwd;
    report.alt = state.alt;
    report.bytes = state.bytes;
    report.rows = (state.screen ?? "").split("\n").length;
    report.bottom = (state.screen ?? "").split("\n").slice(-10);
  }

  if (stage === "frames") {
    // Read back what a sampling run recorded, as screens with their times, so the caller
    // does not have to open the file itself.
    if (!out) throw new Error("--out 要给出采样文件");
    const lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
    report.count = lines.length;
    report.frames = lines.map((line) => {
      const frame = JSON.parse(line);
      return {
        ms: frame.ms,
        alt: frame.alt,
        bytes: frame.bytes,
        lines: (frame.screen ?? "")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .slice(-14),
      };
    });
  }

  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();