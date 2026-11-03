// Does a commit make the filesystem watcher speak?
//
// The report: "刚才右侧工作区提交后要刷新才知道全部提交了 没实时更新". The source control panel had no
// subscription at all, so nothing could have told it - but the fix rests on one assumption that has
// to be true before the subscription is worth anything: that a `git commit` produces `fs:changed`
// events for the directories the panel registers.
//
// A commit writes only inside `.git` - the index, `logs/HEAD`, and the ref the branch points at -
// and the explorer's listing filter drops `.git` entirely, so those directories have to be asked
// for by name. This registers exactly what the panel now registers, commits in a repository of its
// own, and records which paths arrive and when. It never touches a repository of the user's.
//
// Usage: node scripts/dev/probes/commit-fires-watch-event.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = ["-c", "user.email=probe@example.com", "-c", "user.name=Probe"];
const run = (cwd, args) =>
  execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), "verta-probe-commit-")).replace(/\\/g, "/");
run(root, ["init", "--initial-branch=main"]);
writeFileSync(join(root, "a.txt"), "one\n");
run(root, ["add", "-A"]);
run(root, ["commit", "-m", "first"]);

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

// Register exactly what `useSourceControl` registers for a repository with no upstream.
const registered = await ev(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  await invoke("workspace_authorize", { path: ${JSON.stringify(root)}, workspace: { kind: "local" } });
  const dirs = [${JSON.stringify(root)}, ${JSON.stringify(`${root}/.git`)}, ${JSON.stringify(`${root}/.git/refs/heads`)}];
  window.__commitProbeEvents = [];
  const stop = await window.__TAURI_INTERNALS__.invoke("plugin:event|listen", {
    event: "fs:changed",
    target: { kind: "Any" },
    handler: window.__TAURI_INTERNALS__.transformCallback((e) => {
      window.__commitProbeEvents.push({ at: Date.now(), paths: e.payload.paths });
    }),
  });
  window.__commitProbeStop = stop;
  await invoke("fs_watch_add", {
    paths: [dirs[0]],
    files: [],
    includeSkipped: null,
    workspace: { kind: "local" },
  });
  await invoke("fs_watch_add", {
    paths: dirs.slice(1),
    files: [],
    includeSkipped: true,
    workspace: { kind: "local" },
  });
  return dirs;
})()`);
console.log("watching:", JSON.stringify(registered, null, 1));

await sleep(1200);
// Nothing has happened yet: a watch that speaks on its own would be useless as evidence.
const quiet = await ev(`JSON.stringify(window.__commitProbeEvents.length)`);
console.log(`events before the commit: ${quiet}`);

// A commit the panel did not make - the case the report is about.
const started = Date.now();
writeFileSync(join(root, "a.txt"), "two\n");
run(root, ["commit", "-am", "second"]);
console.log("committed in the fixture");

let seen = 0;
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  await sleep(250);
  seen = JSON.parse(await ev(`JSON.stringify(window.__commitProbeEvents.length)`));
  if (seen > 0) break;
}
const events = JSON.parse(await ev(`JSON.stringify(window.__commitProbeEvents)`));
const settleMs = events.length > 0 ? events[0].at - started : null;

const touches = await ev(`(async () => {
  const urls = performance.getEntriesByType("resource").map((e) => e.name);
  const hits = urls.filter((n) => n.includes("/src/lib/repoPath.ts"));
  const mod = await import((hits.filter((n) => n.includes("?t=")).pop() ?? hits.pop())
    ?? "http://localhost:1420/src/lib/repoPath.ts");
  const paths = ${JSON.stringify(events.flatMap((e) => e.paths))};
  return JSON.stringify({ paths, touches: mod.changeTouchesRepo(paths, ${JSON.stringify(root)}) });
})()`);
const verdict = JSON.parse(touches);

console.log(`events after the commit: ${seen} (first in ${settleMs ?? "—"} ms)`);
console.log("paths reported:", JSON.stringify(verdict.paths, null, 1));
console.log(
  verdict.touches
    ? "\nPASS: the commit reported directories the panel's predicate accepts."
    : "\nFAIL: the commit reported nothing the panel would re-read for.",
);

await ev(`(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  await invoke("fs_watch_remove", {
    paths: [${JSON.stringify(root)}],
    files: [],
    workspace: { kind: "local" },
  });
  await invoke("fs_watch_remove", {
    paths: [${JSON.stringify(`${root}/.git`)}, ${JSON.stringify(`${root}/.git/refs/heads`)}],
    files: [],
    workspace: { kind: "local" },
  });
  if (window.__commitProbeStop !== undefined) {
    await window.__TAURI_INTERNALS__.invoke("plugin:event|unlisten", { event: "fs:changed", eventId: window.__commitProbeStop });
  }
  return "released";
})()`);
socket.close();
rmSync(root, { recursive: true, force: true });
process.exit(verdict.touches ? 0 : 1);
