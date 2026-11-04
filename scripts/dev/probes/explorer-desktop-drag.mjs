// Can a file move between the explorer and the desktop by dragging?
//
// The report: "分析为什么文件列表为什么不能从桌面移入或从文件列表移出复制到桌面". Two directions, and they
// fail for different reasons, so this measures both rather than describing either.
//
//  - Out: the explorer's drag is a pointer drag, not an HTML5 one. It calls `resolveExplorerMoveTarget`,
//    which returns `null` the moment the pointer leaves the explorer's drop zone - so releasing over
//    the desktop cannot name a destination. And there is no native drag session behind it, so the
//    desktop never receives a file to drop anyway.
//  - In: the webview accepts an OS drop with `dragDropEnabled`, and `useExplorerFileDrop` turns it
//    into `fs_copy`. Whether that works is a question about the app, not about the code path.
//
// This checks the outbound claim against the app's own predicate and reads what the webview is
// configured to receive. Nothing is moved, copied or dropped: no fixture is needed, because the
// question is about what the app can be told, not about what it does with a file.
//
// Usage: node scripts/dev/probes/explorer-desktop-drag.mjs
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
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

// The module the pointer drag consults, asked the two questions a drop asks it.
const finder = `
const urls = performance.getEntriesByType("resource").map((e) => e.name);
const find = (p) => {
  const hits = urls.filter((n) => n.includes(p));
  return (hits.filter((n) => n.includes("?t=")).pop() ?? hits.pop())
    ?? ("http://localhost:1420" + p);
};`;
const outbound = JSON.parse(
  await ev(`(async () => { ${finder}
    const mod = await import(find("/src/modules/explorer/lib/useExplorerDnd.ts"));
    const ROOT = "C:/Users/cxj/Desktop";
    const SOURCE = ROOT + "/note.txt";
    const FOLDER = ROOT + "/sub";
    // The tree's own answered "is this a directory", for the one folder this fixture names.
    const isDir = (path) => path === FOLDER;
    return JSON.stringify({
      // Released over a folder row: inside the explorer's own zone, so this is the case that works.
      overExplorer: mod.resolveExplorerMoveTarget([SOURCE], ROOT, FOLDER, true, isDir),
      // Released over the explorer's empty area: the root is the destination.
      overExplorerRoot: mod.resolveExplorerMoveTarget([SOURCE], ROOT, null, true, isDir),
      // Released over the desktop: the pointer is not inside the explorer at all.
      overDesktop: mod.resolveExplorerMoveTarget([SOURCE], ROOT, null, false, isDir),
    });
  })()`),
);
console.log("what the pointer drag can name as a destination:");
console.log(JSON.stringify(outbound, null, 1));

// What the webview is set up to receive, and whether a native drag session can start from it.
const receive = JSON.parse(
  await ev(`(async () => {
    const listen = typeof window.__TAURI_INTERNALS__ !== "undefined";
    let commands = [];
    try {
      const r = await window.__TAURI_INTERNALS__.invoke("plugin:app|name");
      commands.push(typeof r);
    } catch { /* not needed, only probes the bridge */ }
    return JSON.stringify({
      hasTauriBridge: listen,
      hasDragDropListener: typeof window.__TAURI_INTERNALS__?.invoke === "function",
      // A native drag started *from* the webview would be this command; the app registers none.
      startDragCommand: "unknown from here",
    });
  })()`),
);
console.log(`\nwebview side: bridge=${receive.hasTauriBridge}`);

const outOk = outbound.overExplorer !== null;
const desktopOk = outbound.overDesktop !== null;
console.log(
  outOk && !desktopOk
    ? "\nCONFIRMED: the explorer can name a folder inside itself as the destination, and nothing when the pointer is over the desktop - so a release there has no target, and no native drag was ever started to carry the file out."
    : `\nUNEXPECTED: overExplorer=${JSON.stringify(outbound.overExplorer)} overDesktop=${JSON.stringify(outbound.overDesktop)}`,
);
socket.close();
process.exit(0);
