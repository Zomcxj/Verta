// Leaving the manage view has to put the list back exactly as it was.
//
// The bug this guards: after 管理 -> 完成 a dozen subagent rows stayed behind, still selectable, and
// every round trip added more of them (measured: 151 rows of data, 165 drawn, then 179). Two causes,
// both real: the same claude agent id was on disk twice (Claude Code files a session's subagent
// directory under the project key of every directory it was used in), and the page keys its rows by
// id - so duplicate ids made React reconcile two rows onto one key and leave stale ones mounted.
//
// The claim is about rows, so it is measured from the rows: the ids drawn before, inside, and after
// the manage view; none twice; and the same set every time this is repeated. Nothing is deleted and
// nothing is selected - the run only passes through the view.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/manage-mode-rows.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/");
if (!page) fail("no page target: is the app running with --remote-debugging-port?");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve);
  socket.addEventListener("error", (e) => reject(new Error(String(e?.message ?? e))));
});
let nextId = 1;
const pending = new Map();
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
    const what = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`${what} in: ${expression.slice(0, 160)}`);
  }
  return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the list is drawing right now.
 *
 * A row is `[data-session-id]`; a subagent is the one whose own text carries the badge - the same
 * thing a person reads to tell them apart.
 */
const LIST = `(() => {
  const rows = [...document.querySelectorAll("[data-session-id]")];
  const ids = rows.map((row) => row.getAttribute("data-session-id"));
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, n]) => n > 1);
  const subagents = rows.filter((row) => /子代理|Subagent/.test(row.textContent ?? ""));
  return JSON.stringify({
    rows: ids.length,
    unique: counts.size,
    repeated: repeated.slice(0, 5),
    subagents: subagents.length,
    manage: !!document.querySelector("[data-session-id]") && isManaging(),
  });
  function isManaging() {
    return [...document.querySelectorAll("button")].some(
      (button) => /^(完成|Done)$/.test(button.textContent.trim()) === true,
    );
  }
})()`;

const list = async () => JSON.parse(await evaluate(LIST));

/** Presses the rail's manage toggle, by the label a person reads. */
const pressManage = async (which) => {
  const pressed = await evaluate(`(() => {
    const pattern = new RegExp(${JSON.stringify(which)});
    const button = [...document.querySelectorAll("button")].find((node) =>
      pattern.test(node.textContent.trim()),
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!pressed) fail(`no "${which}" button in the launch panel`);
  // Managing re-reads nothing (freshness is paused on purpose), so the rows change on the next
  // render. Three quiet reads is a settled list.
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(150);
    const next = JSON.stringify(await list());
    stable = next === previous ? stable + 1 : 0;
    previous = next;
    if (stable >= 3) return;
  }
};

try {
  const rest = await list();
  report.rest = rest;
  if (rest.rows === 0) {
    fail("the sessions list is empty: there is no row to compare, and no manage view to enter");
  }
  if (rest.subagents > 0) {
    fail(
      `${rest.subagents} subagent rows are in the list before the manage view was ever opened`,
    );
  }

  const rounds = [];
  for (let round = 0; round < 3; round += 1) {
    await pressManage("管理|Manage");
    const managing = await list();
    if (!managing.manage) fail("the manage view did not open");
    if (managing.rows < rest.rows) {
      fail(
        `managing drew ${managing.rows} rows, fewer than the ${rest.rows} it started with: subagents should only add rows`,
      );
    }
    if (managing.repeated.length > 0) {
      fail(
        `the manage view draws the same session id more than once (${JSON.stringify(managing.repeated)}): the page keys rows by id, so a repeat leaves stale rows behind`,
      );
    }
    // ---- Reading one session, from the manage view -------------------------------------------
    //
    // The manage view is where subagent rows appear, and such a row says almost nothing about itself:
    // selecting exactly one offers "session info" in the footer, which has to open that session's
    // details - including the subagents, counted from the same rows the list draws.
    const opened = await evaluate(`(() => {
      const rows = [...document.querySelectorAll("[data-session-id]")];
      const parent = rows.find((row) => !/子代理|Subagent/.test(row.textContent ?? ""));
      if (!parent) return JSON.stringify({ error: "no top-level row to read" });
      parent.click();
      return JSON.stringify({ id: parent.getAttribute("data-session-id") });
    })()`);
    const picked = JSON.parse(opened);
    if (picked.error) fail(picked.error);
    await sleep(300);
    const asked = await evaluate(`(() => {
      const button = [...document.querySelectorAll("button")].find(
        (node) =>
          /^(会话信息|Session info)$/.test(node.textContent.trim()) && !node.disabled,
      );
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!asked) {
      fail("selecting one row did not offer a session-info button in the footer");
    }
    await sleep(400);
    const info = JSON.parse(
      await evaluate(`(() => {
        const dialog = document.querySelector("[data-session-info]");
        if (!dialog) return JSON.stringify({ open: false });
        const children = [...dialog.querySelectorAll("[data-session-facts-child]")];
        // The label span inside the children block, not the block itself: the block also holds the
        // rows, and their text carries numbers of its own.
        const declared = dialog.querySelector("[data-session-facts-children] > span");
        return JSON.stringify({
          open: true,
          id: dialog.querySelector("[data-session-facts-id]")?.textContent.trim() ?? null,
          tool: dialog.querySelector("[data-session-facts-tool]")?.textContent.trim() ?? null,
          stats: dialog.querySelector("[data-session-facts-stats]")?.textContent.trim() ?? null,
          children: children.length,
          childrenLabel: declared ? declared.textContent.trim() : null,
        });
      })()`),
    );
    if (!info.open) fail("the session-info button opened nothing");
    if (info.id !== picked.id) {
      fail(
        `the dialog reads ${JSON.stringify(info.id)} while the selected row is ${JSON.stringify(picked.id)}`,
      );
    }
    if (!info.stats) fail("the dialog says nothing about the session's usage");
    // The count and the rows are the same number: the dialog cannot claim more subagents than the
    // list has rows for.
    const claimed = /(\d+)/.exec(info.childrenLabel ?? "")?.[1];
    if (claimed !== undefined && Number(claimed) !== info.children) {
      fail(
        `the dialog claims ${claimed} subagents but lists ${info.children}: ${JSON.stringify(info.childrenLabel)}`,
      );
    }
    report.info = info;
    // Escape closes it, and the list is still managing when it does.
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(400);
    if (await evaluate(`!!document.querySelector("[data-session-info]")`)) {
      fail("Escape did not close the session-info dialog");
    }
    // Nothing selected, so the next round starts from the same place this one did.
    await evaluate(`[...document.querySelectorAll("button")].find((node) => /^(清空|Clear)$/.test(node.textContent.trim()))?.click()`);
    await sleep(200);

    await pressManage("完成|Done");
    const after = await list();
    rounds.push({ managing, after });
    if (after.manage) fail("the manage view did not close");
    if (after.subagents > 0) {
      fail(
        `leaving the manage view left ${after.subagents} subagent rows behind (round ${round + 1})`,
      );
    }
    if (after.rows !== rest.rows) {
      fail(
        `the list came back with ${after.rows} rows instead of ${rest.rows} (round ${round + 1}): rows are accumulating`,
      );
    }
    if (after.repeated.length > 0) {
      fail(
        `the list repeats a session id after leaving the manage view (${JSON.stringify(after.repeated)})`,
      );
    }
  }
  report.rounds = rounds;

  const rows = rounds.map((round) => round.managing.rows);
  if (new Set(rows).size !== 1) {
    fail(`the manage view drew ${rows.join(", ")} rows over three rounds: it is growing`);
  }

  console.log(
    `PASS: 普通列表 ${rest.rows} 行、0 个子代理；三次「管理→完成」里管理态各 ${rows[0]} 行（无重复 id），退出后都回到 ${rounds[0].after.rows} 行、0 个子代理 —— 不再残留、不再累积。管理态选中一条后「会话信息」打开的是同一条（${JSON.stringify(report.info?.id)}，${report.info?.tool}，用量 ${JSON.stringify(report.info?.stats)}），子代理数与列出的行一致（${report.info?.children}），Esc 可关。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}
