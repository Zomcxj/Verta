// CPU profile around a tab switch, aggregated by function, so the 2.5 s block is attributed to
// real frames instead of guessed at.
// Usage: node scripts/dev/probes/tab-switch-profile.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("没找到主窗口");
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
await new Promise((res, rej) => {
  socket.addEventListener("open", () => res());
  socket.addEventListener("error", (e) => rej(new Error(String(e.message ?? e))));
});
socket.addEventListener("message", (event) => {
  const m = JSON.parse(event.data);
  const entry = pending.get(m.id);
  if (!entry) return;
  pending.delete(m.id);
  if (m.error) entry.reject(new Error(JSON.stringify(m.error)));
  else entry.resolve(m.result);
});
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
    );
  }
  return r.result.value;
};

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 200 });
await send("Profiler.start");

// Switch to another tab and let the work run.
const clicked = await evaluate(`(async () => {
  const chips = [...document.querySelectorAll("[data-tab-id]")];
  const other = chips.find((c) => c.getAttribute("data-tab-active") !== "true");
  if (!other) return null;
  const title = other.textContent.replace(/\\s+/g, " ").trim().slice(0, 20);
  const r = other.getBoundingClientRect();
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    other.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
  }
  other.click();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return title;
})()`);

const { profile } = await send("Profiler.stop");
await send("Profiler.disable");

// Aggregate self time per function, and for the top entry also record its call stack, so a
// generic name like `measure` can be attributed to the code that called it.
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const parentOf = new Map();
for (const node of profile.nodes) {
  for (const child of node.children ?? []) parentOf.set(child, node.id);
}
const selfTime = new Map();
const total = profile.samples.length;
for (const id of profile.samples) {
  const node = byId.get(id);
  if (!node) continue;
  const frame = node.callFrame;
  const name = `${frame.functionName || "(anonymous)"} @ ${(frame.url || "").split("/").pop()}:${frame.lineNumber + 1}`;
  selfTime.set(name, (selfTime.get(name) ?? 0) + 1);
}
const ranked = [...selfTime.entries()].sort((a, b) => b[1] - a[1]);

// The stack behind the hottest function: which of this project's frames called it.
const hottestName = ranked[0]?.[0];
let hottestStack = [];
if (hottestName) {
  const sampleId = profile.samples.find((id) => {
    const node = byId.get(id);
    if (!node) return false;
    const frame = node.callFrame;
    const name = `${frame.functionName || "(anonymous)"} @ ${(frame.url || "").split("/").pop()}:${frame.lineNumber + 1}`;
    return name === hottestName;
  });
  let cursor = sampleId;
  while (cursor !== undefined && hottestStack.length < 18) {
    const node = byId.get(cursor);
    if (!node) break;
    const frame = node.callFrame;
    hottestStack.push(
      `${frame.functionName || "(anonymous)"} @ ${(frame.url || "").split("/").slice(-2).join("/")}:${frame.lineNumber + 1}`,
    );
    cursor = parentOf.get(cursor);
  }
}

console.log(
  JSON.stringify(
    {
      clickedTo: clicked,
      samples: total,
      hotSelfTime: ranked.slice(0, 15).map(([name, count]) => ({
        name,
        samples: count,
        pct: Math.round((count / total) * 1000) / 10,
      })),
      stackOfHottest: hottestStack,
    },
    null,
    1,
  ),
);
