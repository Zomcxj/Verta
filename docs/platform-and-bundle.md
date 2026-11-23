# Platform and bundle

What a window is allowed to call, what has to stay platform-specific, and what the installer
carries.

## Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

A plugin whose work is a Rust hook rather than an IPC command needs no entry from that list: window-state restores and saves from `lib.rs`'s plugin hooks, and the webview never calls it (its commands are unreachable, which is fine and deliberate). The list also names the window the permission applies to, which is what the frontend's own `close`/`destroy` calls on both `main` and `settings` rely on.

## The boundary, in one place

The app is authorized **as the user**, not as a set of folders. Everything below follows from that,
and each line says how far it reaches - measured, because "there is a boundary" and "the boundary is
where you think it is" are different claims.

- **IPC is the real boundary**: a call arrives from this app's own origin or it does not. Measured, a
  page over the asset protocol sees `window.__TAURI_INTERNALS__` and gets
  `Origin header is not a valid URL` back. The preview frame's sandbox is not what enforces this.
- **`WorkspaceRegistry` is a floor against the rest of the machine**, not a wall around a project.
  Roots are the launch directory, the home directory (`bootstrap_registry`) and any cwd a terminal
  was started in (`authorize_user_spawn_cwd` registers rather than refuses); a path is inside when it
  starts with a root, so all of `C:\Users\<you>` is inside. Measured: `E:\`, `H:\`,
  `projects_scan("C:\")` and `workspace_authorize("C:\")` are all refused; a folder under the home
  directory answers.
- **Agent sessions do not go through the allow-list at all.** Each reader opens its own store under
  the home directory; deleting a session is a direct remove. That is the product and must not be
  gated on the UI's current folder.
- `workspace_authorize` refuses a volume root: more can become reachable, but a whole drive cannot.
- `lsp` spawns only a bare program name; a path in a custom server's `command` is refused, because the
  settings file is writable by anything running as this user.
- The CSP in `tauri.conf.json` has no bare scheme in `connect-src` or `script-src`, so script in the
  webview has no route off the machine. **It is applied by the bundle, not by `pnpm tauri dev`** - a
  dev window has no CSP, where the same `fetch` succeeds. Measure it on `target/release/verta.exe`;
  verified there: `https://example.com` and a bare IP refused, `tauri.localhost` and IPC allowed,
  `<img>` / `<iframe>` over the asset protocol clean.

## Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

## Bundle config

- **Windows only, and by decision rather than by accident.** `bundle.targets` is `["nsis"]` and the
  `macOS` / `linux` sections are gone from `tauri.conf.json`: 1.0.0 is published for Windows 10/11 and
  nothing else, so a bundle for another platform would be a claim nobody tested. The code still
  builds there (the `#[cfg(target_os)]` arms are kept, and `cargo check` covers them), which is what
  a later port would start from - but the installer is the only artifact this release produces.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `downloadBootstrapper`. Installing a missing WebView2 runtime requires internet access; there is no bundled offline runtime. Packaged and offline-install validation remains in the release-readiness gates.
- Auto-updater: **not configured yet**. Publishing needs a signing key of this project's own, with `pubkey` and `endpoints` written back into `tauri.conf.json` and `createUpdaterArtifacts` turned on again.
- `bundle.resources` includes the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`. Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.

## Releasing

1. **Make sure `main` is green and merged.** `ci.yml` runs the five gates on every push to `main` and
   on every pull request; a release is a claim about a specific commit, so it starts from one that
   passed them.
2. **Tag the release commit.** `git tag -a v1.0.0 -m "..." && git push origin v1.0.0`. The `v` prefix is
   what `build.yml` matches (`tags: ['v*']`); without it the workflow will not fire.
3. **The workflow does the rest.** `build.yml` checks out the tag, runs the same five gates again
   (`ci.yml` watches branches, not tags, so the tag itself would otherwise run nothing), checks that
   the tag matches `tauri.conf.json`'s version, builds the NSIS installer, and uploads it to a
   **draft** Release for the tag. Watch it in Actions; a red gate step stops the build and nothing is
   uploaded.
4. **Review the draft, then publish it.** The body is written in the workflow itself, so a diff of
   `build.yml` is a diff of the notes. A draft is editable and deletable; a published release is not,
   which is why the workflow stops at draft.
5. **No secrets are needed.** The installer is not signed (`bundle.windows.signingIdentity` is unset)
   and the updater is off (`createUpdaterArtifacts: false`), so there is no key to protect. The
   consequence is SmartScreen showing "unknown publisher" on first run.

## Release notes

The body is written **inside `build.yml`**, in a `release notes` step that `printf`s it to
`release-notes.md` for the upload step to read. There is no file per version, and that is deliberate: a
version's notes are read once, by someone deciding whether to take the update, while the previous
versions are already in git - `git show v1.0.0:.github/workflows/build.yml` holds the 1.0.0 body. A
directory of notes files would grow forever without recording a fact the history does not already have.

Editing the body is therefore part of bumping the version: change the version in the three manifests,
rewrite the `printf` block, tag, push. The `tag matches the manifest` step fails the run before the
build if the tag and `tauri.conf.json` disagree.

The body is Chinese, in the shape `Zomcxj/LabelForge` uses. The first line is the headline:

```
Verta v1.0.0 - 一句话说明这一版是什么
```

Then the changes, grouped by kind, with `• 分类：描述` per line and no nested bullets:

- **`✨ 新增`** - a capability that did not exist before.
- **`🔧 修复`** - something that was wrong and is now right. Name what was broken, not the file.
- **`🗑 移除`** - something that is gone. Say what replaces it, or why nothing does.

**A first release lists what the product does** rather than what changed, since nothing came before it.
It uses feature sections instead of the three change kinds (the feature sections are named in Chinese, e.g. `✨ 核心功能` / `🖥 终端` / `🌿 Git`), and
the sections follow the product's own surfaces, not the source layout.

What the body does not carry: install steps, checksum instructions, platform requirements, or a list of
what the release does not do. Those belong in the README, the release assets speak for themselves, and
a release page that repeats them goes stale between versions. One exception is allowed on the first
release of a major version, where a reader may genuinely not know the platform - keep it to a line.

Written from the reader's side: a line says what changed for someone using the app, not which module
was touched. `CHANGES.md` is the other record - every difference from upstream, for license
compliance - and the two are not the same document. A change can need a line in both, in different
words.
