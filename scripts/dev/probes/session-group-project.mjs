// Does "group by project" put every session under the folder it ran in?
//
// The rule the panel follows: a session belongs to the deepest registered project its cwd
// sits in, an unknown folder is a section named after its last segment, and a session with
// no cwd at all lands in "other". This probe re-derives that from the session list and the
// project file, then compares it with the sections the interface actually drew - the two
// together are the check, since neither the ordering nor the ownership is visible from a
// unit test of the pure function alone.
//
//   node scripts/dev/probes/session-group-project.mjs [--port=9222]
const args = process.argv.slice(2);
const port = args.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(
  (t) =>
    t.type === "page" &&
    (t.url.endsWith("1420/") ||
      (t.url.includes("tauri.localhost") && !t.url.includes("settings.html"))),
);
if (!page) fail("没找到主窗口的 page 目标，应用起来了吗？");

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
const pending = new Map();
await new Promise((r) => socket.addEventListener("open", () => r()));
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const q = pending.get(m.id);
  if (!q) return;
  pending.delete(m.id);
  q(m);
});
const send = (method, params) =>
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
};

const PRESS = `
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
  };
`;

/** The same rules the panel's pure function follows, written out again on purpose. */
const normalize = (path) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const under = (path, root) => {
  const a = normalize(path).toLowerCase();
  const b = normalize(root).toLowerCase();
  return b !== "" && (a === b || a.startsWith(`${b}/`));
};
const nameOf = (path) => {
  const parts = normalize(path).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
};

const { readFileSync } = await import("node:fs");
const { homedir } = await import("node:os");
const { join } = await import("node:path");
const appData = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "app.verta");
let projects = [];
try {
  const raw = JSON.parse(readFileSync(join(appData, "verta-projects.json"), "utf8"));
  projects = Array.isArray(raw?.projects) ? raw.projects.filter((p) => typeof p === "string") : [];
} catch {
  projects = [];
}
report.projects = projects;

// --- the sessions, from the app ----------------------------------------------------------------
const sessions = [];
for (const tool of ["opencode", "pi"]) {
  const payload = await evaluate(`
    const invoke = window.__TAURI_INTERNALS__.invoke;
    return invoke("agent_sessions_list", { tool: ${JSON.stringify(tool)}, distro: null })
      .then((p) => JSON.stringify(p?.sessions ?? []));
  `);
  for (const s of JSON.parse(payload)) {
    sessions.push({
      tool,
      id: s.id,
      cwd: s.cwd ?? "",
      parentId: s.parentId ?? null,
    });
  }
}
report.sessions = sessions.length;

// The panel lists top-level sessions only: a subagent run is not something anyone resumes,
// so it is filtered out before grouping (`topLevelSessions`). Same rule here, or the probe
// would expect rows the list is right not to draw.
const present = new Set(sessions.map((s) => s.id));
const topLevel = sessions.filter((s) => {
  if (s.parentId === null || s.parentId === s.id) return true;
  if (s.tool === "pi") return false;
  return !present.has(s.parentId);
});
report.topLevel = topLevel.length;
if (topLevel.length === 0) fail("顶层会话一条都没有，没法量分组");

// --- what the rule says the sections are -------------------------------------------------------
const deepest = [...projects].map(normalize).sort((a, b) => b.length - a.length);
const buckets = new Map();
for (const s of topLevel) {
  const cwd = normalize(s.cwd);
  const owner = cwd === "" ? "" : (deepest.find((root) => under(cwd, root)) ?? cwd);
  if (!buckets.has(owner)) buckets.set(owner, []);
  buckets.get(owner).push(s.id);
}
const registered = projects.map(normalize);
const loose = [...buckets.keys()]
  .filter((owner) => owner !== "" && !registered.includes(owner))
  .sort((a, b) => {
    const byName = nameOf(a).localeCompare(nameOf(b));
    return byName !== 0 ? byName : a.localeCompare(b);
  });
const ordered = [
  ...registered.filter((path) => buckets.has(path)),
  ...loose,
  ...(buckets.has("") ? [""] : []),
];
const expected = ordered.map((owner) => ({
  label: owner === "" ? null : nameOf(owner),
  ids: [...buckets.get(owner)].sort(),
}));
report.expected = expected;

// --- draw it -----------------------------------------------------------------------------------
await evaluate(`
  ${PRESS}
  if (document.querySelector("[data-session-id]") === null) {
    const rail = [...document.querySelectorAll("button[aria-label]")].find((b) => /会话|Sessions/.test(b.getAttribute("aria-label") ?? ""));
    if (rail) press(rail);
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
`);
const clicked = await evaluate(`
  ${PRESS}
  const tab = [...document.querySelectorAll("[role=tab]")].find((el) => /项目|Project/.test((el.textContent || "").trim()));
  if (!tab) return "no-tab";
  press(tab);
  await new Promise((r) => setTimeout(r, 900));
  return "clicked";
`);
report.clicked = clicked;
if (clicked !== "clicked") fail(`分组切换里没有「项目」这一档：${clicked}`);
await sleep(500);

const drawn = await evaluate(`
  return [...document.querySelectorAll("[data-session-section]")].map((el) => ({
    key: el.getAttribute("data-session-section"),
    label: el.getAttribute("data-session-section-label") || null,
    ids: [...el.querySelectorAll("button[data-session-id]")]
      .map((row) => row.getAttribute("data-session-id")).sort(),
  }));
`);
report.drawn = drawn;
if (drawn.length === 0) fail("切成「项目」之后一段都没画出来");

// --- compare -----------------------------------------------------------------------------------
for (const [index, want] of expected.entries()) {
  const got = drawn[index];
  if (!got) {
    fail(`少了第 ${index + 1} 段（应是 ${want.label ?? "其他"}）`);
    break;
  }
  if (want.label !== null && got.label !== want.label) {
    fail(`第 ${index + 1} 段的标题是 ${JSON.stringify(got.label)}，应是 ${JSON.stringify(want.label)}`);
    break;
  }
  if (JSON.stringify(got.ids) !== JSON.stringify(want.ids)) {
    fail(`第 ${index + 1} 段（${want.label ?? "其他"}）的行不对：读到 ${JSON.stringify(got.ids)}，应是 ${JSON.stringify(want.ids)}`);
    break;
  }
}
if (drawn.length !== expected.length) {
  fail(`段数不对：画了 ${drawn.length} 段，按规则应是 ${expected.length} 段`);
}

socket.close();
console.log(JSON.stringify(report, null, 2));
console.log("PASS: 「项目」分组的段落和归属与规则一致（最深登记项目优先，未登记按文件夹名，无 cwd 归「其他」）。");
process.exit(0);
