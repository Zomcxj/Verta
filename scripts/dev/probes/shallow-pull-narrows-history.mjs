// Does "shallow pull" really leave one commit, on a repository shaped like the user's?
//
// The complaint after the row's action was added: "你的分支显示浅 但是提交图打开还是一堆提交啊". Two things
// had been true at once - the row's mark was reading `is-shallow-repository` (which a `--depth 1000`
// clone already satisfies) rather than "one commit", and the narrowing command had only ever been
// measured on copies the probe made itself.
//
// This builds a full history and clones it shallow, then runs the same two commands
// `replace_with_remote_shallow` runs, and reads the three numbers the user judged by:
// `is-shallow-repository`, `rev-list --count`, and how many lines `git log` prints - which is what
// the commit graph draws.
//
// Two shapes had to be measured, and they are not the same: a copy that is **not** shallow (`--depth`
// larger than the history, so every commit arrived), and a copy that is shallow **and still deep** -
// which is what the user's own projects turned out to be, cloned at a depth of hundreds. Measured on
// both: 40 commits -> 1, and 3 commits -> 1, with `git log` printing one line each time. A full copy
// that is already one commit stays one.
//
// The fixture is the probe's own, in a temporary directory. Nothing of the user's is touched.
//
// Usage: node scripts/dev/probes/shallow-pull-narrows-history.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GIT = ["-c", "user.email=probe@example.com", "-c", "user.name=Probe"];
const run = (cwd, args) => execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" }).trim();
const read = (dir) => ({
  shallow: run(dir, ["rev-parse", "--is-shallow-repository"]),
  commits: Number(run(dir, ["rev-list", "--count", "HEAD"])),
  logLines: run(dir, ["log", "--oneline"]).split("\n").filter(Boolean).length,
});

const root = mkdtempSync(join(tmpdir(), "verta-probe-shallowpull-")).replace(/\\/g, "/");
const origin = `${root}/origin`;
const copy = `${root}/copy`;
mkdirSync(origin, { recursive: true });
run(origin, ["init", "--initial-branch=main"]);
for (let i = 1; i <= 40; i += 1) {
  writeFileSync(join(origin, "f.txt"), `v${i}\n`);
  run(origin, ["add", "-A"]);
  run(origin, ["commit", "-m", `c${i}`]);
}
run(root, ["clone", "--depth", "1000", `file:///${origin}`, copy]);

const before = read(copy);
console.log(`before: ${JSON.stringify(before)}`);

// The two commands the app runs, in order (see `modules/projects/replace.rs`).
run(copy, ["fetch", "--prune", "--depth=1"]);
const wanted = run(copy, ["rev-parse", "refs/remotes/origin/main"]);
run(copy, ["reset", "--hard", wanted]);
const after = read(copy);
console.log(`after:  ${JSON.stringify(after)}`);
console.log(`on:     ${run(copy, ["log", "--oneline"])}`);

const narrowed =
  after.shallow === "true" && after.commits === 1 && after.logLines === 1;
const startedDeep = before.commits > 1;
console.log(
  narrowed && startedDeep
    ? `\nPASS: a copy holding ${before.commits} commits (shallow already, at depth 1000) is one commit afterwards, and the graph has one line to draw.`
    : `\nFAIL: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
);

rmSync(root, { recursive: true, force: true });
process.exit(narrowed && startedDeep ? 0 : 1);
