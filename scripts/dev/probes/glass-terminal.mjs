// Acceptance for the glass shape: a terminal that paints its own colour is a solid rectangle in the
// middle of a translucent window, and that was exactly what the window showed.
//
// The shape writes `--terminal-background: transparent`, but the terminal does not watch that
// variable - it reads the CSS variables when it is told the theme changed. So the bug was not a wrong
// colour, it was a colour nobody re-read: switching the shape left the pane painting whatever it
// resolved last. The check therefore has two halves: the token says zero alpha, *and* the live
// terminal surface has dropped its own background. Only the second half fails when the pane keeps a
// stale theme, which is the symptom a person sees as a black terminal in a glass window.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/glass-terminal.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";
const STORE = "verta-settings.json";
const EVENT = "verta://prefs-changed";

const report = {};
class ProbeFailure extends Error {}
const fail = (message) => {
  throw new ProbeFailure(message);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!page) fail("no main window: is the app running with --remote-debugging-port?");
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 160)}`,
    );
  }
  return result.result.value;
};
const invoke = (command, args) =>
  evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((value) => (value === undefined ? null : value)).catch((e) => "ERR " + String(e))`,
  );

/** The alpha of a resolved colour, which is how the terminal decides whether it paints anything. */
const alphaOf = (colour) => {
  const numbers = (colour ?? "").match(/[\d.]+/g)?.map(Number) ?? [];
  return numbers.length === 4 ? numbers[3] : numbers.length === 3 ? 1 : null;
};

/**
 * What the terminal is doing right now.
 *
 * `inline` is the surface's own background style: both renderers set it from the theme they applied,
 * so it is the honest answer to "did this pane notice". `token` is the variable the shape wrote,
 * resolved through a real element so `transparent`, `rgba()` and hex all arrive in one form.
 */
const readTerminal = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const root = document.querySelector("[data-verta-terminal-surface]");
      const probe = document.createElement("span");
      probe.style.color = "var(--terminal-background)";
      document.body.appendChild(probe);
      const token = getComputedStyle(probe).color;
      probe.remove();
      return JSON.stringify({
        surfaces: document.querySelectorAll("[data-verta-terminal-surface]").length,
        backend: root ? root.getAttribute("data-verta-ghostty-surface") : null,
        token,
        inline: root ? root.style.backgroundColor : null,
        computed: root ? getComputedStyle(root).backgroundColor : null,
      });
    })()`),
  );

const rid = await invoke("plugin:store|load", { path: STORE });
const store = typeof rid === "object" && rid !== null ? (rid.rid ?? rid) : rid;
if (typeof store === "string" && store.startsWith("ERR")) {
  fail(`the settings store would not open: ${store}`);
}

const read = async (key) => {
  const value = await invoke("plugin:store|get", { rid: store, key });
  return Array.isArray(value) ? (value[1] ? value[0] : undefined) : value;
};
const write = async (key, value) => {
  await invoke("plugin:store|set", { rid: store, key, value });
  await invoke("plugin:event|emit", { event: EVENT, payload: { key, value } });
};

const original = { shapeId: await read("shapeId"), themeId: await read("themeId") };
report.before = original;

const apply = async (shape) => {
  await write("shapeId", shape);
  await sleep(600);
  const seen = await readTerminal();
  report[shape] = seen;
  return seen;
};

try {
  const plain = await apply("minimal");
  if (plain.surfaces === 0) {
    fail("no terminal on screen: open one in the main window and run this again");
  }
  if (alphaOf(plain.token) !== 1) {
    fail(`the plain shape leaves the terminal at ${plain.token}, which paints nothing`);
  }

  const glass = await apply("glass");
  if (glass.surfaces !== plain.surfaces) {
    fail(`the terminal count changed from ${plain.surfaces} to ${glass.surfaces} mid-probe`);
  }
  if (alphaOf(glass.token) !== 0) {
    fail(`the glass shape writes ${glass.token}, which still paints a colour`);
  }
  // The half that the shape cannot satisfy on its own: the pane has to have re-read the variable.
  if (alphaOf(glass.inline) !== 0) {
    fail(
      `the terminal still paints ${glass.inline} in the glass shape - it kept the theme it read before the shape changed`,
    );
  }

  const back = await apply("slab");
  if (alphaOf(back.token) !== 1) {
    fail(`leaving the glass shape did not restore the terminal's colour: ${back.token}`);
  }
  if (alphaOf(back.inline) !== 1) {
    fail(`the terminal is still see-through after leaving the glass shape: ${back.inline}`);
  }
  if (back.token !== plain.token) {
    fail(`the terminal came back as ${back.token} instead of ${plain.token}`);
  }

  report.ok = true;
  console.log(
    `PASS: 玻璃形态下终端不再画底色——${plain.backend} 后端，极简 ${plain.inline}（令牌 ${plain.token}），玻璃 ${glass.inline}（令牌 ${glass.token}），回石板 ${back.inline}（令牌 ${back.token}）；共 ${plain.surfaces} 个终端。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // Whatever happened above, the shape the user had comes back.
  try {
    if (original.shapeId === undefined) {
      await invoke("plugin:store|delete", { rid: store, key: "shapeId" });
    } else {
      await write("shapeId", original.shapeId);
    }
  } catch {
    // The window may already be gone.
  }
  socket.close();
}
