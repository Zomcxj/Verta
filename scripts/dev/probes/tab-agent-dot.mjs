// Does the tab strip actually show the agent's state, and does the header count it?
// The judge writing the store is one thing; a dot a user can see is another, and the
// path between them (the store's leaf map, the tab selector, the chip's render, the
// and its unseen bar) is what this checks.
//
// It opens a plain terminal of its own, puts each screen on it, and reads the
// interface's own DOM: which chip carries a dot, with what state and what label, and
// what the tab strip draws. The screenshot is for the eye; the DOM is the evidence.
// The tab is closed again, and the user's other tabs are read too, since a dot must
// not appear on them.
//
// The colour and the breathing are read as computed style rather than as class names:
// the three states' colours and the fact that all three breathe are a contract with the
// user, and a stylesheet alone can break either while the classes still read right.
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
  const activity = await import(find("modules/terminal/lib/agentActivity.ts"));
`;

/** Every chip in the strip, with the dot it carries (if any). */
const tabStrip = () =>
  pageEval(`
    // What the classes put on screen, not just what they are called: the colour and the
    // breathing are the contract here, and both can be broken by a stylesheet alone.
    const look = (el) => {
      const s = getComputedStyle(el);
      return {
        colour: s.backgroundColor,
        animation: s.animationName,
        timing: s.animationTimingFunction,
        play: s.animationPlayState
      };
    };
    return JSON.stringify({
      tabs: [...document.querySelectorAll("[role=tab]")].map((tab) => {
        const dot = tab.querySelector("[data-agent-state]");
        const bar = tab.querySelector("[data-agent-unseen]");
        return {
          title: (tab.textContent || "").trim(),
          active: tab.getAttribute("data-tab-active") === "true",
          dot: dot
            ? {
                state: dot.getAttribute("data-agent-state"),
                label: dot.getAttribute("aria-label"),
                className: dot.getAttribute("class"),
                size: dot.getBoundingClientRect().width,
                ...look(dot)
              }
            : null,
          unseenBar: bar ? look(bar) : null
        };
      }),
    });
  `);

const report = {};
try {
  await send("Page.bringToFront");
  await sleep(600);
  const before = await pageEval(`
    ${MODULES}
    return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
  `);
  report.stripBefore = JSON.parse(await tabStrip());

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

  const known = new Set(JSON.parse(before));
  let target = null;
  for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
    await sleep(500);
    const now = JSON.parse(
      await pageEval(`
        ${MODULES}
        return JSON.stringify(sessions.ghosttySessionDiagnostics().map((s) => s.leafId));
      `),
    );
    target = now.find((leaf) => !known.has(leaf)) ?? null;
  }
  if (target === null) throw new Error("新会话没起来");
  report.leaf = target;

  const runCommand = (command) =>
    pageEval(`
      ${MODULES}
      return api.writeToSession(${target}, ${JSON.stringify(`${command}\r`)});
    `);

  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    await sleep(500);
    ready =
      (
        await pageEval(`
          ${MODULES}
          return api.leafScreenTail(${target}) ?? "";
        `)
      ).trim().length > 0;
  }
  if (!ready) throw new Error("shell 没起来");

  // A bare prompt must not draw a dot anywhere.
  await sleep(1500);
  report.stripAtPrompt = JSON.parse(await tabStrip());

  const step = async (label, screen, waitMs = 2200) => {
    await runCommand(`clear ; ${screen}`);
    await sleep(waitMs);
    report[label] = JSON.parse(await tabStrip());
  };

  // The three states, in the colours the user asked for, and each of them breathing: an agent
  // at its prompt has ended a turn (green, not a fourth quiet state), one that is thinking is
  // working (orange), and one that has stopped to ask is asking (blue).
  await step(
    "finished",
    'echo "Where to next?" ; echo "ctrl+p commands   · Tokens 12.4k"',
  );
  await step(
    "working",
    'echo "⠹ Thinking" ; echo "ctrl+p commands   · Tokens 12.4k"',
  );
  await step(
    "asking",
    'echo "△ Permission required" ; echo "  Allow once" ; echo "ctrl+p commands"',
  );

  for (const [x, y] of [
    [700, 300],
    [720, 320],
  ]) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await sleep(150);
  }
  await sleep(400);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const shotPath = `${process.env.TEMP}/v/tab-agent-dot.png`;
  mkdirSync(dirname(shotPath), { recursive: true });
  writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  report.shot = shotPath;

  // The agent leaves: no dot on a shell prompt again.
  await step("cleared", "", 3500);

  report.closeTarget = await pageEval(`
    const tabs = [...document.querySelectorAll("[role=tab]")];
    const tab = tabs[tabs.length - 1];
    const close = tab?.querySelector("[data-no-drag][role=button]");
    if (!close) return "no-close-control";
    close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    close.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, buttons: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" }));
    close.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, buttons: 0 }));
    return tab.textContent.trim();
  `);
  await sleep(1500);
  report.stripAfter = JSON.parse(await tabStrip());
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();