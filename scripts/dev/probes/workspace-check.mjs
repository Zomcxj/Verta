// Reads a file through the app's own IPC, from the running window, to check that the workspace
// check refuses a path nobody opened and still allows one that is open.
//
// The change under test is in the Rust commands, so there is no other way to see it: a unit test
// exercises the helper, this exercises the command the editor actually calls.
const targets = await (await fetch("http://localhost:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.endsWith("1420/"));
if (!page) {
  console.error("dev 起来了？没找到主窗口的 page 目标。");
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
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description ??
        r.result.exceptionDetails.text,
    );
  }
  return r.result?.result?.value;
};

const invoke = (command, args) =>
  ev(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
      return JSON.stringify({ ok: true, value });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e) });
    }
  })()`);

const show = (raw) => {
  const r = JSON.parse(raw);
  return r.ok ? r.value : `refused: ${r.error}`;
};

const report = {};
// Inside the tree the app was started in: the editor opens and saves these.
report.authorizedRead = show(
  await invoke("fs_read_file", {
    path: "D:/VsPro/Verta/package.json",
    workspace: { kind: "local" },
  }),
);
// A directory nobody opened. It exists, is readable by the process, and is not under any root.
report.foreignRead = show(
  await invoke("fs_read_file", {
    path: "D:/software/miniforge3/etc/profile.d/conda.sh",
    workspace: { kind: "local" },
  }),
);
report.foreignWrite = show(
  await invoke("fs_write_file", {
    path: "D:/software/miniforge3/verta-should-not-exist.txt",
    content: "x",
    workspace: { kind: "local" },
    source: null,
  }),
);
report.foreignCreate = show(
  await invoke("fs_create_file", {
    path: "D:/software/miniforge3/verta-should-not-exist.txt",
    workspace: { kind: "local" },
  }),
);
// The same write inside the tree still works, which is what keeps the editor usable.
report.authorizedWrite = show(
  await invoke("fs_write_file", {
    path: "D:/VsPro/Verta/.superpowers/tmp-write-probe.txt",
    content: "probe",
    workspace: { kind: "local" },
    source: null,
  }),
);
console.log(JSON.stringify(report, null, 1));
socket.close();