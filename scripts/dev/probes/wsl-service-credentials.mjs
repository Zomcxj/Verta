// The opencode service read inside a distro hands out the service's own password, so its request
// has to stay on that distro's loopback interface: no proxy, no redirect, and no URL whose text
// starts with a loopback address while it resolves somewhere else.
//
// The reader for a distro is a Python program, so this probe runs that program rather than reading
// it. The script is taken out of the Rust source (that is the transport, not the assertion), handed
// a synthetic `service.json` in a temporary home, and watched from two throwaway loopback servers:
// one is the service, the other is where a redirect would send the request. What the script prints
// and which of the two servers was contacted is the measurement.
//
// The child is spawned asynchronously on purpose: a synchronous spawn blocks this process's event
// loop, so the servers below cannot answer and every case would time out instead of measuring.
//
// This machine's python is the point of this file: the boundary rules can be driven here cheaply.
// The same program under a distro's own python, through the application's own `wsl.exe` invocation,
// is `wsl-service-credentials-in-distro.mjs`.
//
// Usage:
//   node scripts/dev/probes/wsl-service-credentials.mjs
//   node scripts/dev/probes/wsl-service-credentials.mjs --python=python
//
// Exits 1 when the boundary leaks: a redirect reaches the second server, a URL that only looks
// loopback is contacted, or an unreadable answer is printed as an empty list. Nothing here touches
// the real service file or starts a real service.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

// `python3` on this machine is the Windows Store placeholder, which exits without printing
// anything, so a probe would report a leak-free run for a script that never ran. The interpreter is
// chosen by asking it, and the run aborts when none of them answers.
function resolvePython() {
  const asked = arg("python");
  const candidates = asked === null ? ["python3", "python"] : [asked];
  for (const candidate of candidates) {
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) {
      return candidate;
    }
  }
  console.error(`no working interpreter among: ${candidates.join(", ")}`);
  process.exit(1);
}

const python = resolvePython();
const source = readFileSync("src-tauri/src/modules/agent_sessions/wsl.rs", "utf8");
const blocks = [...source.matchAll(/r#"([\s\S]*?)"#/g)]
  .map((match) => match[1])
  .filter((text) => text.includes("/api/session"));
if (blocks.length !== 1) {
  console.error(`expected exactly one script carrying /api/session, found ${blocks.length}`);
  process.exit(1);
}
const script = blocks[0];

const work = mkdtempSync(join(tmpdir(), "verta-wsl-service-"));
const stateDir = join(work, ".local", "state", "opencode");
mkdirSync(stateDir, { recursive: true });
const scriptPath = join(work, "service_turns.py");
writeFileSync(scriptPath, script);

/** A loopback server that answers every request and records what it saw. */
function serve(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((request, response) => {
      seen.push({
        path: request.url,
        authorization: request.headers.authorization !== undefined,
      });
      handler(request, response);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const json = (response, body, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
};

/** One run of the production script against one synthetic service file. */
function run(url) {
  writeFileSync(
    join(stateDir, "service.json"),
    JSON.stringify({ id: "synthetic", version: "0.0.0", url, pid: 1, password: "synthetic-password" }),
  );
  return new Promise((resolve) => {
    const child = spawn(python, [scriptPath], {
      env: { ...process.env, HOME: work, USERPROFILE: work },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), status });
    });
  });
}

const report = {};
let failures = 0;
const check = (name, ok, detail) => {
  report[name] = { ok, ...detail };
  if (!ok) failures += 1;
};

try {
  // One: a service that answers the way it should. The request must land there, and the ids must
  // come back.
  const good = await serve((_request, response) =>
    json(response, '{"data":[{"id":"ses_running","time":{"busy":200,"idle":100}}]}'),
  );
  const legit = await run(`http://127.0.0.1:${good.port}`);
  await good.close();
  check(
    "a real answer is read",
    legit.stdout === '["ses_running"]' &&
      good.seen.length === 1 &&
      good.seen[0].path === "/api/session" &&
      good.seen[0].authorization,
    { stdout: legit.stdout, stderr: legit.stderr, status: legit.status, requests: good.seen },
  );

  // Two: the service redirects to another port. The authorization header must not travel there.
  const elsewhere = await serve((_request, response) =>
    json(response, '{"data":[{"id":"ses_redirected","time":{"busy":200,"idle":100}}]}'),
  );
  const redirecting = await serve((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/api/session` });
    response.end();
  });
  const redirected = await run(`http://127.0.0.1:${redirecting.port}`);
  await redirecting.close();
  await elsewhere.close();
  check(
    "a redirect is not followed",
    elsewhere.seen.length === 0 && redirected.stdout === "",
    { stdout: redirected.stdout, redirectedRequests: elsewhere.seen },
  );

  // Three: a URL that names another path on the same service. The password must only ever be sent
  // to the one endpoint this code reads, so a file cannot widen that with a path of its own.
  //
  // Not covered here: embedded credentials. Python's own URL handling already refuses those (the
  // host it parses is `127.0.0.1:port@127.0.0.1`), so the rule in the script is belt and braces
  // rather than a leak this probe can show.
  const bait = await serve((_request, response) =>
    json(response, '{"data":[{"id":"ses_bait","time":{"busy":200,"idle":100}}]}'),
  );
  const otherPath = await run(`http://127.0.0.1:${bait.port}/other`);
  await bait.close();
  check(
    "a URL naming another path is refused",
    bait.seen.length === 0 && otherPath.stdout === "",
    { stdout: otherPath.stdout, requests: bait.seen },
  );

  // Four: an answer that is not the shape this endpoint returns. An unreadable answer must read as
  // "could not ask" (no output, and no traceback either) rather than as an empty list, which would
  // unmark every row.
  const wrong = await serve((_request, response) => json(response, '{"data":"nope"}'));
  const malformed = await run(`http://127.0.0.1:${wrong.port}`);
  await wrong.close();
  check(
    "an unreadable answer is not an idle answer",
    malformed.stdout === "" && malformed.stderr === "" && malformed.status === 0,
    { stdout: malformed.stdout, stderr: malformed.stderr, status: malformed.status, requests: wrong.seen },
  );

  // Five: the service answered and nothing is running. That is an empty list, and the caller keeps
  // trusting it.
  const idle = await serve((_request, response) =>
    json(response, '{"data":[{"id":"ses_done","time":{"busy":1,"idle":2}}]}'),
  );
  const idleRun = await run(`http://127.0.0.1:${idle.port}`);
  await idle.close();
  check("an idle service reads as an empty list", idleRun.stdout === "[]", { stdout: idleRun.stdout });

  // Six: no service file at all. The question could not be asked, and nothing is printed.
  rmSync(join(stateDir, "service.json"), { force: true });
  const missing = await new Promise((resolve) => {
    const child = spawn(python, [scriptPath], {
      env: { ...process.env, HOME: work, USERPROFILE: work },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("close", () => resolve(stdout.trim()));
  });
  check("a missing service file prints nothing", missing === "", { stdout: missing });
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 1));
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("the distro-side service read stays on loopback");