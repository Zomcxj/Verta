// Is the project the list marks "shallow" actually a shallow clone?
//
// The row draws its 浅 mark from `ProjectStatus.shallow`, which the backend answers from
// `git rev-parse --is-shallow-repository`. The commit graph is a separate read (`git log`), so if the
// mark and the graph disagree, one of them is describing a repository the other is not - and before
// changing either, it is worth knowing which.
//
// Read-only: it asks the same two questions the app asks, for the projects the list shows.
//
// Usage: node scripts/dev/probes/project-shallow-truth.mjs [--path=D:/VsPro/xxx]
import { execFileSync } from "node:child_process";

const only = process.argv.find((a) => a.startsWith("--path="))?.slice(7);

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

// The rows the app itself is drawing: path and the 浅 mark.
const rows = JSON.parse(
  await ev(`(async () => {
    const press = (node) => {
      const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
      node.dispatchEvent(new PointerEvent("pointerdown", opts));
      node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
      node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    };
    for (let i = 0; i < 24; i++) {
      if (document.querySelector("[data-project-row], table tbody tr")) break;
      const tab = [...document.querySelectorAll("button")].find((b) => /^(本地项目|Local projects)$/.test((b.textContent || "").trim()));
      if (tab) press(tab);
      await new Promise((r) => setTimeout(r, 250));
    }
    return JSON.stringify([...document.querySelectorAll("table tbody tr")].map((tr) => {
      const cell = tr.querySelectorAll("td")[3];
      return {
        path: tr.querySelector("[title]")?.getAttribute("title") ?? null,
        branchCell: (cell?.innerText ?? "").replace(/\\s+/g, " ").trim(),
        marked: /浅|shallow/i.test(cell?.innerText ?? ""),
      };
    }));
  })()`),
);

const interesting = only ? rows.filter((r) => (r.path ?? "").includes(only)) : rows;
console.log(`rows drawn: ${rows.length}, checking ${interesting.length}`);
for (const row of interesting) {
  if (!row.path) continue;
  const git = (args) => {
    try {
      return execFileSync("git", ["-C", row.path, ...args], { encoding: "utf8" }).trim();
    } catch (error) {
      return `error: ${String(error.message).split("\n")[0]}`;
    }
  };
  const shallow = git(["rev-parse", "--is-shallow-repository"]);
  const count = git(["rev-list", "--count", "HEAD"]);
  const logLines = git(["log", "--oneline"]).split("\n").filter(Boolean).length;
  const shallowFile = git(["rev-parse", "--git-path", "shallow"]);
  console.log(
    `\n${row.path}\n  marked=${row.marked} branch="${row.branchCell}"\n  is-shallow=${shallow}  rev-list HEAD=${count}  git log lines=${logLines}\n  shallow file=${shallowFile}`,
  );
}

socket.close();
