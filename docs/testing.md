# Testing

Three layers, and each one is for a different kind of doubt.

## The gates

Run all of these before claiming a change is done. On a machine short of memory, lower the
parallelism (`-j 2`, `--maxWorkers=2`) rather than skipping one.

```bash
pnpm check-types        # tsc --noEmit
pnpm lint               # biome lint ./src
pnpm test               # vitest
pnpm build              # vite build must pass

cd src-tauri
cargo clippy --all-targets -- -D warnings
cargo test --lib
```

Two rules about the gates themselves:

- **Do not run `cargo fmt` in `src-tauri`.** It reformats the whole workspace, including files the
  change never touched.
- **Do not run dev and clippy/test at the same time.** Cargo's build lock makes both sides wait.

## What the tests are for

This repository renders no components in its unit tests. That is deliberate: a test that mounts a
React tree here would mostly assert that React works, and it would need a DOM to do it. What is
tested instead:

- **Pure functions.** Day bucketing, model identity, folding, the chart's axis, path handling, pane
  geometry, the placement of a floating card, the plan for opening a session. This is where the
  coverage comes from, and it is why the code is written as a functional core with thin shells.
- **Text, for wiring.** A `*.wiring.test.ts` reads a component's source and asserts the shape that
  matters and cannot be seen any other way: that a card is drawn in both densities, that a slider
  writes on commit and not on mount, that the two surfaces draw the same block. It is a weak kind of
  test and it is used only where the alternative is no test at all.
- **Rust, for invariants.** Framing, queue accounting, the session readers against fixture files, the
  delete path's confirmation, the workspace allow-list. A change to a core subsystem (terminal spawn,
  workspace auth, git, fs, IPC, process spawn) needs a test that locks the invariant.

## Probes

`scripts/dev/probes/` holds 200+ probes: small Node scripts that drive the running application over
the Chrome DevTools Protocol and read the real DOM, the real pixels and the real numbers. They exist
because the questions that matter here are questions about a rendered window - does the chart scroll,
does the card follow the pointer, does the row still open a session with a card attached, does the
window's number match the command's answer - and none of those survive being mocked.

### One build at a time

The dev build and the installed build share one identifier (`app.verta`), and Tauri derives every
per-user path from it: the settings store, the window state, the logs, and above all WebView2's user
data directory (`%LOCALAPPDATA%\app.verta\EBWebView`). Two processes cannot open that directory at
once, so whichever starts second dies with `WebView2 error: WindowsError(HRESULT(0x8007139F))` - and
until it dies both write the same `verta-settings.json`. Close the installed app before starting
`pnpm tauri dev`; the error is not intermittent, it is what a second instance always gets.

Start the application with the debugging port, then run the probe:

```bash
cd "/c/Users/<you>/Desktop"
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 <path>/verta.exe &

node scripts/dev/probes/usage-window.mjs
node scripts/dev/probes/session-list-density.mjs --match=http://tauri.localhost/ --hover --manage
```

A few conventions that came from getting them wrong:

- **Name the window exactly.** The settings page and the usage page are served from the same origin as
  the main window, so `tauri.localhost/` matches all three and the first one the debugger lists wins.
  Measured: a run that thought it was reading a session list was reading the settings page.
- **Point at something that is on screen.** The list keeps its scroll position, so the first row in the
  DOM can be five thousand pixels above the viewport; a probe that points at its centre points at
  nothing and reports "no card". Pick the row whose centre `elementFromPoint` actually hits.
- **Hover with real pointer events.** A synthesized `pointerover` is not what a hover card listens for.
- **Read while the pointer is still there.** Moving it to evaluate is exactly what closes a hover
  surface.
- **A probe that found nothing has measured nothing.** Failing loudly on "no rows" is the difference
  between a probe and a rubber stamp.
- **A screenshot of the main window must have no usage window open.** The usage window dims the one
  behind it (`FloatingScrim`, driven by the `verta:usage-window` event), so a capture taken while it is
  up has a mask over it. `plugin:window|hide` does not lift that mask - only a `close` does, because
  the event is emitted from Rust's `CloseRequested` handler. Measured the hard way on the README's own
  screenshots.
- **A transparent window's screenshot keeps its alpha.** The app runs with vibrancy, so
  `Page.captureScreenshot` returns a semi-transparent PNG (measured: alpha about 107 on the main
  window, 193 on the usage window) that looks washed out on any light page. Flatten it onto the app's
  own dark base before committing it.
- **A window that is not in the foreground pauses its animations.** An unfocused window has
  `html[data-window-inactive]`, which pauses every CSS animation part way through its entrance and
  suspends the terminals; bring the window forward (`SetForegroundWindow`) before capturing.

## Known flakes

These fail occasionally under full-suite load and pass when run alone. Rerun before investigating:

- `src/modules/terminal/ghostty/gpu/terminalGeometry.test.ts`
- `src/modules/terminal/ghostty/AdaptedGhostty.test.ts` and `AdaptedGhosttyGpu.test.ts`
- `src/modules/theme/customThemes.test.ts`
- `src/modules/i18n/languageResolver.test.ts`
- the `pty::hub` drain test in Rust

## Acceptance on a real build

A dev instance is not the product. Before a round is called done:

1. `pnpm tauri build --bundles nsis` (about 18 minutes; the CLI rebuild changes the fingerprint, so
   the release side recompiles every time).
2. Install it, or run `target/release/verta.exe` directly.
3. Run the probes against the installed build, not against `pnpm dev`.
4. Put the settings back the way they were found. A probe that leaves the user's preferences changed
   has broken the thing it was measuring.
