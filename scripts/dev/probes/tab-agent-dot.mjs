// Does the tab strip actually show the agent's state, and does the header count it?
// The judge writing the store is one thing; a dot a user can see is another, and the
// path between them (the store's leaf map, the tab selector, the chip's render, the
// and its unseen bar) is what this checks.
//
// It opens a terminal tab of its own, puts each screen on it, and reads the
// interface's own DOM: which chip carries a dot, with what state and what label, and
// what the tab strip draws. The screenshot is for the eye; the DOM is the evidence.
// The tab is closed again, and the user's other tabs are read too, since a dot must
// not appear on them.
//
// The tab is opened for an agent (through the app's own `newAgentTab`, via its DEV
// hook) rather than with Ctrl+T: a plain terminal tab has the terminal's icon, and the
// state marker is only drawn where the icon is the agent's - so the screens below could
// have been put on a plain tab and read as no dot at all. No agent is started on it: the
// screens this writes are the only thing the judge can be reading.
//
// The colour and the breathing are read as computed style rather than as class names:
// the states' colours and the fact that they all breathe are a contract with the
// user, and a stylesheet alone can break either while the classes still read right.
// The background image is read for the same reason as the colour: the state that is a
// blend of two colours has nothing in `background-color` at all, so a probe that reads
// only the colour reports it as transparent and cannot tell a blend from a missing dot.
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
        image: s.backgroundImage,
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

  // The tab this drives has to be one whose icon is the agent's, because that is the only tab the
  // state marker is drawn on (`lib/tabAgentIcon.ts`): a tab opened with Ctrl+T has the terminal's
  // icon, and no amount of opencode-looking output on it earns a dot. The app's own path for such a
  // tab is `newAgentTab`, which this reaches through its DEV hook; the agent is *not* started on it,
  // so the screens this writes are the only thing the judge can be reading. Before this, the probe
  // opened a plain tab and passed only because the marker's condition read `tab.agent !== null`,
  // which is true for a tab with no `agent` property at all.
  const opened = await pageEval(`
    const open = window.__vertaNewAgentTab;
    if (!open) return JSON.stringify({ error: "没有 __vertaNewAgentTab（dev 构建才有）" });
    return JSON.stringify(open(undefined, "probe", "opencode"));
  `);
  const openedTab = JSON.parse(opened);
  if (openedTab.error) throw new Error(openedTab.error);
  report.openedTab = openedTab;

  const known = new Set(JSON.parse(before));
  let target = openedTab.leafId ?? null;
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

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(`${process.env.TEMP}/v`, { recursive: true });

  /** The active tab's chip, magnified, so what it looks like is kept and not only what it is called. */
  const chipShot = async (label) => {
    const rect = JSON.parse(
      await pageEval(`
        const tab = [...document.querySelectorAll("[role=tab]")].find((t) => t.getAttribute("data-tab-active") === "true");
        const dot = tab?.querySelector("[data-agent-state]");
        if (!dot) return JSON.stringify(null);
        const box = dot.getBoundingClientRect();
        return JSON.stringify({ x: box.x - 3, y: box.y - 3, width: box.width + 6, height: box.height + 6 });
      `),
    );
    if (!rect) return null;
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      clip: { ...rect, scale: 12 },
    });
    const path = `${process.env.TEMP}/v/tab-agent-dot-${label}.png`;
    writeFileSync(path, Buffer.from(shot.result.data, "base64"));
    return path;
  };

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
    // What the judge was reading when it decided: a fixture that prints the wrong thing and a rule
    // that reads the right thing wrongly look the same in the states alone.
    report[`${label}Tail`] = await pageEval(`
      ${MODULES}
      return api.leafScreenTail(${target}) ?? "";
    `);
    // And a picture of the chip, magnified: a mixed state's colour is only half of what it looks like
    // (a ring with a hole in it can be read as a solid dot in a computed style), so the pixels are
    // kept for the eye as well as the numbers for the report.
    report[`${label}Chip`] = await chipShot(label);
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
  // The turn is over and the tool's own work is not: the footer counts a shell of its own and
  // nothing on the screen is being painted. Drawn as work in flight this read as an agent that
  // never finishes; drawn as rest it hid the job. Measured on this machine (2026-10-31,
  // `idle-screen.log`, 121 screens sampled while nothing was driving the session), and the footer
  // below is that measurement with the session's own path in front of it.
  //
  // The trailing `sleep` is not decoration: a plain shell prints its prompt below whatever it is
  // told to print, so a fixture without it ends on `$`, and the judge reads the prompt rather than
  // the footer (measured: the region is the last two non-empty lines, and the reading came out as
  // the state of a bare prompt). Holding the prompt back for five seconds is what makes these the
  // last lines on the screen, the way opencode's own drawing does. That is also why the two steps
  // around it wait as long as they do: this step reads while the prompt is still held back, and the
  // next one writes its `clear` into a shell that is asleep, where it runs five seconds later - a
  // wait of 3.5 s then reads the cleared screen 1.7 s after it appeared, which is less than the
  // 2 s a leaf has to stay unrecognized before the judge lets it go (measured: that run reported
  // the fixture's state instead of a cleared tab).
  await step(
    "trailing",
    'echo "…\\\\Verta:ma…  命中率 99.8% ↑0.7% · Tokens 2232.6M · 余额 -   ↓ 1 shell · ◎ goal paused · 319.7K (64%)  ctrl+p commands" ; sleep 5',
    3000,
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
  const { dirname } = await import("node:path");
  const shotPath = `${process.env.TEMP}/v/tab-agent-dot.png`;
  mkdirSync(dirname(shotPath), { recursive: true });
  writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
  report.shot = shotPath;

  // The agent leaves: no dot on a shell prompt again. The wait is longer than this step's own work
  // needs, because the `clear` it writes lands in a shell that is still holding the prompt back.
  await step("cleared", "", 5000);

  // Its own tab, found by the id it was opened with. The last `[role=tab]` in the document is not
  // this tab: the session panel's filter chips are tabs too and come after it in the DOM, so "the
  // last one" was the panel's chip and this step reported `no-close-control` while leaving the
  // fixture in the user's strip - measured, the tab it opened was still there afterwards.
  report.closeTarget = await pageEval(`
    const tab = document.querySelector('[data-tab-id="${openedTab.tabId}"]');
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