// Close the tabs the acceptance probes opened, and put the user's tab back.
//
// Acceptance hygiene: a probe that opens a session to watch it must close it again.
// The agents these tabs ran are interrupted first (Ctrl+C), so the close guard has
// nothing to ask about; if it asks anyway, the dialog's confirm button is pressed.
//
// Usage: node scripts/dev/probes/close-probe-tabs.mjs --titles=名字1,名字2 --restore=README.md
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const titles = (
  process.argv.find((a) => a.startsWith("--titles="))?.slice(9) ?? ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const restore = process.argv.find((a) => a.startsWith("--restore="))?.slice(10);

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
  const sessions = await import(find("modules/terminal/ghostty/useGhosttyTerminalSession.ts"));
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

const strip = () =>
  pageEval(
    `return JSON.stringify([...document.querySelectorAll("[role=tab][data-tab-id]")].map((n) => ({ text: (n.textContent || "").trim(), active: n.hasAttribute("data-tab-active") })))`,
  );

const report = {};
try {
  await send("Page.bringToFront");
  await sleep(500);
  report.stripBefore = JSON.parse(await strip());

  for (const title of titles) {
    if (!report.stripBefore.some((t) => t.text === title)) {
      report[`skip:${title}`] = "not open";
      continue;
    }
    // Activate, then interrupt whatever agent is running in it, so the close guard
    // has no running command to ask about.
    report[`activate:${title}`] = await pageEval(`
      ${PRESS}
      const tab = [...document.querySelectorAll("[role=tab][data-tab-id]")].find(
        (n) => (n.textContent || "").trim() === ${JSON.stringify(title)},
      );
      if (!tab) return "no-tab";
      press(tab);
      return "active";
    `);
    await sleep(1200);
    report[`interrupt:${title}`] = await pageEval(`
      ${MODULES}
      const visible = sessions.ghosttySessionDiagnostics().find((d) => d.visible);
      if (!visible) return "no-visible-session";
      api.interruptLeaf(visible.leafId);
      return visible.leafId;
    `);
    await sleep(1200);
    report[`close:${title}`] = await pageEval(`
      ${PRESS}
      const tab = [...document.querySelectorAll("[role=tab][data-tab-id]")].find(
        (n) => (n.textContent || "").trim() === ${JSON.stringify(title)},
      );
      if (!tab) return "no-tab";
      const close = tab.querySelector("[data-no-drag][role=button]");
      if (!close) return "no-close-control";
      press(close);
      return "pressed";
    `);
    await sleep(900);
    report[`dialog:${title}`] = await pageEval(`
      ${PRESS}
      const dialog = document.querySelector("[role=alertdialog]");
      if (!dialog) return "none";
      const buttons = [...dialog.querySelectorAll("button")];
      const confirm = buttons[buttons.length - 1];
      if (!confirm) return "no-buttons";
      press(confirm);
      return (confirm.textContent || "").trim();
    `);
    await sleep(1200);
  }

  if (restore) {
    report.restore = await pageEval(`
      ${PRESS}
      const tab = [...document.querySelectorAll("[role=tab][data-tab-id]")].find(
        (n) => (n.textContent || "").trim() === ${JSON.stringify(restore)},
      );
      if (!tab) return "not-open";
      press(tab);
      return "active";
    `);
    await sleep(900);
  }
  report.stripAfter = JSON.parse(await strip());
  report.ok = true;
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();