// Acceptance for the tint every floating layer takes under the glass theme.
//
// The recipe lives in `globals.css`: `html[data-theme-glass] .verta-float` paints `--popover` at the
// theme's pane opacity as plain alpha (never a blur, see the compositing note in VERTA.md). A layer that
// does not carry the class keeps `bg-popover` at full opacity and reads as a solid slab over tinted
// panes, which is what a confirm window did until it joined the rest.
//
// So the check is a comparison, not a constant: a dropdown menu (which carried the class before any of
// this) is the reference, and every other surface has to compute the same colour. A surface that is
// missing altogether is reported as skipped rather than failed, since what can be opened depends on
// the account and on what the user's lists hold.
//
// Under a theme that is not glass this says nothing, so the probe refuses to run instead of changing the
// user's theme. Nothing it opens writes anywhere: a confirm window is cancelled, never confirmed, and no
// menu item that acts is chosen.
//
// Usage: node scripts/dev/probes/floating-layer-tint.mjs [--port=9222] [--shots=<dir>]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const SHOTS = process.argv.find((a) => a.startsWith("--shots="))?.slice(8) ?? null;

const { writeFileSync } = await import("node:fs");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

// Pointer sequences instead of `click()`: Radix opens on a real press, and the tab strip and the menus
// ignore a click that arrives without one.
const HELPERS = `
// Declared once on the window and aliased with \`var\`: these snippets are evaluated as scripts in the
// page's own global scope, so a second \`const press\` would be a redeclaration error.
window.__probe = window.__probe || {
  press: (node) => {
    const opts = { bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: "mouse" };
    node.dispatchEvent(new PointerEvent("pointerdown", opts));
    node.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
    node.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
    return true;
  },
  byText: (selector, text) => [...document.querySelectorAll(selector)].find((n) => (n.innerText || "").trim() === text),
  paneTable: (header) => [...document.querySelectorAll("table")].find((table) => (table.querySelector("tr")?.textContent || "").includes(header)) ?? null,
  layer: (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      hasClass: String(node.className).includes("verta-float"),
      background: style.backgroundColor,
      backdrop: style.backdropFilter,
      onScreen: rect.width > 0 && rect.height > 0
    };
  },
  escape: () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  }
};
var probePress = window.__probe.press;
var probeByText = window.__probe.byText;
var probeLayer = window.__probe.layer;
var probeEscape = window.__probe.escape;
var probePressByText = (selector, text) => {
  const node = probeByText(selector, text);
  if (!node) return "not-found";
  probePress(node);
  return "pressed";
};
var probePressByTitle = (title) => {
  const node = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "") === title);
  if (!node) return "not-found";
  probePress(node);
  return "pressed";
};
var probeRows = (header) => {
  const table = window.__probe.paneTable(header);
  return table ? [...table.querySelectorAll("tr")].slice(1) : [];
};
`;
const measure = (selector) =>
  evaluate(`JSON.stringify(probeLayer(${JSON.stringify(selector)}))`).then((text) =>
    JSON.parse(text),
  );

// An occluded WebView2 keeps its last frame, so a picture of what is on screen needs something to move
// a pointer over the page first; without the nudge the capture shows whatever was drawn seconds ago.
const nudge = async () => {
  for (const [x, y] of [
    [640, 300],
    [660, 320],
    [640, 300],
  ]) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      buttons: 0,
    });
    await sleep(150);
  }
  await sleep(400);
};
const photograph = async (name) => {
  if (!SHOTS) return null;
  await nudge();
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const path = `${SHOTS}/${name}.png`;
  writeFileSync(path, Buffer.from(shot.data, "base64"));
  return path;
};

const report = { surfaces: {}, shots: {}, skipped: [] };
const record = (name, measured) => {
  if (!measured || !measured.onScreen) {
    report.skipped.push(name);
    return;
  }
  report.surfaces[name] = measured;
};

try {
  const theme = JSON.parse(
    await evaluate(
      `JSON.stringify({ glass: document.documentElement.hasAttribute("data-theme-glass"), paneOpacity: getComputedStyle(document.documentElement).getPropertyValue("--theme-pane-opacity").trim() })`,
    ),
  );
  report.theme = theme;
  if (!theme.glass) {
    throw new Error(
      "现在是普通主题，不是玻璃主题：这个探针只在玻璃主题下有意义，不替你改主题。",
    );
  }

  // The projects pane, where one row carries a dropdown, a right-click menu and a hover card.
  report.panelOpened = await evaluate(
    `${HELPERS} probePressByTitle("本地项目与远程仓库")`,
  );
  await sleep(1200);
  await evaluate(`${HELPERS} probePressByText("[data-sub-value]", "本地项目")`);
  await sleep(1500);

  const menuOpened = await evaluate(`(() => {
    ${HELPERS}
    const row = probeRows("未提交")[1];
    const button = row && [...row.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "") === "更多操作");
    if (!button) return "no-button";
    probePress(button);
    return "pressed";
  })()`);
  await sleep(900);
  report.surfaces["dropdown menu (reference)"] = await measure(
    "[data-slot=dropdown-menu-content]",
  );
  report.menuOpened = menuOpened;
  await evaluate(`${HELPERS} probeEscape()`);
  await sleep(700);

  const contextMenu = await evaluate(`(() => {
    ${HELPERS}
    const row = probeRows("未提交")[1];
    if (!row) return "no-row";
    const rect = row.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, button: 2, buttons: 2, isPrimary: false, pointerId: 1, pointerType: "mouse", clientX: rect.x + 60, clientY: rect.y + 8 };
    row.dispatchEvent(new PointerEvent("pointerdown", opts));
    row.dispatchEvent(new MouseEvent("contextmenu", { ...opts, buttons: 0 }));
    return "fired";
  })()`);
  report.contextMenuFired = contextMenu;
  await sleep(900);
  record("right-click menu", await measure("[data-slot=context-menu-content]"));
  report.shots.contextMenu = await photograph("floating-tint-context-menu");
  await evaluate(`${HELPERS} probeEscape()`);
  await sleep(700);

  const hoverFired = await evaluate(`(() => {
    ${HELPERS}
    const row = probeRows("未提交")[1];
    const button = row && row.querySelector("button[title]");
    if (!button) return "no-button";
    const rect = button.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", clientX: rect.x + 20, clientY: rect.y + 8 };
    button.dispatchEvent(new PointerEvent("pointerover", opts));
    button.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
    button.dispatchEvent(new MouseEvent("mouseover", opts));
    return "fired";
  })()`);
  report.hoverFired = hoverFired;
  await sleep(1600);
  record("hover card", await measure("[data-slot=hover-card-content]"));
  await evaluate(
    `${HELPERS} document.querySelector("[data-slot=hover-card-trigger]")?.dispatchEvent(new PointerEvent("pointerleave", { pointerId: 1 }))`,
  );
  await sleep(700);

  // The remote pane: a dropdown inside the create-repository window, and the confirm window behind 删除.
  await evaluate(`${HELPERS} probePressByText("[data-sub-value]", "远程仓库")`);
  await sleep(1500);
  report.newRepoOpened = await evaluate(
    `${HELPERS} probePressByText("button", "新建仓库…")`,
  );
  // The window mounts and its fields land in their own tick, so the trigger is waited for rather than
  // assumed to be there.
  let selectPressed = "not-yet";
  for (let attempt = 0; attempt < 20 && selectPressed === "not-yet"; attempt += 1) {
    await sleep(400);
    selectPressed = await evaluate(`(() => {
      ${HELPERS}
      const dialog = document.querySelector("[data-slot=dialog-content][data-state=open]");
      const trigger = dialog && dialog.querySelector("[data-slot=select-trigger]");
      if (!trigger) return "not-yet";
      probePress(trigger);
      return "pressed";
    })()`);
  }
  report.selectPressed = selectPressed;
  await sleep(900);
  record("dropdown (select)", await measure("[data-slot=select-content]"));
  await evaluate(`${HELPERS} probeEscape()`);
  await sleep(700);
  await evaluate(`(() => {
    ${HELPERS}
    const dialog = document.querySelector("[data-slot=dialog-content][data-state=open]");
    const button = dialog && dialog.querySelector("[data-slot=dialog-close]");
    if (button) probePress(button);
    return true;
  })()`);
  await sleep(900);

  // A repository with runs, if the panel lists one; the run list is read, never changed.
  const rows = await evaluate(
    `${HELPERS} JSON.stringify(probeRows("仓库").map((tr) => (tr.querySelector("td")?.textContent || "").trim()).filter(Boolean).slice(0, 6))`,
  );
  report.repos = JSON.parse(rows);
  const repo = report.repos.find((name) => name.includes("/"));
  if (repo) {
    await evaluate(`(() => {
      ${HELPERS}
      const row = probeRows("仓库").find((tr) => (tr.textContent || "").includes(${JSON.stringify(repo)}));
      if (row) probePress(row);
      return true;
    })()`);
    let runRows = 0;
    for (let attempt = 0; attempt < 40 && runRows === 0; attempt += 1) {
      await sleep(400);
      runRows = Number(
        await evaluate(
          `document.querySelectorAll("[data-slot=dialog-content][data-state=open] tbody tr").length`,
        ),
      );
    }
    report.runRows = runRows;
    report.deletePressed = await evaluate(
      `${HELPERS} probePressByText("button", "删除")`,
    );
    await sleep(1200);
    record("confirm window", await measure("[data-slot=alert-dialog-content]"));
    report.shots.confirm = await photograph("floating-tint-confirm");
    // Cancel: the confirm window is the one place here where the other button deletes a run on GitHub.
    report.cancelled = await evaluate(`(() => {
      ${HELPERS}
      const dialog = document.querySelector("[data-slot=alert-dialog-content]");
      const node = dialog && probeByText("button", "取消");
      if (!node) return "no-cancel-button";
      probePress(node);
      return "pressed";
    })()`);
    await sleep(900);
    await evaluate(`(() => {
      ${HELPERS}
      const dialog = document.querySelector("[data-slot=dialog-content][data-state=open]");
      const button = dialog && dialog.querySelector("[data-slot=dialog-close]");
      if (button) probePress(button);
      return true;
    })()`);
    await sleep(700);
  } else {
    report.skipped.push("confirm window (面板里没有仓库)");
  }

  const reference = report.surfaces["dropdown menu (reference)"];
  report.verdict = { reference: reference?.background ?? null, matches: {}, classes: {} };
  for (const [name, surface] of Object.entries(report.surfaces)) {
    report.verdict.matches[name] = surface.background === reference?.background;
    report.verdict.classes[name] = surface.hasClass;
  }
  report.ok = Object.values(report.verdict.matches).every(Boolean) &&
    Object.values(report.verdict.classes).every(Boolean);
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();