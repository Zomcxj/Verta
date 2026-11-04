// Does a drop that lands on a name the folder already holds ask, and then do what was asked?
//
// The report: "拖入有同名的只警告 没有覆盖或者跳过选项". The copy used to refuse the whole name and
// report it as a failure, so the only way forward was to delete the old file first. Now the front
// end asks first: `fs_copy_conflicts` names what would be replaced, and the answer decides between
// `fs_copy_replacing` (replace) and copying only the rest (skip).
//
// This drives those three commands the way the drop does, against a fixture of its own. It never
// touches a repository or a folder of the user's, and it reads back the files afterwards, because
// the question here is what ends up on disk, not what the command returned.
//
// Usage: node scripts/dev/probes/copy-drop-conflict.mjs
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "verta-probe-drop-")).replace(/\\/g, "/");
const from = `${root}/from`;
const to = `${root}/to`;
const w = (path, text) => writeFileSync(join(root, path), text);

mkdirSync(`${from}/dir`, { recursive: true });
mkdirSync(`${to}/dir`, { recursive: true });
w("from/a.txt", "new A");
w("from/b.txt", "new B");
w("from/dir/x.txt", "new X");
w("from/dir/only-new.txt", "new Y");
w("to/a.txt", "old A");
w("to/dir/z.txt", "old Z");

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

const sources = [`${from}/a.txt`, `${from}/b.txt`, `${from}/dir`];
const read = () => ({
  a: readFileSync(join(to, "a.txt"), "utf8"),
  b: (() => {
    try {
      return readFileSync(join(to, "b.txt"), "utf8");
    } catch {
      return null;
    }
  })(),
  dir: readdirSync(join(to, "dir")).sort(),
  staging: readdirSync(to).filter((n) => n.startsWith(".verta-copy-")),
});

// 1. What the drop is told before it copies anything. Must be exactly the two names already there.
const conflicts = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("workspace_authorize", { path: ${JSON.stringify(root)}, workspace: { kind: "local" } });
    const conflicts = await invoke("fs_copy_conflicts", {
      sources: ${JSON.stringify(sources)},
      destDir: ${JSON.stringify(to)},
      workspace: { kind: "local" },
    });
    return JSON.stringify(conflicts);
  })()`),
);
const conflictsOk =
  conflicts.length === 2 &&
  conflicts.includes(`${from}/a.txt`) &&
  conflicts.includes(`${from}/dir`);

// 2. "Skip": the conflicting sources are dropped before the copy, so nothing is replaced.
const skipped = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const keep = new Set(${JSON.stringify(conflicts)});
    const rest = ${JSON.stringify(sources)}.filter((p) => !keep.has(p));
    const result = await invoke("fs_copy", {
      sources: rest,
      destDir: ${JSON.stringify(to)},
      root: ${JSON.stringify(root)},
      workspace: { kind: "local" },
    });
    return JSON.stringify(result);
  })()`),
);
const afterSkip = read();
const skipOk =
  afterSkip.a === "old A" &&
  afterSkip.b === "new B" &&
  afterSkip.dir.join(",") === "z.txt";

// 3. "Replace": the two conflicting sources go in over what was there.
const replaced = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const result = await invoke("fs_copy_replacing", {
      sources: ${JSON.stringify([`${from}/a.txt`, `${from}/dir`])},
      destDir: ${JSON.stringify(to)},
      root: ${JSON.stringify(root)},
      workspace: { kind: "local" },
    });
    return JSON.stringify(result);
  })()`),
);
const afterReplace = read();
const replaceOk =
  afterReplace.a === "new A" &&
  afterReplace.dir.join(",") === "only-new.txt,x.txt" &&
  afterReplace.staging.length === 0;

console.log("conflicts named by the question:", JSON.stringify(conflicts, null, 1));
console.log(`after skip:    ${JSON.stringify({ ...afterSkip, staging: undefined })}`);
console.log(`after replace: ${JSON.stringify({ ...afterReplace, staging: undefined })}`);
console.log(`failed entries: skip=${skipped.failed.length} replace=${replaced.failed.length}`);
if (afterReplace.staging.length > 0) {
  console.log("leftover staging:", afterReplace.staging);
}

const pass = conflictsOk && skipOk && replaceOk;
console.log(
  pass
    ? "\nPASS: the drop is told which names clash, skip leaves them untouched, and replace puts the new ones in their place."
    : `\nFAIL: conflictsOk=${conflictsOk} skipOk=${skipOk} replaceOk=${replaceOk}`,
);

socket.close();
rmSync(root, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
