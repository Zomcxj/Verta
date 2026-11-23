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
- **The boundary is the webview, not a folder.** Rust owns every OS resource, and the frontend reaches
  it only through registered `invoke()` commands. What actually holds that line is the **Origin check
  on IPC**: measured, a page served over the asset protocol can see `window.__TAURI_INTERNALS__` and
  its call comes back `Origin header is not a valid URL`, while this app's own origin gets through.
  Keep that intact when touching `invoke` handling; the sandbox on the preview frame is not what does
  this job.
- **This application is authorized as *you*, not as *the folders you opened*.** That is the model, and
  it is worth reading twice before reporting something as a privilege escalation:
  - **The `WorkspaceRegistry` allow-list is a floor, not a wall around a project.** Its roots are the
    launch directory and the home directory (`bootstrap_registry`), plus any directory a terminal is
    started in (`authorize_user_spawn_cwd` registers what the user typed rather than refusing it).
    Since a path counts as inside when it starts with a root, everything under `C:\Users\<you>` -
    `.ssh`, `AppData`, browser profiles, every checkout - is inside. Measured.
  - **What the allow-list is for**: keeping a path from a script out of *the rest of the machine* -
    `E:\`, `H:\`, network shares, another user's profile. A stored XSS should not be able to walk the
    disks. It is not, and is not meant to be, a check that the user opened the folder in question.
  - **Agent sessions are read and deleted directly, with no allow-list at all.** Every session reader
    (`claude`, `opencode`, `pi`, `dsh`, `zcode`, `workbuddy`) opens its own store under the home
    directory itself. That is the product: Verta lists the sessions your agents already wrote and
    reopens them. Gating that on "a folder the user opened in the UI" would break the feature, so it
    is by design rather than an omission - do not "fix" it.
  - **A terminal may start anywhere you can reach.** `pty_open` registers its cwd instead of refusing
    it, because typing a path into a shell is the user granting it. That is also by design.
  - The consequence, stated plainly: if script executes in this webview, it reaches what your user
    account can reach, minus the rest of the machine. The mitigations that matter are therefore the
    ones that keep script out (Origin on IPC, no `'unsafe-inline'` in `script-src`, a CSP that cannot
    reach the network from the window - all verified on the packaged build), not a narrower file list.
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
- "A command read/wrote a path outside the folder I had open" on its own. Under this model the home
  directory is authorized from the start and a terminal registers its own cwd (see above); the
  finding that matters is a path *outside the user's home and outside every drive they opened*, or a
  way to reach one without the user asking.
- Content rendered from a repository you opened (a README's HTML, a previewed file) executing script in
  the app's own origin would be in scope; that it renders the file at all is not.
- Findings that require an attacker who already has code execution on the machine.
