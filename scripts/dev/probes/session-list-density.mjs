// What a session row draws in each density, and what its hover card says.
//
// A row's density is a fact about a rendered panel, not about a function: how many lines it takes,
// and - in both densities now - whether hovering really produces the one card, what that card says
// about the session, and whether the row still opens a session. The last one is the one that breaks
// silently: a card riding on the row's own pointer events decides it, and neither the stylesheet nor
// a unit test can see it.
//
// It reads the density from the marker the list carries rather than counting lines and guessing,
// and it fails loudly when the sessions list is not on screen: a probe that finds no rows has
// measured nothing, and reporting that as a pass is how a feature ships broken.
//
// Usage:
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --expect=standard --hover
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --expect=compact --hover
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --hover --click-row
//   node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --hover --manage
//
// Name the window exactly. The settings page is served from the same origin, so `tauri.localhost/`
// matches both it and the window with the list on it, and the first of the two the debugger lists
// wins - measured: a run that thought it was reading a standard list was reading the settings page,
// which has no list at all.
//
// `--expect=standard|compact` asserts the drawn density and its consequences: a standard row is two
// lines, a compact row is one, and neither carries a native `title` any more - the card says the
// title in full, so a browser tooltip on top of it would be two popups on one hover.
//
// `--hover` puts the pointer on the first row's centre for real (a synthesized event is not what the
// card listens for) and reads what appeared: exactly one card, holding the session's id, directory,
// usage and what it started.
//
// `--manage` presses the manage button first, so the same card is read from the view where the rows
// are checkboxes - the view whose question is "what will I lose if I tick this".
const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const match = arg("match");
const expectDensity = arg("expect");
const hover = process.argv.includes("--hover");
const clickRow = process.argv.includes("--click-row");
const manage = process.argv.includes("--manage");
// Every density's consequence that matters is about hovering, so a run that checks a density
// without hovering would report a pass on a build where the card is not drawn at all.
if (expectDensity !== null && !hover) {
  console.error("--expect 必须和 --hover 一起用（两种密度的判定都落在悬停上）");
  process.exit(2);
}
if (
  expectDensity !== null &&
  expectDensity !== "standard" &&
  expectDensity !== "compact"
) {
  console.error(`--expect must be standard or compact (got ${expectDensity})`);
  process.exit(2);
}
if (manage && clickRow) {
  // A manage row is a checkbox: pressing it never opens a session, so the two checks contradict.
  console.error("--manage 和 --click-row 不能一起用（管理模式下点击是勾选，不会开会话）");
  process.exit(2);
}

const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => {
  if (t.type !== "page") return false;
  if (match === null) return t.url.endsWith("1420/") || t.url.endsWith("tauri.localhost/");
  return match.endsWith("/") ? t.url.endsWith(match) : t.url.includes(match);
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
  new Promise((res, rej) => {
    const i = id++;
    pending.set(i, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    socket.send(JSON.stringify({ id: i, method, params }));
  });
const pageEval = async (body) => {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything the checks below read, in one pass: the list, its rows, the card if it is up. */
const readScreen = () =>
  pageEval(`
    const list = document.querySelector("[data-session-density]");
    const rows = [...document.querySelectorAll("[data-session-id]")].map((row) => {
      const r = row.getBoundingClientRect();
      return {
        id: row.getAttribute("data-session-id"),
        title: (row.textContent || "").trim().split("\\n")[0].slice(0, 32),
        meta: row.querySelectorAll("[data-session-meta]").length,
        subagent: /子代理|Subagent/.test(row.textContent || ""),
        nativeTitle: row.getAttribute("title"),
        checkbox: row.querySelector("[data-checked]") !== null,
        badge: row.querySelector("[data-subagent-count]")?.getAttribute("data-subagent-count") ?? null,
        centre: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
      };
    });
    const cards = [...document.querySelectorAll("[data-hover-card]")].map((card) => {
      const s = getComputedStyle(card);
      const text = (selector) => (card.querySelector(selector)?.textContent ?? "").trim();
      return {
        ready: card.getAttribute("data-ready"),
        opacity: s.opacity,
        height: Math.round(card.getBoundingClientRect().height),
        title: (card.querySelector("[data-hover-card-body] > span")?.textContent ?? "").trim(),
        id: text("[data-session-facts-id]"),
        dir: text("[data-session-facts-dir]"),
        stats: text("[data-session-facts-stats]"),
        parent: text("[data-session-facts-parent]"),
        // The card is a glance: the id, the directory, the usage, and the parent for a subagent. The
        // agent is the icon on its row, and the subagents a session started are the dialog's job.
        children: card.querySelector("[data-session-facts-children]") !== null,
        recordFields:
          card.querySelector(
            "[data-session-facts-tool], [data-session-facts-source]",
          ) !== null,
        describedBy: [...document.querySelectorAll("[data-session-id]")]
          .filter((row) => row.getAttribute("aria-describedby") === card.id)
          .map((row) => row.getAttribute("data-session-id"))
      };
    });
    return JSON.stringify({
      density: list?.getAttribute("data-session-density") ?? null,
      listFound: list !== null,
      tabs: document.querySelectorAll("[data-tab-id]").length,
      rows,
      cards
    });
  `);

if (manage) {
  // Already managing: the button says 完成 and the rows are checkboxes, which is the state this run
  // wants anyway. Seen while probing: a second run against a window left in the mode reported "no
  // manage button" as a failure.
  const already = await pageEval(
    `document.querySelectorAll("[data-checked]").length > 0 ? "managing" : "not-managing"`,
  );
  const pressed = already === "managing" ? "pressed" : await pageEval(`
    const button = [...document.querySelectorAll("button")].find((b) =>
      /^(管理|Manage)$/.test((b.textContent || "").trim())
    );
    if (!button) return "no-button";
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    button.dispatchEvent(new PointerEvent("pointerdown", o));
    button.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 }));
    button.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
    return "pressed";
  `);
  if (pressed !== "pressed") {
    console.error("没找到「管理」按钮，管理模式起不来");
    process.exit(1);
  }
  await sleep(1200);
  console.log(
    already === "managing" ? "管理模式：本来就在" : "管理模式：已按下",
  );
}

const before = JSON.parse(await readScreen());
if (!before.listFound || before.rows.length === 0) {
  console.error(
    "会话列表没在屏幕上（marker " +
      (before.listFound ? "在" : "不在") +
      "，行数 " +
      before.rows.length +
      "）：先从左栏打开「会话」列表再跑这个探针",
  );
  process.exit(1);
}

console.log(`画出来的密度：${before.density}`);
console.log(`标签数：${before.tabs}`);
for (const row of before.rows.slice(0, 5)) {
  console.log(
    `  行「${row.title}」数字行 ${row.meta} 个，勾选格 ${
      row.checkbox ? "有" : "无"
    }，子代理徽标 ${row.badge === null ? "无" : row.badge}，原生 title ${
      row.nativeTitle === null ? "没有" : `「${row.nativeTitle}」`
    }`,
  );
}
console.log(`悬停前的详情卡：${before.cards.length} 个`);

const first = before.rows[0];
let after = before;
if (hover) {
  // The card opens on a real pointer move: a synthesized pointerover event is not what the row
  // listens for, the same reason the file tree's menu needs a real contextmenu.
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: first.centre[0],
    y: first.centre[1],
  });
  // Read while the pointer is still on the row. The card closes as soon as the pointer leaves the
  // list, and pointing it somewhere else to evaluate is exactly that: an earlier run of this probe
  // reported "no card" for a card that had opened.
  await sleep(600);
  after = JSON.parse(await readScreen());
  console.log(`\n悬停后：${after.cards.length} 张详情卡`);
  for (const card of after.cards) {
    console.log(`  ready=${card.ready} opacity=${card.opacity} 高 ${card.height}px`);
    console.log(`    标题：${card.title}`);
    console.log(`    id：${card.id}`);
    console.log(`    目录：${card.dir}`);
    console.log(`    用量：${card.stats}`);
    console.log(`    所属会话：${card.parent || "（无，这是主会话）"}`);
    console.log(`    子代理段：${card.children ? "有（不该有）" : "无"}`);
    console.log(`    被描述的行：${card.describedBy.join(",") || "无"}`);
  }
}

let clicked = null;
/**
 * The last reading taken for a judgement. Pressing a row opens a session, which can hide the panel,
 * so this is not always `after` - and a reading with no list in it, judged as "0 rows all correct",
 * is exactly how a probe reports a pass on a build it never looked at.
 */
let judged = after;
if (clickRow) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type,
      x: first.centre[0],
      y: first.centre[1],
      button: "left",
      clickCount: 1,
    });
  }
  await sleep(1500);
  const settled = JSON.parse(await readScreen());
  clicked = { before: after.tabs, after: settled.tabs };
  console.log(`\n点那一行：标签 ${clicked.before} → ${clicked.after}`);
  // The density and the row shapes were read before the press, while the list was certainly there.
  if (settled.listFound) judged = settled;
  else console.log("（点开会话后列表收了回去，密度与行形状用点之前的读数）");
}

const failures = [];
if (expectDensity !== null && judged.density !== expectDensity) {
  failures.push(`密度是 ${judged.density}，不是 --expect 的 ${expectDensity}`);
}
if (judged.rows.length === 0) {
  failures.push("一行都没读到：这一轮什么都没量到，不能算通过");
}

for (const row of judged.rows) {
  if (row.nativeTitle !== null) {
    failures.push(`「${row.title}」还挂着原生 title（会和详情卡叠着弹两层）`);
  }
  if (expectDensity === "compact" || judged.density === "compact") {
    if (row.meta !== 0) failures.push(`「${row.title}」是紧凑行却还有 ${row.meta} 条数字行`);
  }
  if (expectDensity === "standard" || judged.density === "standard") {
    if (row.meta !== 1) failures.push(`「${row.title}」是标准行却没有那一条数字行`);
  }
  if (manage && !row.checkbox) {
    failures.push(`「${row.title}」在管理模式下没有勾选格`);
  }
}

if (hover) {
  // Both densities, both modes: exactly one card, and it says what the session is.
  if (after.cards.length !== 1) {
    failures.push(
      `${after.density} 行悬停后有 ${after.cards.length} 张详情卡，应该恰好一张（标准密度也要有）`,
    );
  }
  for (const card of after.cards) {
    if (card.ready !== "true") failures.push(`详情卡没置 data-ready：${card.ready}`);
    if (card.opacity !== "1") failures.push(`详情卡不可见：opacity ${card.opacity}`);
    if (card.title.length === 0) failures.push("详情卡没有标题");
    if (!/^[A-Za-z0-9_-]{6,}$/.test(card.id)) {
      failures.push(`详情卡里的 id 不像 id：${card.id}`);
    }
    if (!/^([A-Za-z]:[/\\]|[/\\]|\\\\|\/mnt\/|\/home\/)/.test(card.dir)) {
      failures.push(`详情卡里的目录不像目录：${card.dir}`);
    }
    if ((card.stats.match(/·/g) ?? []).length !== 2) {
      failures.push(`详情卡的用量不是三段：${card.stats}`);
    }
    // A top-level session says nothing about a parent and nothing about what it started; a subagent
    // says whose it is. Anything else is the dialog's job.
    if (card.children) {
      failures.push("详情卡画了「派出 N 个子代理」——那是对话框的事");
    }
    if (card.recordFields) {
      failures.push("详情卡又画了「来自 / 来源」，它该只有 id、目录、用量、所属会话");
    }
    // The row the card names is the row it is anchored to; its own badge is what says whether it is a
    // subagent, and the parent line has to agree with that.
    // `after` and not `judged`: the card belongs to the reading taken while the pointer was on the
    // row, and a later reading (after a click) is a different list.
    const described = after.rows.find((row) => row.id === card.describedBy[0]);
    if (!described) {
      failures.push(`卡片描述的行 ${card.describedBy[0]} 不在列表里`);
    } else if (described.subagent && card.parent === "") {
      failures.push("悬停的是子代理行，卡片却没有「所属会话」");
    } else if (!described.subagent && card.parent !== "") {
      failures.push(`主会话的卡片画了「所属会话」：${card.parent}`);
    }
    if (card.describedBy.length !== 1) {
      failures.push(
        `被描述的行不唯一：${JSON.stringify(card.describedBy)}`,
      );
    }
  }
}

if (manage) {
  // The badge is the manage view's own statement: a tick takes the children along.
  const badges = judged.rows.filter((row) => row.badge !== null).length;
  console.log(`带子代理徽标的行：${badges} / ${judged.rows.length}`);
  if (badges === 0) {
    failures.push("管理模式里没有任何一行带子代理徽标，勾选会连带删除的信息没有出现");
  }
}

if (clickRow && clicked && clicked.after <= clicked.before) {
  failures.push(`点那一行没能开出一个会话（标签 ${clicked.before} → ${clicked.after}）`);
}

if (failures.length === 0) {
  console.log(
    `\n通过：${judged.density} 的列表${manage ? "（管理模式）" : ""}，${judged.rows.length} 行都对得上。`,
  );
  process.exit(0);
}
console.log("\n不通过：");
for (const line of failures) console.log(`  - ${line}`);
process.exit(1);
