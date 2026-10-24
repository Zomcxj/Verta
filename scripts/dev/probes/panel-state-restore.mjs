// Acceptance for "an opened panel draws what it remembered, and then checks".
//
// Both lists remember their last state in `verta-projects.json` and `verta-remotes.json`, so an
// opened panel shows the rows as they were instead of showing every one of them as unchecked
// until a batch of git reads comes back. This proves it on the running app.
//
// A check and the state it replaces are usually identical, so content alone cannot tell which
// one is on screen. This puts a marker in the store instead: a snapshot whose only difference
// from the real one is one project's branch, stamped now, which makes it newer than whatever
// the panel holds. If the panel reads what it remembered, the marker shows up in a row; a check
// would put the real branch back. Seeing the marker *while the check is still out* is the whole
// claim, so the sampling runs inside the page every 5ms and starts with the tab closed.
//
//   node scripts/dev/probes/panel-state-restore.mjs [--port=9222]
import { readFileSync } from "node:fs";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const debug = process.argv.includes("--debug");
const STORE_DIR = `${process.env.APPDATA}\\app.verta`;
const PROJECTS_FILE = `${STORE_DIR}\\verta-projects.json`;
const REMOTES_FILE = `${STORE_DIR}\\verta-remotes.json`;
const PROJECTS_STATUS_MODULE = "/src/modules/projects/lib/statusStore.ts";
const REMOTES_LIST_MODULE = "/src/modules/remotes/lib/listStore.ts";
const MARKER = "VERTA-PROBE";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("no main window found; is the dev app up?");
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

const HEADER_BUTTON = `[...document.querySelectorAll("button[title]")].find((b) => b.title === "本地项目与远程仓库")`;
const ACTIVE_TAB_CLOSE = `document.querySelector('[aria-selected="true"] [aria-label="关闭标签页"]')`;
const PROJECTS_STOP = `document.querySelector('[data-sub-value="projects"]')`;
const REMOTES_STOP = `document.querySelector('[data-sub-value="remotes"]')`;

const clickInPage = async (expression, what) => {
  const clicked = await evaluate(
    `(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`,
  );
  if (!clicked) fail(`could not click ${what}`);
};

const activeTab = () =>
  evaluate(
    `(document.querySelector('[aria-selected="true"]')?.innerText || '').trim().slice(0, 30)`,
  );

/** Every step, when asked: which tab is in front and is the panel's pane the visible one. */
const trace = async (label) => {
  if (!debug) return;
  const state = await evaluate(`(() => {
    const chips = [...document.querySelectorAll('[aria-selected]')].map((n) => (n.getAttribute("aria-selected") === "true" ? "[" + (n.innerText || "").trim().slice(0, 16) + "]" : (n.innerText || "").trim().slice(0, 16))).join(" ");
    return chips + "  paneHidden=" + !!document.querySelector('[data-sub-value="projects"]')?.closest('[aria-hidden="true"]');
  })()`);
  console.log(`${String(Date.now()).slice(-5)} ${label}: ${state}`);
};

/** A real mouse press and release, for the controls that listen for pointer down rather than click. */
const clickAt = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(40);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};

/**
 * Bring the projects panel to the front. The header button opens the tab but does not focus one
 * that is already there, and a pane behind another tab draws no rows at all. The press is a real
 * mouse press: a tab is activated on pointer down, so a synthesized click does nothing.
 */
const focusProjectsTab = async () => {
  for (let i = 0; i < 25; i++) {
    const front = await evaluate(
      `/本地项目|远程仓库/.test((document.querySelector('[aria-selected="true"]')?.innerText || "").trim())`,
    );
    if (front) return true;
    const at = await evaluate(`(() => {
      const chip = [...document.querySelectorAll('[aria-selected]')].find((n) => /本地项目|远程仓库/.test((n.innerText || "").trim()));
      if (!chip) return null;
      const r = chip.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!at) return false;
    await clickAt(at.x, at.y);
    await sleep(300);
  }
  return false;
};

/** Close the panel's tab. The view itself stays in the document (see the note in the report). */
const closePanel = async () => {
  if (!(await focusProjectsTab())) fail("the projects tab is not on screen, so there is nothing to close");
  const was = await activeTab();
  await clickInPage(ACTIVE_TAB_CLOSE, "the tab's close button");
  for (let i = 0; i < 60; i++) {
    if ((await activeTab()) !== was) return;
    await sleep(30);
  }
  fail(`the tab did not close (still "${was}")`);
};

/** The rows on screen, as the first cell's text (the project or repository name) and the whole row. */
const visibleRows = () =>
  evaluate(`JSON.stringify((() => {
    const out = [];
    for (const table of document.querySelectorAll("table")) {
      if (typeof table.checkVisibility === "function" && !table.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      for (const tr of table.querySelectorAll("tbody tr")) {
        if (tr.closest("[inert]")) continue;
        out.push({
          first: (tr.querySelector("td")?.textContent || "").trim(),
          text: (tr.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
        });
      }
    }
    return out;
  })())`).then((raw) => JSON.parse(raw));

const busyNow = () =>
  evaluate(
    `[...document.querySelectorAll("button")].some((b) => ["检查中", "读取中"].some((w) => (b.innerText || "").trim().startsWith(w)))`,
  );

/**
 * Wait for the panel to be on screen with rows and hand back those rows. `requireIdle` also waits
 * for the check to have come back, which a network-bound batch of git reads can take a while to
 * do; phase one only needs the rows, so it does not ask for it.
 */
const waitForRows = async (ms, requireIdle = true, stableFor = 600) => {
  const started = Date.now();
  let cleanSince = null;
  let lastLog = 0;
  while (Date.now() - started < ms) {
    let rows = await visibleRows();
    if (rows.length === 0) {
      // The panel is not the front tab: a pane behind another one draws no rows at all, and
      // nothing guarantees it stays in front for the whole run.
      await focusProjectsTab();
      rows = await visibleRows();
    }
    const busy = requireIdle ? await busyNow() : false;
    if (debug && Date.now() - lastLog > 2000) {
      lastLog = Date.now();
      const front = await activeTab();
      console.log(`  waiting: front="${front}" rows=${rows.length} busy=${busy}`);
    }
    if (rows.length > 0 && !busy) {
      if (cleanSince === null) cleanSince = Date.now();
      if (Date.now() - cleanSince >= stableFor) return rows;
    } else {
      cleanSince = null;
    }
    await sleep(200);
  }
  return null;
};

const memoryAt = (modulePath, reader) =>
  evaluate(`(async () => {
    const mod = await import(${JSON.stringify(modulePath)});
    const held = mod.${reader}();
    return held ? held.at : null;
  })()`);

const storeFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** Wait for the store's disk write to land, since it is deliberately not awaited. */
const awaitOnDisk = async (path, at, ms) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const file = storeFile(path);
    if (file?.statuses?.at === at) return true;
    await sleep(50);
  }
  return false;
};

/**
 * The sampler, serialized into the page. It is stringified and evaluated there, so it may only
 * use its own options and page globals.
 *
 * `busyLabel` is the word the refresh button shows while a read is out, which is how the sampler
 * knows when that read came back. `uncheckedWord` is what a row says when it has no status yet.
 * `markerWord` is what the store copy carries and a finished check would not.
 *
 * Rows come from tables that are really rendered, and the text is read with `textContent`: the
 * inactive half of the panel and the tabs behind the active one are still in the document, and
 * `innerText` on a whole table forces a layout on every tick.
 */
const sampler = function (options) {
  const { modulePath, memoryReader, busyLabel, uncheckedWord, markerWord } = options;
  return (async () => {
    const store = await import(modulePath);
    const probe = {
      t0: performance.now(),
      stop: false,
      samples: 0,
      longestTickMs: 0,
      firstRowTs: null,
      firstRowTotal: null,
      firstRowStatused: null,
      firstRowText: null,
      memAtFirstRow: null,
      statusedTs: null,
      markerTs: null,
      markerRow: null,
      uncheckedSeen: false,
      busyTs: null,
      doneTs: null,
    };
    window.__panelProbe = probe;
    const visible = (el) =>
      typeof el.checkVisibility === "function"
        ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        : true;
    const rows = () => {
      const out = [];
      for (const table of document.querySelectorAll("table")) {
        if (!visible(table)) continue;
        for (const tr of table.querySelectorAll("tbody tr")) {
          if (!tr.closest("[inert]")) out.push(tr);
        }
      }
      return out;
    };
    const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
    const filled = (all) =>
      all.filter((tr) => !textOf(tr).includes(uncheckedWord));
    const busy = () =>
      [...document.querySelectorAll("button")].some((b) =>
        (b.innerText || "").trim().startsWith(busyLabel),
      );
    (async () => {
      while (!probe.stop) {
        const ticked = performance.now();
        probe.samples++;
        const all = rows();
        const good = all.length ? filled(all) : [];
        if (all.length) {
          if (probe.firstRowTs === null) {
            probe.firstRowTs = ticked - probe.t0;
            probe.firstRowTotal = all.length;
            probe.firstRowStatused = good.length;
            probe.firstRowText = textOf(all[0]).slice(0, 70);
            // Read in the same tick as the row, so the stamp belongs to what is on screen.
            const held = store[memoryReader]();
            probe.memAtFirstRow = held ? held.at : null;
          }
          if (probe.statusedTs === null && good.length > 0) probe.statusedTs = ticked - probe.t0;
          if (good.length < all.length) probe.uncheckedSeen = true;
          if (probe.markerTs === null) {
            const marked = all.find((tr) => textOf(tr).includes(markerWord));
            if (marked) {
              probe.markerTs = ticked - probe.t0;
              probe.markerRow = textOf(marked).slice(0, 80);
            }
          }
        }
        const working = busy();
        if (working) {
          if (probe.busyTs === null) probe.busyTs = ticked - probe.t0;
        } else if (probe.busyTs !== null && probe.doneTs === null) {
          probe.doneTs = ticked - probe.t0;
        }
        const took = performance.now() - ticked;
        if (took > probe.longestTickMs) probe.longestTickMs = Math.round(took);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    return "sampler started";
  })();
};

const startSampler = (options) =>
  evaluate(`(${sampler.toString()})(${JSON.stringify(options)})`);
const readSampler = () =>
  evaluate(`JSON.stringify(window.__panelProbe)`).then((raw) => JSON.parse(raw));
const stopSampler = () =>
  evaluate(`(() => { window.__panelProbe.stop = true; return true; })()`);

/** Run the sampler until it has seen the marker and the read behind it come back. */
const sampleUntilDone = async (ms) => {
  const started = Date.now();
  let probe = await readSampler();
  while (Date.now() - started < ms) {
    if (probe.markerTs !== null && probe.doneTs !== null) break;
    await sleep(200);
    probe = await readSampler();
  }
  await stopSampler();
  return readSampler();
};

/** Put a marked snapshot in the store: newer than anything the panel holds, one branch renamed. */
const writeMarker = async (branchOfFirstRow) =>
  evaluate(`(async () => {
    const mod = await import(${JSON.stringify(PROJECTS_STATUS_MODULE)});
    const held = mod.readStatusSnapshotMemory();
    if (!held) return { ok: false, why: "no memory snapshot to mark" };
    const statuses = { ...held.statuses };
    const key = Object.keys(statuses).find((k) => k.split(/[\\\\/]/).pop() === ${JSON.stringify(branchOfFirstRow)});
    if (!key) return { ok: false, why: "no status for the first row", keys: Object.keys(statuses).length };
    const real = statuses[key];
    statuses[key] = { ...real, branch: ${JSON.stringify(MARKER)} };
    const at = Date.now();
    mod.rememberStatuses({ at, statuses });
    return { ok: true, at, key, was: real.branch };
  })()`);

/**
 * Write the marker and make sure it survives. A check that was already out when the marker
 * landed writes a newer stamp a moment later, which would let the mark lose the comparison the
 * panel makes against it; when that happens the panel is left to settle and the mark is redone.
 */
const markWithCheck = async (name) => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const marked = await writeMarker(name);
    if (!marked.ok) return marked;
    await sleep(800);
    if ((await memoryAt(PROJECTS_STATUS_MODULE, "readStatusSnapshotMemory")) === marked.at) {
      return marked;
    }
    // A check that was already out wrote a newer stamp on top of it. Wait for that one to land
    // and mark again, since the next write is the one that decides.
    await sleep(2000);
  }
  return { ok: false, why: "a check kept overwriting the marked snapshot" };
};

/** Put the real snapshot back, and wait until the marked one is gone from the file. */
const restore = async (original) => {
  await evaluate(`(async () => {
    const mod = await import(${JSON.stringify(PROJECTS_STATUS_MODULE)});
    mod.rememberStatuses({ at: ${original.at}, statuses: ${JSON.stringify(original.statuses)} });
    return true;
  })()`);
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const statuses = storeFile(PROJECTS_FILE)?.statuses?.statuses ?? {};
    if (!Object.values(statuses).some((s) => s && s.branch === MARKER)) return true;
    await sleep(50);
  }
  return false;
};

try {
  // ---- 1. The projects panel, warm, and the file behind it ----
  await clickInPage(HEADER_BUTTON, "the projects header button");
  await sleep(400);
  if (!(await focusProjectsTab())) fail("the projects panel never came to the front");
  await clickInPage(PROJECTS_STOP, "the local projects stop");
  await trace("phase 1");
  // Rows with statuses are what phase one needs; the check behind them may still be running.
  const warmRows = await waitForRows(45000, false);
  await trace("phase 1 done");
  if (!warmRows) fail("the projects panel never showed a row with a status");
  const projectsFile = storeFile(PROJECTS_FILE);
  const original = {
    at: projectsFile?.statuses?.at ?? null,
    statuses: projectsFile?.statuses?.statuses ?? null,
  };
  report.projectsWarm = {
    firstRow: warmRows[0]?.text ?? null,
    rows: warmRows.length,
    unchecked: warmRows.filter((r) => r.text.includes("未检查")).length,
    file: { statuses: Object.keys(original.statuses ?? {}).length, at: original.at },
  };
  if (!warmRows.length) fail("no row in the projects panel");
  if (report.projectsWarm.unchecked > 0) fail("a row is still unchecked after a full check");
  if (!report.projectsWarm.file.statuses) fail("verta-projects.json holds no statuses");
  // The first cell of the first row is the folder name, which is how the marked status is found.
  const firstRowName = warmRows[0].first;

  // ---- 2. The store's copy is what an opened panel draws ----
  const marked = await markWithCheck(firstRowName);
  report.marker = marked;
  if (!marked.ok) fail(`could not write the marker: ${marked.why}`);
  if (!(await awaitOnDisk(PROJECTS_FILE, marked.at, 4000))) {
    fail("the marked snapshot never reached verta-projects.json");
  }
  let run = null;
  try {
    await trace("before close");
    await closePanel();
    await trace("after close");
    // What a closed panel leaves behind: it is still mounted, which is why its own state (not
    // the store) is what survives a close and an open.
    report.closedPanel = JSON.parse(
      await evaluate(`JSON.stringify({
        panels: document.querySelectorAll('[data-sub-value="projects"]').length,
        hidden: !!document.querySelector('[data-sub-value="projects"]')?.closest('[aria-hidden="true"]'),
        rows: [...document.querySelectorAll("table tbody tr")].filter((tr) => !tr.closest("[inert]")).length,
      })`),
    );
    await startSampler({
      modulePath: PROJECTS_STATUS_MODULE,
      memoryReader: "readStatusSnapshotMemory",
      busyLabel: "检查中",
      uncheckedWord: "未检查",
      markerWord: MARKER,
    });
    await clickInPage(HEADER_BUTTON, "the projects header button");
    await focusProjectsTab();
    await trace("reopened");
    run = await sampleUntilDone(40000);
    await trace("sampled");
    report.reopen = run;
    if (run.firstRowTs === null) throw new Error("the reopened panel drew no row at all");
    if (run.uncheckedSeen) throw new Error("a row was unchecked on screen while the store had a status for it");
    if (run.markerTs === null) {
      throw new Error("the reopened panel never drew the store's own copy, so it did not read what it remembered");
    }
    // A check that never came back during the sampling window is not a failure: the store's copy
    // was on screen for as long as the sampling ran, which is the claim.
    if (run.doneTs !== null && run.markerTs >= run.doneTs) {
      throw new Error(
        `the store's copy appeared at ${Math.round(run.markerTs)}ms but the check returned at ` +
          `${Math.round(run.doneTs)}ms, so it was the check that drew it`,
      );
    }
  } finally {
    // The marked snapshot is a lab fixture: it goes back, whether the sampling above worked or
    // not. The panel's own check settles the rows either way.
    report.restore = { markerCleared: await restore(original) };
  }

  // ---- 3. The real snapshot is back, and the panel's own check settles the rows ----
  if (!report.restore.markerCleared) fail("the marked snapshot is still in verta-projects.json");
  // This half waits for the panel's own check to come back, which a network-bound batch can take
  // minutes to do. What matters either way is that the file holds no marker, which is what the
  // restore above settled; when the check does come back, the rows must show its own values.
  const afterRows = await waitForRows(180000, true);
  report.restored = afterRows
    ? {
        checkCameBack: true,
        markerOnScreen: afterRows.some((r) => r.text.includes(MARKER)),
        firstRow: afterRows[0]?.text ?? null,
      }
    : { checkCameBack: false, note: "the panel's check did not come back within 180s" };
  if (report.restored.checkCameBack && report.restored.markerOnScreen) {
    fail("the marked branch is still on screen after the check settled");
  }
  if (!report.restored.checkCameBack) {
    console.warn(
      "WARN: the panel's check did not come back within 180s, so this run did not watch the rows " +
        "being settled; verta-projects.json was put back and holds no marker",
    );
  }

  // ---- 4. The repository list: the file holds what a fresh window would draw ----
  // Its read is what writes the file, so the panel is opened on it first.
  await clickInPage(HEADER_BUTTON, "the projects header button");
  await focusProjectsTab();
  await clickInPage(REMOTES_STOP, "the remote repositories stop");
  const remotesStarted = Date.now();
  while (Date.now() - remotesStarted < 40000 && !storeFile(REMOTES_FILE)) await sleep(300);
  await sleep(1000);
  const remotesFile = storeFile(REMOTES_FILE);
  report.remotes = {
    file: {
      at: remotesFile?.payload?.at ?? null,
      kind: remotesFile?.payload?.payload?.kind ?? null,
      rows: remotesFile?.payload?.payload?.repos?.length ?? null,
    },
    readBack: await evaluate(`(async () => {
      const mod = await import(${JSON.stringify(REMOTES_LIST_MODULE)});
      const held = await mod.readRepoSnapshot();
      return held ? { at: held.at, kind: held.payload?.kind ?? null, rows: (held.payload?.repos || []).length } : null;
    })()`),
    memory: await evaluate(`(async () => {
      const mod = await import(${JSON.stringify(REMOTES_LIST_MODULE)});
      const held = mod.readRepoSnapshotMemory();
      return held ? held.at : null;
    })()`),
  };
  if (!remotesFile) fail("verta-remotes.json was never written, so a fresh window has nothing to draw");
  if (!report.remotes.readBack) fail("the repository list's store read back nothing for a fresh window");
  // The stamp is when the view wrote it, which its own payload change moves; what a fresh window
  // draws is the payload itself.
  if (report.remotes.readBack.kind !== report.remotes.file.kind) {
    fail("the store read back a different payload than the file holds");
  }
  if (report.remotes.readBack.rows !== report.remotes.file.rows) {
    fail("the store read back a different number of repositories than the file holds");
  }

  await clickInPage(PROJECTS_STOP, "the local projects stop");
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `PASS: the store's copy was on screen ${Math.round(run.markerTs)}ms after the tab was opened, ` +
      `while the check was still out (${run.doneTs === null ? "it had not come back when the sampling stopped" : `it came back at ${Math.round(run.doneTs)}ms`}); ` +
      `the file was put back and holds no marker; the repository list's file holds ` +
      `${report.remotes.file.rows} repositories (kind ${report.remotes.file.kind}) that a fresh window reads back`,
  );
} catch (error) {
  fail(String(error?.message ?? error));
} finally {
  socket.close();
}