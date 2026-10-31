// The opencode service read a distro performs, measured inside the distro.
//
// `wsl-service-credentials.mjs` runs the same program under this machine's python, which shows
// what the program does but not what a distro does with it: another interpreter, another
// environment, and one extra hop. This runs it there.
//
// The measurements are split in two, because the home directory a distro process sees cannot be
// chosen from here. WSL sets HOME from the distro's own user and does not take one from this side
// (measured 2026-10-31: with HOME set in the launcher's environment and shared through
// `WSLENV=HOME/u`, a distro process still reports `/home/<user>`), so the application's own
// invocation always reads the distro user's real service file, and a synthetic one can only be
// pointed at by a program already running inside the distro.
//
//   * the transport, run exactly as the application runs it, against the distro user's own service
//     file. It answers whether the program survives the trip through `wsl.exe` and the distro's
//     python accepts it. It prints nothing unless that distro's own opencode service is listening,
//     which this probe does not start, wait for or change: the file is read, never written.
//   * the boundary, run by a harness inside the distro, which is where a synthetic home can be set:
//     two loopback servers, one the service and one where a redirect, a proxy or a URL naming
//     another host would send the request, and the same checks the Windows-side probe makes, plus
//     the distro's own proxy variables, which a distro is far likelier to carry than this machine.
//
// Usage:
//   node scripts/dev/probes/wsl-service-credentials-in-distro.mjs
//   node scripts/dev/probes/wsl-service-credentials-in-distro.mjs --distro=Ubuntu-22.04
//   node scripts/dev/probes/wsl-service-credentials-in-distro.mjs --program-from=e09f124^
//     (the falsification run: that revision's program is measured instead of this tree's, and the
//      checks the fix closed are the ones that fail)
//
// Exits 1 when the boundary leaks, 2 when the run could not be made. Nothing is left behind: the
// harness works in its own temporary directory and removes it, and this file removes the script
// directory it wrote into this machine's temp.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

// `wsl.exe` writes its output as UTF-16 on some paths and UTF-8 on others, which is what the
// application's own decode does with it.
const decode = (buffer) =>
  buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");

const wslRaw = (args) => {
  const out = spawnSync("wsl.exe", args, { timeout: 120000 });
  return {
    status: out.status,
    stdout: decode(out.stdout ?? Buffer.alloc(0)),
    stderr: decode(out.stderr ?? Buffer.alloc(0)),
  };
};

const wsl = (distro, args) => wslRaw(["-d", distro, ...args]);

/** The distro to measure: the one named, or the first one this machine lists. */
const distro = (() => {
  const asked = arg("distro");
  if (asked !== null) return asked;
  const first = wslRaw(["-l", "-q"])
    .stdout.split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .find((line) => line.length > 0);
  if (first === undefined) {
    console.error("没有可用的发行版：wsl.exe -l -q 没有列出任何名字。");
    process.exit(2);
  }
  return first;
})();

// The program is taken out of the Rust source: that is what the application sends, and a copy kept
// here would be a measurement of the copy. `--program-from=<rev>` takes it from that revision
// instead, which is the falsification run: measured against the program as it was before the
// redirect was refused, this probe has to fail. Doing it that way rather than by editing the source
// keeps the dev build out of it.
const READER = "src-tauri/src/modules/agent_sessions/wsl.rs";
const fromRev = arg("program-from");
const readerSource = (() => {
  if (fromRev === null) return readFileSync(READER, "utf8");
  const out = spawnSync("git", ["show", `${fromRev}:${READER}`], { encoding: "utf8" });
  if (out.status !== 0 || (out.stdout ?? "").length === 0) {
    console.error(`could not read ${READER} at ${fromRev}: ${out.stderr ?? ""}`);
    process.exit(2);
  }
  return out.stdout;
})();
const programs = [...readerSource.matchAll(/r#"([\s\S]*?)"#/g)]
  .map((match) => match[1])
  .filter((text) => text.includes("/api/session"));
if (programs.length !== 1) {
  console.error(`expected exactly one script carrying /api/session, found ${programs.length}`);
  process.exit(2);
}
const program = programs[0];

// The harness, run by the distro's own python3. It is written to this machine's temp directory and
// handed over by its `/mnt` path, which is how the application hands a script to a distro too.
const HARNESS = `
import json, os, shutil, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "service_turns.py"), encoding="utf-8") as handle:
    PROGRAM = handle.read()

REPLY_OK = '{"data":[{"id":"ses_running","time":{"busy":200,"idle":100}}]}'
REPLY_IDLE = '{"data":[{"id":"ses_done","time":{"busy":1,"idle":2}}]}'
REPLY_WRONG = '{"data":"nope"}'
REPLY_BAD_STAMP = '{"data":[{"id":"ses_x","time":{"busy":true,"idle":1}}]}'
PROXY_KEYS = ("http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")


class Handler(BaseHTTPRequestHandler):
    """Answers from the reply its server was built with, and records every request it saw."""

    def do_GET(self):
        self.server.seen.append({
            "path": self.path,
            "authorization": self.headers.get("Authorization") is not None,
        })
        status, body = self.server.reply
        self.send_response(status)
        if self.server.location:
            self.send_header("Location", self.server.location)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, *args):
        pass


def serve(reply, location=None):
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server.reply = reply
    server.location = location
    server.seen = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def port(server):
    return server.server_address[1]


def service_file(url):
    return json.dumps({
        "id": "synthetic",
        "version": "0.0.0",
        "url": url,
        "pid": 1,
        "password": "synthetic-password",
    })


def run(tree, service, env_extra=None):
    """One run of the production program, spelled the way the application spells it."""
    state = os.path.join(tree, ".local", "state", "opencode")
    os.makedirs(state, exist_ok=True)
    path = os.path.join(state, "service.json")
    if service is None:
        if os.path.exists(path):
            os.remove(path)
    else:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(service)
    env = dict(os.environ, HOME=tree, USERPROFILE=tree)
    for key in PROXY_KEYS:
        env.pop(key, None)
    env.update(env_extra or {})
    done = subprocess.run(
        [sys.executable, "-c", PROGRAM], env=env, capture_output=True, text=True, timeout=30
    )
    return {"stdout": done.stdout.strip(), "stderr": done.stderr.strip(), "status": done.returncode}


report = {}
failures = []
servers = []


def check(name, ok, detail):
    report[name] = {"ok": bool(ok), "detail": detail}
    if not ok:
        failures.append(name)


def opened(reply, location=None):
    server = serve(reply, location)
    servers.append(server)
    return server


tree = tempfile.mkdtemp(prefix="verta-wsl-cred-")
try:
    # One: a service that answers the way it should. The request has to land there, carry the
    # password, and come back as the ids that are mid-turn. This case is also what says the
    # synthetic home was used at all: the real home's service file is not started by anything, so
    # a run that ignored HOME would print nothing here.
    good = opened((200, REPLY_OK))
    ran = run(tree, service_file("http://127.0.0.1:%d" % port(good)))
    check(
        "a real answer is read",
        ran["stdout"] == '["ses_running"]'
        and len(good.seen) == 1
        and good.seen[0]["path"] == "/api/session"
        and good.seen[0]["authorization"],
        {"run": ran, "requests": good.seen},
    )

    # Two: the service redirects to another port. The authorization header must not travel there.
    elsewhere = opened((200, REPLY_OK))
    redirecting = opened((302, ""), location="http://127.0.0.1:%d/api/session" % port(elsewhere))
    ran = run(tree, service_file("http://127.0.0.1:%d" % port(redirecting)))
    check(
        "a redirect is not followed",
        elsewhere.seen == [] and ran["stdout"] == "",
        {"stdout": ran["stdout"], "elsewhere": elsewhere.seen},
    )

    # Three: a URL that names another path on the same service. The password opens one endpoint,
    # so a file must not be able to widen that with a path of its own.
    bait = opened((200, REPLY_OK))
    ran = run(tree, service_file("http://127.0.0.1:%d/other" % port(bait)))
    check(
        "a URL naming another path is refused",
        bait.seen == [] and ran["stdout"] == "",
        {"stdout": ran["stdout"], "requests": bait.seen},
    )

    # Four: an answer that is not this endpoint's shape reads as "could not ask", not as an idle
    # service, which is the one answer the caller trusts enough to stop falling back.
    wrong = opened((200, REPLY_WRONG))
    ran = run(tree, service_file("http://127.0.0.1:%d" % port(wrong)))
    check(
        "an unreadable answer is not an idle answer",
        ran["stdout"] == "" and ran["stderr"] == "" and ran["status"] == 0,
        {"run": ran, "requests": wrong.seen},
    )

    # Five: a stamp that is not an integer is not a turn in flight either.
    strange = opened((200, REPLY_BAD_STAMP))
    ran = run(tree, service_file("http://127.0.0.1:%d" % port(strange)))
    check(
        "a stamp that is not an integer is not a running session",
        ran["stdout"] == "" and ran["status"] == 0,
        {"run": ran},
    )

    # Six: the service answered and nothing is running. That is an empty list.
    idle = opened((200, REPLY_IDLE))
    ran = run(tree, service_file("http://127.0.0.1:%d" % port(idle)))
    check("an idle service reads as an empty list", ran["stdout"] == "[]", {"run": ran})

    # Seven: no service file, and one past the size the read is bounded by. Neither is a question
    # that could be asked, and neither may reach the network.
    quiet = opened((200, REPLY_OK))
    missing = run(tree, None)
    oversized = run(tree, "x" * (64 * 1024 + 1))
    check(
        "a missing or oversized service file prints nothing and asks nothing",
        missing["stdout"] == "" and oversized["stdout"] == "" and quiet.seen == [],
        {"missing": missing["stdout"], "oversized": oversized["stdout"], "requests": quiet.seen},
    )

    # Eight: the distro's own proxy variables. ProxyHandler({}) means no proxies, and this is the
    # case a distro is likelier to bring than this machine: WSL distributions commonly export one
    # to reach the internet, and a proxy is exactly where the header would go next.
    good = opened((200, REPLY_OK))
    proxy = opened((200, REPLY_OK))
    ran = run(
        tree,
        service_file("http://127.0.0.1:%d" % port(good)),
        {key: "http://127.0.0.1:%d" % port(proxy) for key in PROXY_KEYS},
    )
    check(
        "the distro's own proxy variables do not carry the request",
        ran["stdout"] == '["ses_running"]' and proxy.seen == [],
        {"stdout": ran["stdout"], "proxy": proxy.seen},
    )
finally:
    for server in servers:
        try:
            server.shutdown()
        except Exception:
            pass
    shutil.rmtree(tree, ignore_errors=True)

host = os.uname().nodename
print(json.dumps({
    "python": sys.version.split()[0],
    "host": host,
    "tree": tree,
    "tree_removed": not os.path.exists(tree),
    "cases": report,
    "failures": failures,
}))
`;

const work = mkdtempSync(join(tmpdir(), "verta-wsl-in-distro-"));
writeFileSync(join(work, "service_turns.py"), program);
writeFileSync(join(work, "probe_harness.py"), HARNESS);

/** Windows path to the path the distro sees for it, the way `wsl_path` in wsl.rs does it. */
const insidePath = (windowsPath) => {
  const text = windowsPath.replace(/\\/g, "/");
  return `/mnt/${text[0].toLowerCase()}${text.slice(2)}`;
};

let failures = 0;
const report = {};
const check = (name, ok, detail) => {
  report[name] = { ok: Boolean(ok), ...detail };
  if (!ok) failures += 1;
};

try {
  // The transport: the application's own argv, which is the only place the multi-line program has to
  // survive being an argument. Its answer is whatever the distro's real service file says, and
  // nothing here writes to it.
  const transport = wsl(distro, ["--exec", "python3", "-c", program]);
  let answerIsShaped = transport.stdout.trim() === "";
  if (!answerIsShaped) {
    try {
      const parsed = JSON.parse(transport.stdout.trim());
      answerIsShaped = Array.isArray(parsed) && parsed.every((id) => typeof id === "string");
    } catch {
      answerIsShaped = false;
    }
  }
  check(
    "the program survives the trip and the distro's python accepts it",
    transport.status === 0 && transport.stderr.trim() === "" && answerIsShaped,
    {
      status: transport.status,
      stdout: transport.stdout.trim(),
      stderr: transport.stderr.trim().slice(0, 400),
      note: "an empty answer means this distro's own service is not listening; the file was only read",
    },
  );

  // The boundary, run by the distro's own python3 from the harness.
  const ran = wsl(distro, ["--exec", "python3", insidePath(join(work, "probe_harness.py"))]);
  let harness = null;
  try {
    harness = JSON.parse(ran.stdout.trim().split("\n").pop());
  } catch {
    harness = null;
  }
  if (harness === null) {
    console.error("the harness printed nothing readable:");
    console.error(`  status ${ran.status}\n  stdout ${ran.stdout.slice(0, 800)}\n  stderr ${ran.stderr.slice(0, 800)}`);
    process.exit(2);
  }
  for (const [name, result] of Object.entries(harness.cases)) {
    check(name, result.ok, { detail: result.detail });
  }

  // It said it removed its working directory; that is checked rather than believed.
  const left = wsl(distro, ["--exec", "test", "-e", harness.tree]);
  check(
    "the harness left nothing behind",
    harness.tree_removed === true && left.status !== 0,
    { reported: harness.tree_removed, path: harness.tree, testStatus: left.status },
  );

  report["where it ran"] = {
    ok: true,
    distro,
    python: harness.python,
    host: harness.host,
    program: fromRev === null ? `${READER} as it is in the tree` : `${READER} at ${fromRev}`,
  };
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 1));
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log(`the distro-side service read stays on ${distro}'s own loopback`);
