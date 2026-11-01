// What each changed-file row says it added and removed, against what git says.
//
// The numbers are read off the rendered rows (the row carries `data-scm-path`, the two numbers sit
// in a `[data-scm-counts]` inside it) and the truth is `git diff --numstat` plus
// `git diff --cached --numstat` run by this probe in the same repository, merged by the same rule
// the app uses: both reads summed per path, a rename keyed by its new path, a binary file left out.
// A row whose numbers git cannot confirm fails the run.
//
// The right column has to be open on that repository, as with the other source-control probes. The
// list is virtualised, so only the rows on screen are compared, and the report says how many of
// git's files that was.
//
// Usage: node scripts/dev/probes/scm-line-counts.mjs [--port=9222] [--repo=F:/path/to/repo]
import { execFileSync } from "node:child_process";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const repo =
  process.argv.find((a) => a.startsWith("--repo="))?.slice(7) ?? process.cwd();

/** The same merge the app does, over the two reads git offers. */
function gitCounts() {
  const counts = new Map();
  for (const args of [
    ["diff", "--numstat", "-z"],
    ["diff", "--cached", "--numstat", "-z"],
  ]) {
    const out = execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const tokens = out.split("\0").filter((t) => t !== "");
    let i = 0;
    while (i < tokens.length) {
      const [addedRaw, removedRaw, inline] = tokens[i++].split("\t");
      // "-" means the file cannot be counted; the row must show nothing, not a zero.
      if (addedRaw === "-" || removedRaw === "-") continue;
      let path = inline ?? "";
      if (path === "") {
        i += 1; // the original path; the status reports the new one
        path = tokens[i++] ?? "";
      }
      if (path === "") continue;
      const current = counts.get(path) ?? [0, 0];
      counts.set(path, [
        current[0] + Number(addedRaw),
        current[1] + Number(removedRaw),
      ]);
    }
  }
  return counts;
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("没找到主窗口；dev 起了吗？");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve());
  socket.addEventListener("error", (e) => reject(new Error(String(e.message ?? e))));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
});

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "页面内异常",
    );
  }
  return result.result.value;
};

try {
  // Every rendered row, the path it belongs to, and the numbers it shows (null = it shows none).
  const raw = await evaluate(`JSON.stringify([...document.querySelectorAll("[data-scm-row]")].map((row) => {
    const counts = row.querySelector("[data-scm-counts]");
    return {
      path: row.getAttribute("data-scm-path"),
      text: counts ? (counts.textContent || "").replace(/\\s+/g, "") : null,
    };
  }))`);
  const rows = JSON.parse(raw ?? "[]");

  const truth = gitCounts();
  const report = { repo, rows: rows.length, gitFiles: truth.size };
  const problems = [];
  let checked = 0;
  let bothSilent = 0;
  try {
    for (const row of rows) {
      const want = truth.get(row.path);
      // Neither side has numbers: an untracked file, or a binary one. That agrees by being silent,
      // so it is counted apart rather than as a comparison.
      if (!want && row.text === null) {
        bothSilent += 1;
        continue;
      }
      if (!want) {
        problems.push(`${row.path}: 面板显示 ${row.text}，git 这一轮没有它的行数`);
        continue;
      }
      const wantText = `+${want[0]}-${want[1]}`;
      if (row.text === null) {
        problems.push(`${row.path}: git 说 ${wantText}，面板这一行没有数字`);
        continue;
      }
      if (row.text !== wantText) {
        problems.push(`${row.path}: 面板显示 ${row.text}，git 说 ${wantText}`);
        continue;
      }
      checked += 1;
    }
  } finally {
    socket.close();
  }

  report.checked = checked;
  report.bothSilent = bothSilent;
  if (problems.length > 0) {
    console.error(`不一致 ${problems.length} 处:`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (checked === 0) {
    console.error(
      `这一轮没有能比出数字的行（另有 ${bothSilent} 行两边都没有数字）：把工作区改出一点东西再跑`,
    );
    console.error(JSON.stringify(report, null, 2));
    process.exit(3);
  }
  console.log(`一致 ${checked} 行，另有 ${bothSilent} 行两边都没有数字（${repo}）`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  socket.close();
  console.error(`FAIL: ${error?.message ?? error}`);
  process.exit(1);
}
