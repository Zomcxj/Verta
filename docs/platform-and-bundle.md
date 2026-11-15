# Platform and bundle

What a window is allowed to call, what has to stay platform-specific, and what the installer
carries.

## Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

A plugin whose work is a Rust hook rather than an IPC command needs no entry from that list: window-state restores and saves from `lib.rs`'s plugin hooks, and the webview never calls it (its commands are unreachable, which is fine and deliberate). The list also names the window the permission applies to, which is what the frontend's own `close`/`destroy` calls on both `main` and `settings` rely on.

## Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

## Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 13.0`.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `downloadBootstrapper`. Installing a missing WebView2 runtime requires internet access; there is no bundled offline runtime. Packaged and offline-install validation remains in the release-readiness gates.
- Auto-updater: **not configured yet**. Publishing needs a signing key of this project's own, with `pubkey` and `endpoints` written back into `tauri.conf.json` and `createUpdaterArtifacts` turned on again.
- `bundle.resources` includes the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`. Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.
