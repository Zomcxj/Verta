// Acceptance for the light variants: the three themes that only had a dark palette now answer the
// system's daylight too.
//
// A light variant is not "a theme with lighter colours" - it is what the app shows when the mode is
// light, so the check is the same one a person makes: switch the mode, look at the window. The
// reference is a theme that already had both (`nord`), which keeps the threshold honest: if the
// measurement said `nord` was dark, the threshold would be wrong rather than the new palette.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/theme-light-variants.mjs [--port=9222]
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

/**
 * What the window looks like right now, as a person would judge it.
 *
 * The colours are resolved through a probe element so `oklch`, `color-mix` and `rgba` all arrive as
 * plain numbers, and the luminance is computed here rather than eyeballed: a palette that is merely
 * "lighter grey" would still fail.
 */
const readWindow = async () =>
  JSON.parse(
    await evaluate(`(() => {
      const style = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.color = "var(--background)";
      document.body.appendChild(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      const match = colour.match(/[\\d.]+/g) ?? [];
      const [r, g, b] = match.slice(0, 3).map(Number);
      // Relative luminance, the sRGB formula, on 0-1 channels.
      const channel = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      return JSON.stringify({
        mode: document.documentElement.classList.contains("dark") ? "dark" : "light",
        background: colour,
        luminance: Math.round(luminance * 1000) / 1000,
        fg: style.getPropertyValue("--foreground").trim(),
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
  await invoke("plugin:event|emit", {
    event: EVENT,
    payload: { key, value },
  });
};

const original = { theme: await read("theme"), themeId: await read("themeId") };
report.before = original;

try {
  // A theme that already had both, to calibrate: without it the threshold would be a guess.
  const reference = { id: "nord", expect: "light" };
  const cases = [
    { id: "dracula", expect: "light" },
    { id: "kanagawa-dragon", expect: "light" },
    { id: "tokyo-night", expect: "light" },
  ];

  report.measured = {};
  for (const one of [reference, ...cases]) {
    await write("theme", "light");
    await write("themeId", one.id);
    await sleep(400);
    const seen = await readWindow();
    report.measured[one.id] = seen;
    if (seen.mode !== "light") {
      fail(`the window is still in ${seen.mode} mode after being asked for light`);
    }
    if (seen.luminance < 0.5) {
      fail(
        `${one.id} answers ${seen.background} (luminance ${seen.luminance}) for light mode - that is a dark palette`,
      );
    }
    // And the dark mode of the same theme has to stay dark, or the pair was just overwritten.
    await write("theme", "dark");
    await sleep(400);
    const dark = await readWindow();
    report.measured[`${one.id}:dark`] = dark;
    if (dark.mode !== "dark") fail(`the window is still in ${dark.mode} mode after being asked for dark`);
    if (dark.luminance > 0.3) {
      fail(`${one.id} answers ${dark.background} for dark mode - the light palette replaced it`);
    }
  }

  report.ok = true;
  console.log(
    `PASS: 三个原本只有暗色的主题在浅色下真的变亮——${cases
      .map(
        (c) =>
          `${c.id} ${report.measured[c.id].background}(${report.measured[c.id].luminance})/暗色 ${report.measured[`${c.id}:dark`].background}(${report.measured[`${c.id}:dark`].luminance})`,
      )
      .join("  ")}；对照 nord 浅色 ${report.measured.nord.background}(${report.measured.nord.luminance})。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `FAIL: ${error instanceof ProbeFailure ? error.message : String(error?.message ?? error)}`,
  );
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  // The user's own theme and mode go back, whatever happened above.
  try {
    if (original.theme !== undefined) await write("theme", original.theme);
    if (original.themeId !== undefined) await write("themeId", original.themeId);
  } catch {
    // The window may already be gone.
  }
  socket.close();
}
