// What the session list's running light is doing, and what the window's own two markers make of it.
//
// The list draws an agent's state as a bar with a highlight crossing it, and the contract has two
// halves that only meet on a screen: the bar is drawn in the state's colour - the same colour the tab
// strip draws for that session - and it keeps moving while the window can be seen, stopping outright
// when nobody can see it. Neither half is readable from the stylesheet alone, because the thing that
// moves is a child of the thing that carries the marker, and the rules that stop and start it are
// selected by an attribute on <html>. So this reads the computed style of both elements, and the two
// markers beside them, and reports the lot.
//
// Usage:
//   node scripts/dev/probes/marquee-state.mjs                            # dev, print only
//   node scripts/dev/probes/marquee-state.mjs --match=tauri.localhost/   # the installed build
//   node scripts/dev/probes/marquee-state.mjs --match=tauri.localhost/ --expect=unfocused
//
// `--expect` checks the reading against the state the window was in when it was taken, and exits
// non-zero when they disagree: `focused` and `unfocused` both require the light to be moving,
// `hidden` requires it to have stopped. Putting the window into that state - focusing it, blurring
// it, hiding it - is the caller's job, not this probe's.
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match");
const expect = arg("expect");
if (expect !== null && !["focused", "unfocused", "hidden"].includes(expect)) {
  console.error(`--expect must be focused, unfocused or hidden (got ${expect})`);
  process.exit(2);
}

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => {
  if (t.type !== "page") return false;
  return match === null
    ? t.url.endsWith("1420/")
    : match.endsWith("/")
      ? t.url.endsWith(match)
      : t.url.includes(match);
});
if (!page) {
  console.error("没找到主窗口的 page 目标（dev 或装机版起了吗？--match 对吗？）");
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 1;
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
    const i = id++;
    pending.set(i, res);
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {\n${body}\n})()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result.result.value;
};

const reading = JSON.parse(
  await pageEval(`
    const style = (el) => {
      const s = getComputedStyle(el);
      return {
        colour: s.backgroundColor,
        animation: s.animationName,
        timing: s.animationTimingFunction,
        play: s.animationPlayState
      };
    };
    const html = document.documentElement;
    const rows = [...document.querySelectorAll("[data-session-id]")].map((row) => {
      const bar = row.querySelector("[data-agent-marquee]");
      const sweep = bar?.firstElementChild ?? null;
      return {
        title: (row.textContent || "").trim().split("\\n")[0].slice(0, 28),
        // What the row shows at all: null means no agent on that session.
        state: row.querySelector("[data-agent-state]")?.getAttribute("data-agent-state") ?? null,
        bar: bar ? style(bar) : null,
        sweep: sweep ? style(sweep) : null,
        // A state drawn in the row that is not the bar would be the old dot left behind.
        dotWithoutBar: row.querySelector("[data-agent-state]:not([data-agent-marquee])") !== null,
        box: bar ? [Math.round(bar.getBoundingClientRect().width), Math.round(bar.getBoundingClientRect().height)] : null
      };
    });
    const tabs = [...document.querySelectorAll("[role=tab]")].map((tab) => {
      const dot = tab.querySelector("[data-agent-state]");
      return {
        title: (tab.textContent || "").trim(),
        state: dot?.getAttribute("data-agent-state") ?? null,
        colour: dot ? getComputedStyle(dot).backgroundColor : null
      };
    });
    return JSON.stringify({
      markers: {
        inactive: html.hasAttribute("data-window-inactive"),
        hidden: html.hasAttribute("data-window-hidden"),
        visibility: document.visibilityState,
        focus: document.hasFocus()
      },
      rows,
      tabs
    });
  `),
);

// Which state the window is in, as the two markers describe it, so `--expect` can be checked.
const where = reading.markers.hidden
  ? "hidden"
  : reading.markers.inactive
    ? "unfocused"
    : "focused";

console.log(
  `窗口：${where}（inactive=${reading.markers.inactive} hidden=${reading.markers.hidden} ` +
    `visibility=${reading.markers.visibility} focus=${reading.markers.focus}）`,
);
console.log("会话列表：");
for (const row of reading.rows) {
  if (row.state === null) {
    console.log(`  (没有 agent) ${row.title}`);
    continue;
  }
  console.log(
    `  ${row.state.padEnd(9)} ${row.box ? `${row.box[0]}x${row.box[1]}` : "-"} ` +
      `轨道 ${row.bar?.colour} 滑动条 ${row.sweep?.colour} ` +
      `animation=${row.sweep?.animation} timing=${row.sweep?.timing} play=${row.sweep?.play}`,
  );
}
console.log("顶部标签栏：");
for (const tab of reading.tabs) {
  console.log(
    `  ${(tab.state ?? "(没有 agent)").padEnd(9)} ${tab.colour ?? ""} ${tab.title}`,
  );
}

/** Everything that has to hold whatever state the window is in, and where it did not. */
const failures = [];
let moving = 0;
for (const row of reading.rows) {
  if (row.state === null) {
    if (row.bar !== null) failures.push(`${row.title}: 没有 agent 却画了跑马灯`);
    continue;
  }
  if (row.bar === null) {
    failures.push(`${row.title}: 有 agent 却没有跑马灯`);
    continue;
  }
  if (row.dotWithoutBar) failures.push(`${row.title}: 会话行里还留着旧的点`);
  if (row.sweep === null) {
    failures.push(`${row.title}: 跑马灯里没有滑动条`);
    continue;
  }
  // Stepped timing is only required while the light is animating at all: with the animation
// switched off (`animation: none`) the timing function falls back to its initial value, which
// says nothing about the rule that would run.
  if (row.sweep.animation !== "none" && row.sweep.timing.includes("steps(") === false) {
    failures.push(`${row.title}: 滑动条不是 steps()（${row.sweep.timing}）`);
  }
  // A class Tailwind did not generate fails silently: the track would be invisible and the bar
  // would read as nothing at all, which is the one failure a screenshot cannot be trusted for.
  if (row.bar.colour === "rgba(0, 0, 0, 0)" || row.bar.colour === "transparent") {
    failures.push(`${row.title}: 跑道底色没画出来（bg-*-500/25 没生成？）`);
  }
  if (row.bar.colour === row.sweep.colour) {
    failures.push(`${row.title}: 滑动条与跑道同色，动起来看不到`);
  }
  // The colour contract, from the clipboard the two surfaces share: one session, one colour.
  const tab = reading.tabs.find((t) => t.state === row.state && t.colour !== null);
  if (tab && tab.colour !== row.sweep.colour) {
    failures.push(
      `${row.title}: 行与标签栏对 ${row.state} 给了两个颜色（${row.sweep.colour} / ${tab.colour}）`,
    );
  }
  if (row.sweep.play === "running") moving += 1;
}

// The vocabulary: three colours over four states, and green covers both of the resting ones.
const colourOf = new Map();
for (const row of reading.rows) {
  if (row.state !== null && row.sweep !== null) colourOf.set(row.state, row.sweep.colour);
}
const distinct = new Set(colourOf.values());
if (colourOf.has("idle") && colourOf.has("finished") && colourOf.get("idle") !== colourOf.get("finished")) {
  failures.push("空闲与刚结束是两个颜色（结束应当一直绿）");
}
// Three colours over four states, and the one collision the vocabulary asks for: a turn that just
// ended and an agent sitting at its prompt are drawn the same. Counting distinct colours against
// states therefore has to allow exactly that one, or this check fails a correct build whenever a
// `finished` row (six seconds of one) is on screen beside an `idle` one.
const intendedCollisions =
  colourOf.has("idle") && colourOf.has("finished") ? 1 : 0;
if (distinct.size !== colourOf.size - intendedCollisions) {
  failures.push(`颜色数与状态数对不上：${[...colourOf].map(([s, c]) => `${s}=${c}`).join(", ")}`);
}

if (expect !== null) {
  if (where !== expect) failures.push(`窗口状态是 ${where}，不是 --expect 的 ${expect}`);
  const stopped = reading.rows.every(
    (row) => row.sweep === null || row.sweep.animation === "none",
  );
  const running = reading.rows.every(
    (row) => row.sweep === null || row.sweep.play === "running",
  );
  if (expect === "hidden") {
    if (!stopped) failures.push("看不见的时候滑动条还在动（应为 animation: none）");
  } else if (!running) {
    failures.push(`${where} 的窗口里滑动条没有在动`);
  }
}

if (failures.length === 0) {
  const withAgent = reading.rows.filter((r) => r.state !== null).length;
  // `animationPlayState` stays `running` even when the animation has been switched off, so it is
  // not what tells the two cases apart: what does is the animation's own name.
  const how =
    expect === "hidden"
      ? "滑动条都已停成实心"
      : `其中 ${moving} 条的滑动条在动`;
  console.log(`\n通过：${withAgent} 行有 agent（${where} 的窗口），${how}。`);
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);