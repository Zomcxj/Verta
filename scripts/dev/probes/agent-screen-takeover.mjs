// What does an agent do to the screen when it starts, second by second?
//
// The opening cover waits for "the agent has taken the screen over", and the honest way
// to know what that looks like for a given agent is to watch one start. This opens a
// session from the list and samples, every 500 ms: whether the alternate screen is in
// use, how many bytes the leaf has taken in, and whether the launch command we wrote is
// still text on the visible screen.
//
// That last column is the thing the cover exists to hide, so it is also the column that
// says whether any given criterion is the right one.
//
// Usage: node scripts/dev/probes/agent-screen-takeover.mjs --title="名字" [--seconds=12]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const title = process.argv.find((a) => a.startsWith("--title="))?.slice(8) ?? null;
const seconds = Number(
  process.argv.find((a) => a.startsWith("--seconds="))?.slice(10) ?? "12",
);

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
  const find = (path) => {
    const hits = urls.filter((n) => n.includes("/src/" + path));
    return hits.find((n) => n.includes("?t=")) ?? hits[0] ?? ("/src/" + path);
  };
  const api = await import(find("modules/terminal/lib/terminalSessionApi.ts"));
  const ghostty = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
`;

const PRESS = `
  window.__probe = window.__probe || {};
  window.__probe.press = (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  };
  var press = window.__probe.press;
`;

const SAMPLE = `
  ${MODULES}
  const diagnostic = ghostty.ghosttySessionDiagnostics().find((d) => d.visible) ?? null;
  const leaf = diagnostic ? diagnostic.leafId : null;
  if (leaf === null) return JSON.stringify({ leaf: null });
  const screen = api.leafScreenTail(leaf) ?? "";
  const lines = screen.split(String.fromCharCode(10));
  return JSON.stringify({
    leaf,
    alt: ghostty.ghosttyLeafUsesAlternateScreen(leaf),
    bytes: api.leafOutputBytes(leaf),
    hasChild: await api.leafHasForegroundProcess(leaf),
    rows: lines.length,
    // The launch line itself: the shell echoes what we wrote.
    commandOnScreen: /pi --session|opencode --session|pi$/.test(screen),
    firstLine: (lines.find((l) => l.trim().length > 0) ?? "").trim().slice(0, 60),
  });
`;

const report = { title, samples: [] };
try {
  await send("Page.bringToFront");
  await sleep(600);
  report.launcher = await pageEval(`
    ${PRESS}
    const rail = [...document.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") || b.textContent || "").trim() === "会话",
    );
    if (!rail) return "no-rail-button";
    press(rail);
    return "pressed";
  `);
  await sleep(2500);

  report.titles = await pageEval(
    `return JSON.stringify([...document.querySelectorAll("button[data-session-id]")].map((r) => (r.getAttribute("title") || "").trim()))`,
  );
  const open = await pageEval(`
    ${PRESS}
    const rows = [...document.querySelectorAll("button[data-session-id]")];
    const row = rows.find((r) => (r.getAttribute("title") || "").trim() === ${JSON.stringify(title)});
    if (!row) return "no-row";
    press(row);
    return (row.getAttribute("title") || "").trim();
  `);
  report.open = open;
  if (open === "no-row") throw new Error(`找不到会话行 ${title}`);

  const started = Date.now();
  for (let i = 0; i < Math.ceil((seconds * 1000) / 500); i += 1) {
    await sleep(500);
    const sample = JSON.parse(await pageEval(SAMPLE));
    report.samples.push({ ms: Date.now() - started, ...sample });
    if (sample.leaf === null) break;
  }
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();