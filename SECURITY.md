# Security

## Reporting a vulnerability

Open a private security advisory on this repository (Security → Advisories → New draft advisory)
rather than a public issue. Include what the flaw is, what it lets an attacker do, the version, and
the smallest reproduction you have.

Expect an answer within a week. This is a personal fork maintained in spare time, so a fix may take
longer than the reply; the advisory stays open until it ships.

## What this application is trusted with

Worth knowing before you report, because the boundary is deliberate:

- **It reads your agent sessions, your repositories and your files, and it can spawn processes.** That
  is the product. Anything that lets a *remote* party do those things is a vulnerability.
- **The webview is the trust boundary.** Rust owns every OS resource and the frontend reaches it only
  through registered `invoke()` commands. A command that skips the `WorkspaceRegistry` allow-list is a
  bug of the first order.
- **The PTY stream has its own gate.** The `verta-pty` URI scheme admits a request only from this
  app's own origin, with a per-webview token taken from OS entropy, a bounded body and a validated
  frame. A weakness there is reachable from any page the webview is persuaded to load.
- **No app-held GitHub token.** Everything goes through your own `gh` CLI login. A pasted PAT is
  written to gh's stdin and never stored.
- **The opencode service credential** (`service.json`) only ever reaches a validated loopback address
  and its one endpoint: the host comes from the parsed URL, `localhost` is normalized, and embedded
  credentials, other paths, proxies and redirects are refused.
- **Nothing is uploaded.** The usage window reads local files and writes nothing. There is no
  telemetry.

## Out of scope

- The application can run arbitrary commands because it is a terminal. A shell doing what you asked is
  not a vulnerability.
- Content rendered from a repository you opened (a README's HTML, a previewed file) executing script in
  the app's own origin would be in scope; that it renders the file at all is not.
- Findings that require an attacker who already has code execution on the machine.
