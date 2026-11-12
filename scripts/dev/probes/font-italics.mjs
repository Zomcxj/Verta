// Acceptance for the bundled monospace faces: the four combinations the renderer asks for really
// load, and the italic one is a typeface rather than a shear.
//
// Why it is worth a probe: the terminal keys a glyph on bold and italic separately and rasterises
// `${italic ? "italic " : ""}${bold ? "700" : weight}`, so 400/700 x upright/italic are four states
// it draws. With no italic face in the stylesheet the browser shears the upright outline instead -
// which looks close enough in a screenshot and is a different typeface in fact (a single-storey `a`,
// and an `f` that descends). A stylesheet test can say the rules exist; only the rendered page can
// say the faces arrived, and the ink of an italic `f` is what tells a real italic from a shear.
//
// Usage:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 ./src-tauri/target/release/verta.exe &
//   node scripts/dev/probes/font-italics.mjs [--port=9222]
const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

const report = {};
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
};

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page =
  targets.find((t) => t.type === "page" && t.url === "http://tauri.localhost/") ??
  targets.find((t) => t.type === "page" && t.url.includes("tauri.localhost/") && !t.url.includes("screenshot"));
if (!page) fail("no main window on the debugging port");
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
const evaluate = async (expression) => {
  const result = await new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  if (result.exceptionDetails) {
    throw new Error(
      `${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text} in: ${expression.slice(0, 140)}`,
    );
  }
  return result.result.value;
};

try {
  // ---- Which faces the document actually holds ------------------------------------------------
  report.faces = JSON.parse(
    await evaluate(`(async () => {
      // The terminal preloads all four before it rasterises anything; wait for the same promise the
      // app waits for rather than for whatever happens to have arrived.
      await document.fonts.ready;
      const faces = [...document.fonts]
        .filter((face) => face.family.replace(/["']/g, "") === "JetBrains Mono")
        .map((face) => ({ style: face.style, weight: face.weight, status: face.status }));
      const combos = faces.map((face) => face.style + " " + face.weight);
      return JSON.stringify({ faces, combos: [...new Set(combos)].sort() });
    })()`),
  );
  if (report.faces.faces.length === 0) fail("the document holds no JetBrains Mono face at all");
  for (const style of ["normal", "italic"]) {
    for (const weight of ["400", "700"]) {
      if (!report.faces.combos.includes(`${style} ${weight}`)) {
        fail(`${style} ${weight} is not in the document: ${JSON.stringify(report.faces.combos)}`);
      }
    }
  }
  const unloaded = report.faces.faces.filter((face) => face.status !== "loaded");
  if (unloaded.length > 0) fail(`a face did not load: ${JSON.stringify(unloaded)}`);

  // ---- And that the italic is a face, not a shear ---------------------------------------------
  //
  // An oblique is the upright outline skewed: its ink keeps the upright's height. JetBrains Mono's
  // italic `f` descends below the baseline, so an ink box that is *taller* in italic than in upright
  // is the one measurement a synthesised italic cannot produce.
  report.ink = JSON.parse(
    await evaluate(`(() => {
      const measure = (font) => {
        const canvas = document.createElement("canvas");
        canvas.width = 80;
        canvas.height = 80;
        const context = canvas.getContext("2d");
        context.fillStyle = "#000";
        context.textBaseline = "alphabetic";
        context.font = font;
        context.fillText("f", 20, 50);
        const data = context.getImageData(0, 0, 80, 80).data;
        let top = null;
        let bottom = null;
        let left = null;
        let right = null;
        for (let y = 0; y < 80; y += 1) {
          for (let x = 0; x < 80; x += 1) {
            if (data[(y * 80 + x) * 4 + 3] === 0) continue;
            if (top === null) top = y;
            bottom = y;
            if (left === null || x < left) left = x;
            if (right === null || x > right) right = x;
          }
        }
        return { top, bottom, left, right, advance: context.measureText("f").width };
      };
      return JSON.stringify({
        upright: measure('400 40px "JetBrains Mono"'),
        italic: measure('italic 400 40px "JetBrains Mono"'),
        bold: measure('700 40px "JetBrains Mono"'),
        boldItalic: measure('italic 700 40px "JetBrains Mono"'),
      });
    })()`),
  );
  const { upright, italic, bold, boldItalic } = report.ink;
  report.ink.baseline = 50;
  if (upright.top === null || italic.top === null) fail("nothing was drawn for the ink measurement");
  if (!(italic.bottom > upright.bottom)) {
    fail(
      `the italic f does not descend below the upright one (upright bottom ${upright.bottom}, italic ${italic.bottom}) - this is a sheared upright, not the italic face`,
    );
  }
  // Both are the same monospace: an italic cell has to keep the upright's advance, or every column
  // of an italic run in the terminal would drift.
  if (Math.abs(italic.advance - upright.advance) > 0.51) {
    fail(
      `the italic advance (${italic.advance}) differs from the upright one (${upright.advance})`,
    );
  }
  // The bold pair is drawn too, and the italic one descends the same way: a substitution would show
  // as the upright's measurements under a bold italic request.
  if (bold.top === null || boldItalic.top === null) fail("nothing was drawn for the bold measurement");
  report.ink.boldDescent = boldItalic.bottom > bold.bottom;
  if (!report.ink.boldDescent) {
    fail(
      `the bold italic does not descend below the bold (${boldItalic.bottom} vs ${bold.bottom})`,
    );
  }

  console.log(
    `PASS: JetBrains Mono 的四张脸都在文档里且 loaded（${report.faces.combos.join(" / ")}）；` +
      `斜体是真斜体不是斜切——'f' 的墨迹在斜体下伸到 y=${italic.bottom}，直立只到 ${upright.bottom}（基线 y=50），` +
      `两者 advance 相同（${italic.advance} px），说明等宽保住了。`,
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`FAIL: ${String(error?.message ?? error)}`);
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  socket.close();
}
