// Does the panel's own path resolve a repository that is one level down?
//
// The report: "可以通过右键在源代码管理中打开 但是有个bug,本来侧边打开的面板会被隐藏". Two questions behind it:
//  1. a right-click on a repository shows "在源代码管理中打开" - so the app can see the repository;
//  2. the panel, pointed at the same folder, says "没有仓库 - 当前工作区不在 Git 仓库内" - so the
//     panel's own path cannot.
// The second is the one that matters: `openInSourceControl` asks `git_resolve_repo`, which shells
// out to `git rev-parse --show-toplevel` from the folder. A repository whose `.git` sits in a
// subfolder is not found from its parent, whatever the explorer's own decoration says.
//
// This asks the same command the panel asks, for the folder and for the repository below it, and
// prints both. A fixture of the probe's own; nothing of the user's is resolved or read.
//
// Usage: node scripts/dev/probes/resolve-repo-one-level-down.mjs [--folder=D:/VsPro/PTZ]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folderArg = process.argv.find((a) => a.startsWith("--folder="))?.slice(9);
const fixture = mkdtempSync(join(tmpdir(), "verta-probe-resolve-")).replace(/\\/g, "/");
const root = folderArg ? folderArg.replace(/\\/g, "/") : fixture;
const repo = `${fixture}/pkg/repo`;
if (!folderArg) {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", repo], { encoding: "utf8" });
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.email=p@e", "-c", "user.name=P", "commit", "--allow-empty", "-m", "one"],
    { encoding: "utf8" },
  );
}
const inner = folderArg ? `${root}/rdk/ptz_rdk` : repo;

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
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(ex.exception?.description ?? ex.text);
  return r.result?.result?.value;
};

const resolved = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("workspace_authorize", { path: ${JSON.stringify(root)}, workspace: { kind: "local" } });
    const ask = async (folder) => {
      try {
        const repo = await invoke("git_resolve_repo", { cwd: folder, workspace: { kind: "local" } });
        return repo ? repo.repoRoot : null;
      } catch (error) {
        return "error: " + String(error);
      }
    };
    return JSON.stringify({
      folder: ${JSON.stringify(root)},
      fromFolder: await ask(${JSON.stringify(root)}),
      inner: ${JSON.stringify(inner)},
      fromInner: await ask(${JSON.stringify(inner)}),
    });
  })()`),
);
console.log(JSON.stringify(resolved, null, 1));

const folderResolves = resolved.fromFolder !== null && !String(resolved.fromFolder).startsWith("error:");
const innerResolves = resolved.fromInner !== null && !String(resolved.fromInner).startsWith("error:");
console.log(
  !folderResolves && innerResolves
    ? "\nCONFIRMED: the folder itself resolves to no repository, the repository below it resolves - so a panel pointed at the folder has nothing to show, and only a click on the repository itself reaches it."
    : `\nUNEXPECTED: folder=${resolved.fromFolder} inner=${resolved.fromInner}`,
);

socket.close();
if (!folderArg) {
  for (let i = 0; i < 10; i++) {
    try {
      rmSync(fixture, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
process.exit(!folderResolves && innerResolves ? 0 : 1);
