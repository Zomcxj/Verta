// Acceptance for where a terminal opens when it has no usable working directory of its own
// (`user_spawn_cwd_or_default` in `src-tauri/src/modules/workspace.rs`).
//
// The claim is that such a shell lands on the user's **Desktop**, not in Verta's own launch folder. So the
// shell is asked to write its own working directory to a file: the answer comes from the process itself
// rather than from what the interface believes. Three cases, each one a real terminal spawned through the
// product's own `pty_open` and closed again afterwards:
//
//   1. no working directory at all (what a fresh terminal has),
//   2. a directory that does not exist (a restored tab whose folder is gone),
//   3. a directory that does exist: the control, since a fallback that lands on the Desktop every time
//      would pass the first two and be wrong.
//
// Nothing of the user's is touched: the sessions are opened and closed by this script, and the only file
// written is a scratch one under the temp folder. History: the first two branches had unit tests only and
// were never seen on a real machine, because this machine's front end always passes a usable directory.
//
// Usage: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 pnpm tauri dev
//        node scripts/dev/probes/desktop-fallback.mjs [--port=9222]
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";

const port = process.argv.find((a) => a.startsWith("--port="))?.slice(7) ?? "9222";

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
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

const OUT = `${process.env.TEMP}\\v\\shell-cwd.txt`;
const MISSING = `${process.env.TEMP.replace(/\\/g, "/")}/v/no-such-dir-verta-probe`;

const report = {};
try {
  report.shell = await evaluate(
    `window.__TAURI_INTERNALS__.invoke("pty_shell_name")`,
  );
  const isPowerShell = /powershell|pwsh/i.test(report.shell);

  // One terminal per case; the shell writes where it is, then the session is closed again.
  const askWhereItIs = async (label, cwd) => {
    rmSync(OUT, { force: true });
    const id = await evaluate(
      `window.__TAURI_INTERNALS__.invoke("pty_open", ${JSON.stringify({
        cols: 80,
        rows: 24,
        cwd,
        workspace: null,
        blocks: false,
        shell: null,
        paneId: null,
        presentation: null,
      })})`,
    );
    await sleep(1200);
    const command = isPowerShell
      ? `(Get-Location).Path | Out-File -Encoding utf8 "${OUT}"\r`
      : `cd > "${OUT}"\r`;
    // Raw bytes plus the id header: the shape the terminal itself writes input with (a JSON body is not
    // accepted, and the per-keystroke path avoids a round trip).
    await evaluate(`(async () => {
      const bytes = new TextEncoder().encode(${JSON.stringify(command)});
      await window.__TAURI_INTERNALS__.invoke("pty_write", bytes, { headers: { "x-pty-id": ${JSON.stringify(String(id))} } });
      return true;
    })()`);
    const until = Date.now() + 15000;
    while (Date.now() < until && !existsSync(OUT)) await sleep(300);
    const answer = existsSync(OUT)
      ? readFileSync(OUT, "utf8").trim()
      : "(命令没有回话)";
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke("pty_close", { id: ${JSON.stringify(id)} })`,
    );
    report[label] = { ptyId: id, cwdAsked: cwd, answer };
  };

  await askWhereItIs("noCwd", null);
  await askWhereItIs("missingCwd", MISSING);
  // The control: a directory that exists has to be kept, or the fallback would be happening everywhere.
  report.validPath = process.env.TEMP.replace(/\\/g, "/");
  await askWhereItIs("validCwd", report.validPath);
  // Windows keeps 8.3 aliases and the backend hands back the canonical path, so the control compares the
  // OS's own answer for the path it was given.
  report.verdict = {
    noCwdOnDesktop: /Desktop$/i.test(report.noCwd.answer),
    missingCwdOnDesktop: /Desktop$/i.test(report.missingCwd.answer),
    validCwdKept:
      report.validCwd.answer.toLowerCase() ===
      realpathSync.native(report.validPath).toLowerCase(),
  };
  report.ok = Object.values(report.verdict).every(Boolean);
} catch (error) {
  report.error = String(error?.message ?? error);
}
console.log(JSON.stringify(report, null, 1));
socket.close();