// Does a folder that holds repositories hand the panel one, and the newest first?
//
// The report: sessions opened at a folder that is not itself a checkout left the right side empty
// until a repository was pinned by hand, every time. The scan (`git_contained_repos`) and the rules
// for choosing (`repoDiscovery`) were written separately, so what this measures is the seam between
// them: the scan's spelling and its ordering against what the rule expects to receive.
//
// The fixture is two repositories of its own, one committed two days ago and one now, nested under
// plain folders so the "two levels down" rule is exercised too. Nothing of the user's is scanned.
//
// Usage: node scripts/dev/probes/repo-discovery-newest.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = ["-c", "user.email=probe@example.com", "-c", "user.name=Probe"];
const run = (cwd, args, env) =>
  execFileSync("git", [...GIT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const root = mkdtempSync(join(tmpdir(), "verta-probe-discovery-")).replace(/\\/g, "/");
const ws = `${root}/workspace`;
const older = `${ws}/older-repo`;
const nested = `${ws}/group`;
const newer = `${nested}/newer-repo`;

for (const dir of [older, newer]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "a.txt"), "one\n");
  run(dir, ["init", "--initial-branch=main"]);
  run(dir, ["add", "-A"]);
  const date =
    dir === older ? "2020-01-01T00:00:00Z" : "2026-01-01T00:00:00Z";
  run(dir, ["commit", "-m", "first"], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
}

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

// The scan, as the panel asks it.
const scanned = JSON.parse(
  await ev(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke("workspace_authorize", { path: ${JSON.stringify(ws)}, workspace: { kind: "local" } });
    const repos = await invoke("git_contained_repos", {
      folder: ${JSON.stringify(ws)},
      workspace: { kind: "local" },
    });
    return JSON.stringify(repos);
  })()`),
);
console.log("scanned:", JSON.stringify(scanned, null, 1));

// The rule, run on exactly what the scan returned.
const picked = JSON.parse(
  await ev(`(async () => {
    const urls = performance.getEntriesByType("resource").map((e) => e.name);
    const hits = urls.filter((n) => n.includes("/src/modules/source-control/repoDiscovery.ts"));
    const mod = await import((hits.filter((n) => n.includes("?t=")).pop() ?? hits.pop())
      ?? "http://localhost:1420/src/modules/source-control/repoDiscovery.ts");
    const repos = ${JSON.stringify(scanned)};
    return JSON.stringify({
      pick: mod.pickRepository(${JSON.stringify(ws)}, repos),
      again: mod.shouldAdoptPick(mod.pickRepository(${JSON.stringify(ws)}, repos), true),
    });
  })()`),
);

const paths = scanned.map((r) => r.path);
const scanOk = paths.length === 2 && paths.includes(older) && paths.includes(newer);
const pickOk =
  picked.pick.kind === "chosen" &&
  picked.pick.path === newer &&
  picked.pick.options.length === 2 &&
  picked.pick.options[0].path === newer;
const rememberOk = picked.again === false;

console.log(`\nscan found: ${JSON.stringify(paths)}`);
console.log(`rule chose: ${picked.pick.path} (${picked.pick.kind})`);
console.log(`options, newest first: ${JSON.stringify(picked.pick.options?.map((o) => o.path))}`);
console.log(`re-scan would move a placed panel: ${picked.again}`);

const pass = scanOk && pickOk && rememberOk;
console.log(
  pass
    ? "\nPASS: the scan answers the folder's own spelling, names the newest repository first, and a placed panel is left alone."
    : `\nFAIL: scanOk=${scanOk} pickOk=${pickOk} rememberOk=${rememberOk}`,
);

socket.close();
rmSync(root, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
