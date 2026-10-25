# VERTA.md

Verta loads `VERTA.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md). This file is also the project's living architecture doc - read it before making changes.

## Project

**Verta**: Windows-first desktop workbench for the coding-agent sessions already on this machine. Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + libghostty-vt WASM client (WebGPU, Verta WebGL fallback). The upstream AI assistant is not part of this fork (see `CHANGES.md`).

- Bundle id: `app.verta`
- Package manager: **pnpm**
- Platforms: Windows is the target; the upstream macOS and Linux paths remain in the tree
- Frontend checks: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo test --lib`

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests, whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, process spawn). File, git and spawn paths go through the `WorkspaceRegistry` allow-list.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core); tauri commands and React components stay thin (imperative shell). Keeps it testable without a later rewrite.

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`, `cd src-tauri && cargo test --lib`

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or process spawn) needs a test that locks the invariant.

## Terminal migration status

libghostty-vt is the only terminal model. WebGPU is the default renderer and
Verta WebGL is the compatibility fallback. Each leaf owns one persistent model
in its own WebAssembly instance (the module is compiled once and shared), so
closing a leaf drops its linear memory and scrollback instead of leaving a
high-water mark; nothing may retain a view into a disposed model's memory.
Scrollback summed over all leaves is capped by a budget (192 MiB, scaled fairly
between leaves, never pruning history already held). Presentation resources are
shared, bounded, and released for hidden leaves.
All visible WebGPU panes of a window draw into one canvas that covers the
terminal area (`gpu/WebGpuWindowCanvas.ts`; the `[data-terminal-area]` layer of
`TerminalStack`, behind the tab layers). Each pane renders into its device-pixel
snapped rectangle (`gpu/PaneRects.ts`, measured on layout changes only) with
`setViewport` and `setScissorRect`, which keeps glyph overhang out of the
neighbour; the shader takes viewport size and origin from the uniform, so a
pane's pixels equal what a canvas of its own showed (verified byte for byte,
`scripts/terminal-visual/grid.html`). Canvas textures are not preserved between
frames, so a window frame clears the canvas and encodes every visible pane in one
pass (cell buffers stay resident on the GPU, no per-cell work). Per-pane dirty
tracking still decides whether a frame is needed: an unchanged window acquires
no texture (`windowFrameNeeded`). `SurfaceFramePacer` decides which panes prepare
in a frame; a pane whose rectangle moved always does. Pane DOM is transparent
once the canvas has shown the pane's first frame (until then it paints the theme
colour, so a tab switch never flashes the card behind); scrollbars, selection,
IME, block overlays and cursor styles stay per-pane DOM above the canvas.
A presented WebGPU canvas is never destroyed, unconfigured, shrunk or
dropped while the runtime lives: WebKit (macOS 26) keeps the swapchain of such a
canvas in the WebContent process for good (three buffers, about 30 MiB for a
2000x1300 canvas, whatever the teardown order and garbage collection), and keeps
every swapchain a resizing canvas retires until JavaScriptCore collects its
wrappers (minutes), so every teardown or resize leaks. A tab switch, a split or a
divider drag therefore only changes viewports: zero canvas allocations. The
canvas is reallocated only when the terminal area itself changes size, at most
twice per window drag (below). With no visible pane (an editor tab is active) or
an occluded window it is paused (hidden after a short delay when empty), never released. A replaced or
recovered GPU device reconfigures the same element, and a remounted area takes
over the old one's canvas. Only disposing the runtime tears it down. The WebGL
fallback stays per pane (its own canvas inside the pane root, with a premultiplied
alpha context and premultiplied shader output, so a translucent theme's terminal
background lets the pane behind it (and the desktop) show through exactly as it
does on the WebGPU path): a WebGPU failure in one pane falls that pane back, and a
failure of the shared runtime falls every pane back.
Every submitted window frame is mirrored to JavaScriptCore (`gpu/GcPressure.ts`):
the wrappers of a frame (texture, view, encoder, pass, command buffer) pin about
13 KiB of WebKit malloc that JavaScriptCore does not count, so without help it
collects them after minutes (20 MiB a minute for a streaming agent). Allocating and
dropping a 126 KiB `ArrayBuffer` per frame (ten times the native cost; measured:
unfinalized canvas textures after 120 s 2,626 without, 195 with it, no change in
instructions per second) makes young-generation collections run steadily. At most
4 MiB a second is mirrored, so display-rate frames allocate no more than a 25 fps agent.
Resizing applies one synchronized model + PTY resize per gesture. Every SIGWINCH
makes zsh/fish and Ink-based agents redraw, and redraws that do not line up with a
reflowed grid leave duplicates in scrollback, so during a resize gesture (native
macOS live resize via `NSWindowWillStart/DidEndLiveResize`, forwarded as
`liveResize` in `verta:window-presentation`; a pane divider drag via
`terminalResizeInteraction`; elsewhere a burst of size changes less than 150 ms
apart, `lib/terminalResizeGesture.ts`) neither the model nor the PTY changes. The
pane follows the pointer at display rate (`SurfaceFramePacer` gesture mode) and
draws its existing grid: shifted up (`shift_y`) so the cursor row stays visible
when the pane is shorter, clipped on the right or padded with the background
otherwise. At release `TerminalResizeSync` resizes the model and tells the PTY in
one call, model first. Ghostty clears the prompt on that resize and relies on the
shell's redraw, so the pane holds its previous frame until the redraw ends or
70 ms pass (`core/ResizePromptHold.ts`; only at an OSC 133 prompt, never in the
alternate screen). Resizes outside a gesture (sidebar, font, ratio, first fit,
showing a hidden pane) apply at once. During a gesture the window canvas's backing
store is grow-only: it keeps its allocation while the area shrinks and, when the
area outgrows it, allocates once to the largest size it can reach
(`gpu/GestureBacking.ts`: the area plus the screen room left when the window
itself is dragged, else the window; capped by the device limit), then compacts at
release, so a drag costs at most one growth and one compaction. The WebGL
fallback defers the same way per pane (top-anchored).

The WebGPU path (renderer v2, `src/modules/terminal/ghostty/gpu/`) runs
no per-cell JavaScript. Ghostty encodes 16-byte cell records natively and
reports only rows whose bytes changed. The surface uploads those ranges straight
from WASM memory (`consumeGpuFrame`) into a storage buffer, and nothing may call
the model between that frame and the upload because the view is borrowed. It
never touches the structure-of-arrays APIs, which would flip the model's format;
only the WebGL fallback uses them. A background pass derives each cell from its
pixel (background, search, selection, cursor, decorations) and an instanced
glyph pass draws integer-pixel quads with unfiltered `textureLoad`. Selection and
cursor are uniforms and the search highlight is a mask buffer that exists only
while something is highlighted, so none of them rewrites cell records.
Geometry is pixel exact. Fonts are measured at size times ratio and cells are
whole device pixels (`TerminalFontMetrics.deviceCell*`). `cellWidth` and
`cellHeight` are the CSS size, device divided by ratio, and are what fit,
hit-testing, selection, links and block overlays use. A pane's rectangle in the
window canvas holds at least cols by rows device cells (slack is background, the
scissor clips the rest) and the canvas origin is translated onto the device
pixel grid when the observer, ratio or window size changes. A ratio change
re-measures the font and rebuilds atlas and buffers.
Each terminal maps Ghostty glyph ids to a glyph atlas shared per font and ratio.
The atlas grows (coverage 1024 to 2048 to 4096, colour 512 to 2048) before it
flushes into a new epoch; after a flush each surface rescans its visible cells and
re-rasterizes only what it shows. Rasterization is limited to about two
milliseconds per frame across surfaces, leftover glyphs draw on follow-up frames,
and a backlog from scrolled-away output keeps only visible glyphs queued.
Grayscale text gets a DirectWrite-style contrast curve when the ratio is below 2
or on Windows and Linux (`localStorage["verta:terminal-text-contrast"]` is
`off`, `on` or a strength); macOS Retina is unchanged.
Box drawing, block elements, braille, powerline separators and common legacy
computing shapes are drawn procedurally at exactly the cell size, not from the
font, with Ghostty's sprite geometry (`gpu/BuiltinGlyphs.ts`, pure, shared by
the WebGPU and WebGL atlases), so borders and bars join seamlessly at every size
and ratio. They ignore bold and italic and skip the text contrast curve.
Native cell, grapheme and hyperlink presentation buffers allocate on first use
and return to the WASM allocator when a pane is hidden. Hidden parsing does not
rebuild them. Window pauses (occlusion, sleep) retain them and the uploaded cell
data.
Unchanged frames do not acquire presentation textures or draw; cursor-only
updates upload only the uniform. WebGL background and decoration geometry uses
row range uploads while rectangle counts are stable; structural changes rebuild
the compact stream. Scrollbar synchronization never reads the DOM on presented
frames; moving the thumb under a bottom-pinned view costs at most ten position
writes and four ARIA updates a second. Blink timers stop in unfocused windows,
and native cursor hiding stops cursor timers. Selection is a uniform and needs no
row damage; streaming search invalidations coalesce instead of rebuilding per
output chunk.
WebGL surface and renderer code load only when selected, needed for fallback,
or explicitly requested by diagnostics. Delayed imports cannot install into a
closed, restarted, or replaced session.
xterm, its addons, CSS, snapshots, session pool, and dormant byte ring are removed.
Unsupported graphics produce a visible error with retry instead of changing models.

Command blocks use parser-time Ghostty tracked pins, including endpoint columns,
so command ranges survive reflow and exclude following prompts and commands.
The native marker ring is capped at 2,048 pins; JavaScript history is capped at
1,000 blocks and 512 KiB of estimated UTF-16 command/cwd text. Block implementation
and UI load only for block sessions, and hidden/occluded block presentation stops.
Block search yields after 128 rows or four milliseconds, retains at most 500
matches, and cancels obsolete queries. Block copy, search, sticky headers, navigation, rerun, shared shell input,
and selection all use the same persistent Ghostty model.
Block chrome commits with its matching renderer frame; it is recomputed only when
the viewport origin, scrollback, size, cell height, block mode or block set
(`GhosttyBlocks.revision`) changed, so frames that only repaint cells cost no
block work and no React commit. The per-frame path reads cached cell metrics, never
layout, and the shell/prompt input switch runs on block-mode changes, not per PTY
chunk. Command-editor focus does
not lower active-pane cadence. Divider padding is presentation-only and does not
change copied command boundaries. Scrollbars preserve native fractional positions
and ignore delayed programmatic scroll events. Hidden output does no surface DOM
or search-mask work until presentation resumes.

Terminal clipboard shortcuts use the native text clipboard plugin on all desktop
platforms. Context clicks expose the selected text through the input element to
restore the webview's native text menu; no persistent DOM scrollback is maintained.
On macOS the input `<textarea>` always holds one selected placeholder character
(`TerminalInputProxy`; elsewhere it stays empty, a selection could take X11 PRIMARY): a focused editable with a collapsed selection keeps
WebKit's caret animation (a display link at display rate) running at ~3 % CPU and
~250 wakeups/s while idle, a non-collapsed selection paints no caret (0.2 %, ~10/s).
It re-arms after input, key release and focus, never during IME composition, and
native Copy/Cut without terminal text must not copy the placeholder.
Unclaimed macOS Command shortcuts reach the native menu after explicit clipboard,
block-editor, and readline bindings, including when Kitty keyboard mode is active.
The block prompt retains an enabled terminal input proxy for native menus and
routes editing keys, composed text and paste back to its command editor.
Character drags retain a native selection pin from pointerdown, including before
the first pointermove. Unmoved clicks and lost captures discard provisional pins.
Key encoding supplies the base character required by Kitty keyboard mode; plain
keys and key releases also use Ghostty encoding when the application requests it.
Terminal text and the editor share one font setting (`terminalFontFamily`, default
`Cascadia Code`); it is stored under its old key so nobody's config has to move.
The terminal's stack is the chosen font, then the detected Nerd Font for icon
glyphs, then bundled JetBrains Mono - the icon font is never a separate setting
because the glyphs that draw prompt icons are rarely in the font you want to read
a shell in. The dropdown offers only families the machine actually has, listed by
the `fonts_list` command (GDI on Windows, `fc-list`, `system_profiler`); an empty
value means auto-detect, and a stored family that is not installed is still
shown, marked as missing. Private-use prompt symbols require a font that supplies
them; Verta does not ship a separate symbol font. Native color
emoji remain on the system fallback path. Rerun requires the complete command
submitted through Verta; truncated shell labels are never executed.
Primary-screen full erase, scrollback erase, and terminal reset invalidate block
pins at parse time and clear block chrome, selection, and search. Commands after
an erase in the same output chunk retain their new pins. Alternate-screen erases
preserve primary block history. Block scrollbar status dots are removed along
with their timers and history scans.

The shared command bar activates after shell integration confirms prompt input.
Bare shells keep direct terminal input. Bash before 4.4 reports
`OSC 133;B;terax_blocks=0` and keeps its native prompt because it lacks PS0.

Settings offer Automatic or WebGL for new terminals, plus opt-in screen reader
output. Accessible text is limited to 256 rows / 64 KiB and refreshes at most four
times per second while visible. Ordinary URL detection runs on pointer demand;
OSC 8 links take precedence. OSC 52 side effects retain one in-flight write and
only the latest pending value across the window.

The adapted Ghostty revision is pinned in `packages/ghostty-core/adapted/UPSTREAM.md`.
Both SIMD and scalar artifacts are shipped; the loader fetches only the variant
the webview supports. Scalar validation explicitly disables SIMD instructions
and types. This avoids changing OS minimums solely for the WASM SIMD requirement;
actual older WKWebView and WebKitGTK compatibility still needs platform tests.

PTY output is one multiplexed pull stream per window (`src-tauri/src/modules/pty/` plus `src/modules/terminal/lib/pty-bridge.ts`),
not a channel per terminal. The async `verta-pty` URI scheme (`pty/protocol.rs`) has two POST
endpoints: `poll`, kept outstanding exactly once per webview, and `ack`. One process-wide hub
thread (`pty/hub.rs`, scheduler in plain data driven by explicit time) holds the poll's responder
and answers with framed binary data (`pty/wire.rs`: `[u32 id][u8 kind][u32 len]`, kinds data, exit,
failed, sync; data frames carry their stream offset; responses are capped at 1 MiB) for every
terminal whose coalescing deadline is due. A terminal's presentation class picks its deadline:
focused 4 ms (16 ms sustained), visible 16 ms, hidden 100 ms, window occluded or asleep 250 ms;
256 KiB pending is always due, and terminals due within 4 ms ride in the same response (one
terminal contributes at most 512 KiB per response, so floods pipeline and share). The
frontend reports classes only on change (`pty_set_presentation`, from `lib/ptyPresentation.ts`);
each report carries a growing sequence number and a terminal keeps the newest one that named it,
because async commands can be applied out of order. macOS occlusion and sleep reach the hub natively
from `window_presentation.rs`. The stream token from `pty_stream_open` is the credential: any frame
can reach the scheme but only the page can invoke, so every request is admitted (`pty/gate.rs`) on
the handler's thread before it may wake the hub: the `Origin` must be the app's own
(`tauri://localhost`, `http(s)://tauri.localhost` on Windows, the dev server in dev builds; a request
without `Origin` is token-only), the body at most 3084 bytes (413) and well framed (400), and the
token the live one for the requesting webview (403; the hub publishes label to token, compared in
constant time). Responses echo the allowed origin with `Vary: Origin`, never `*`. Tokens come from OS
entropy only: if it fails, `pty_stream_open` fails instead of falling back to the clock. A terminal's
output is held until its receiver announces itself, and reload or window
destruction drops the held responder, kills the token and detaches that window's terminals.
Frontend `PtyOutputHub` owns the loop: it re-polls on a response before parsing and demultiplexes
to the `PtyOutputReceiver`s, whose cumulative parsed offsets ride on the next poll. An ack-only
request goes out only for new receivers, for more than 512 KiB of unsent progress, or when native
sends `sync` because it waits on that terminal (credit blocked or exiting).

Receivers parse in at most 32 KiB slices with a four-millisecond work budget on a shared FIFO
MessageChannel task queue, which closes its ports when idle. Only fully parsed original chunks
earn credit. Credit is bytes: at most 1 MiB in flight (128 chunks) and 2 MiB pending plus in
flight per terminal. Acknowledgments are cumulative offsets validated against delivered chunk
boundaries, so duplicates and retries cannot grant credit; a bad boundary or stream gap fails only
that terminal visibly. Parser failures stop delivery without acknowledging unconsumed bytes.
Transport failures retry with capped backoff and surface as one stalled/failed toast per
terminal. Exit waits for the reader drain and the final acknowledgments; the `exit` frame always
follows that terminal's last data frame. Unix readers sleep on PTY readiness plus an explicit
shutdown signal without a polling timer. After shell exit they consume ready output, bounded to
2 MiB / 30 seconds, rather than wait indefinitely for an inherited slave descriptor to close.
Exceeding this drain bound reports a reader failure and exit status -1. After shell exit,
30 seconds without acknowledgment progress closes a stalled queue with a logged delivery failure
and exit status -1. The deadline is armed before ConPTY close and thread joins; it does not run
during live-shell backpressure. Close wakes blocked queue workers and the Unix reader; Windows
keeps draining the pipe while ConPTY closes. Per-read costs stay low: the agent and DA filters
scan with `memchr` and copy runs, the reader checks an atomic `closed` flag and reuses its
buffers, input goes through one bounded queue to a per-session writer thread, worker threads use
128-256 KiB stacks, and `pty_has_foreground_process` lists children with `proc_listchildpids` or
`/proc/<pid>/task/*/children` instead of forking `pgrep`.

Enable release diagnostics with `localStorage.setItem("verta:terminal-diagnostics", "1")`
and reload. `window.__vertaTerm()` reads frontend counters;
`await window.__vertaTermSnapshot()` adds native queue counters and explicitly
labeled host RSS. Host RSS
excludes WebContent and GPU processes and is not total application memory.

Ghostty presentation uses shared native macOS occlusion/sleep and DOM visibility
tracking. Every renderer pauses immediately. The WebGPU renderer does nothing
more: frames and timers stop, while the window canvas (configured, at full size), cell
buffers, glyph maps and atlas textures stay resident, so coming back from a
Space switch, minimize or sleep costs one redraw and no allocation. Releasing
them is worse than keeping them (see the window canvas above). The WebGL fallback
still reclaims its renderer after two seconds of continuous occlusion, and at
once on sleep, because its dropped canvases are garbage collected (measured:
transient, no growth). Hidden tabs release their buffers and atlas lease immediately and
leave the window canvas (its size is kept). Per-pane pacing prevents focused output from
raising background pane cadence. Panes that are neither focused nor being
interacted with snap to one shared tick (30 Hz, 15 Hz in an unfocused window):
a pane that turns dirty waits for the end of its tick and presents with every
other pane of that tick in one encoder, submission and commit, at most once per
tick. The planner asks for an animation frame only for the vsync that can serve
the next deadline (the refresh interval and phase are learned from callback
timestamps), sleeping on a timer otherwise, so a 120 Hz display does not pay a
callback per vsync. A timer sleeping for a later tick is re-planned when a pane
that is due sooner turns dirty, so the focused pane never waits behind it.
WebGPU permits at most two outstanding frame submissions and keeps one
`onSubmittedWorkDone` wait outstanding at a time: frames submitted while it is
pending ride the next wait, which starts when it resolves (waiting only every
second frame was tried and cut a 32 Hz producer to 23 presented frames a second).
User wheel, drag, and keyboard interaction gives only its pane 150 ms of focused
cadence, including in an unfocused visible window. It starts no idle timer or
frame loop.
`window.__vertaTermTrace()` explicitly starts a bounded ten-minute resource trace;
it is never started automatically. `pnpm bench:ghostty` runs the terminal model benchmarks without launching the application, and `pnpm profile:app` drives the real application through the app lab under `scripts/app-lab/`.

The release gates are the checks listed in `README.md`, plus the budgets that
`src/app/eager-budget.test.ts`, `src/app/dist-budget.test.ts` and
`src/styles/compositingBudget.test.ts` lock. Automated checks alone do not
establish production readiness, platform parity, or multi-day resource stability.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on *why*, never *what*, and always in English: the code is read by the upstream and by outside readers, while only interface text is Chinese. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.

## Architecture

### Two-process model

**Rust (`src-tauri/`)** owns all OS access. The webview never touches the FS, processes, or shells directly - everything goes through `invoke()` calls to commands registered in `src-tauri/src/lib.rs`:

- `pty::pty_*` - long-lived interactive PTY sessions (portable-pty ↔ Ghostty), managed by `PtyState` (`RwLock<HashMap<id, Session>>`). Output streams over the `verta-pty` multiplexed pull stream (hub thread, `pty_stream_open`, `pty_set_presentation`); input goes through a per-session writer thread.
- `fs::tree::*` (`fs_read_dir`, `list_subdirs`), `fs::file::*` (`fs_read_file`, `fs_write_file`, `fs_stat`, `fs_canonicalize`), `fs::mutate::*` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_move`, `fs_delete`, `fs_delete_batch`), `fs::copy::fs_copy`, `fs::clipboard::fs_clipboard_paths`: file explorer + editor IO. File paste captures the workspace and root before clipboard IPC. AppKit and GTK clipboard requests run on the main thread; Windows clipboard retries and filesystem copies run on blocking workers. `fs_copy` requires an authorized root, stages each item and publishes with a no-replace rename, and returns `{ created, failed }` with paths in the caller’s workspace representation. Conflict renaming uses `name copy N` siblings. Symbolic links are preserved without traversing them; copying a folder into itself is rejected. Explorer refresh and pasted selection ignore completions from an obsolete workspace.
- `fs::search::*` (`fs_search`, `fs_list_files`), `fs::grep::*` (`fs_grep`, `fs_grep_interactive`, `fs_glob`): fuzzy file finder + content search (powered by `ignore` + `grep-*` crates). File lists are cached per root in `fs::index` (packed buffer, at most two roots, 45 s TTL) and dropped by watcher events and our own mutations, so a keystroke ranks the cached list instead of re-walking the tree (a change reported during a cold walk marks that walk stale: its result is returned but not cached). Interactive searches bump a `fs::supersede` generation when the command is dispatched, so the walk of an older query stops while a newer one starts. Every command that touches the disk is `async` and runs on the blocking pool (`fs::blocking`): Tauri runs a plain command on the main thread, and the async runtime has two workers (`modules/runtime.rs`), so nothing blocking may run inline in an `async fn` either.
- `git::commands::*`: full source-control surface (`git_status`, `git_diff`, `git_diff_content`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_fetch`, `git_pull_ff_only`, `git_push`, `git_log`, `git_show_commit`, `git_commit_files`, `git_commit_file_diff`, `git_panel_snapshot`, `git_resolve_repo`, `git_remote_url`). All gated through the workspace authorization registry. `git_status` asks git for `--untracked-files=normal` (one `dir/` entry per untracked directory) and expands small untracked directories back into files with a bounded `git ls-files --others` (500 files and 16 directories per refresh, listing abandoned at a 256 KiB cap); a directory over budget stays collapsed as `dir/`, which stage and discard handle natively. Stash, branch, worktree, cherry-pick, revert, reset-soft, abort and clone commands live in the same module.
- `agent_sessions::*` (`agent_sessions_list`, `agent_sessions_delete`, `agent_sessions_image`): reads this machine's or a WSL distro's session stores. opencode is a read-only sqlite query over `session_v2` (falling back to `session`), capped at 200 rows; pi scans its jsonl transcripts. A distro is queried by its own `python3`, with the script handed over through `/mnt`, because a WAL database cannot be read correctly across the 9p mount. Delete resolves the session directory from the store, calls the tool's own CLI, then re-reads to confirm. The store watcher (`agent_sessions/watch.rs`) coalesces bursts from the two paths into one `verta://agent-sessions-changed` event.
- `projects::*` (`projects_scan`, `projects_status`): finds repositories under a root by looking for `.git` (no git process involved), then reads each project's branch, dirty count, upstream, ahead/behind and stash count with four bounded workers. Every row succeeds or fails on its own; one unreadable project never hides the rest.
- `github::*` (`github_repos`, `github_repo_ci`, `github_repo_permission`, `github_repo_settings`, `github_repo_set_description`, `github_repo_set_visibility`, `github_repo_delete`, `github_repo_runs`, `github_run_rerun`, `github_run_cancel`, `github_run_delete`, `github_run_jobs`, `github_run_log`, `github_auth_status`, `github_auth_login_token`, `github_auth_login_web`, `github_auth_login_web_cancel`, `github_auth_logout`): everything goes through the local `gh` CLI, never an app-held token. Failures are classified as not installed, not logged in or other, with gh's own text passed through. A repo's `viewerPermission` decides whether write buttons are rendered at all; when it cannot be read, writes are allowed through so GitHub can refuse them. Editing a repo needs `ADMIN`; deleting needs `delete_repo` on the token, and the error says which command to run when it is missing. Sign-in state is read from `gh auth status --json hosts`; a pasted PAT is written to gh's stdin only and never stored, browser sign-in streams gh's one-time code to the panel and can be cancelled, and sign-out goes through a confirmation that spells out the consequences. Deleting a run or a repo is confirmed by re-reading it: only an explicit 404 counts as success.
- `shell::shell_run_command`: one-shot subshell exec kept from upstream (bounded `proc::capture`: two short reader threads, no wait on pipes a backgrounded grandchild keeps open). Distinct from PTY sessions; not the user's interactive terminal. On Windows via PowerShell (`-NoProfile -Command`), on Unix via `$SHELL -lc`. Shared helper `build_oneshot_command`. No frontend caller remains since the built-in agent was removed.
- `shell::shell_session_*`: persistent agent shell with state across calls. `shell::shell_bg_*` (`spawn`, `logs`, `kill`, `list`): long-running background processes (dev servers etc.) with bounded ring-buffer log capture. Both commands keep their upstream behaviour and have no frontend caller now.
- `workspace::*`: `workspace_authorize` / `workspace_current_dir` (the spawn/git/fs cwd authorization registry) plus the WSL bridge (`wsl_list_distros`, `wsl_default_distro`, `wsl_home`).
- `lsp::*` (`lsp_detect`, `lsp_host_pid`, `lsp_resolve_root`, `lsp_spawn`, `lsp_send`, `lsp_kill`): language server process host. Dumb JSON-RPC pipe: Content-Length framing + process lifecycle in Rust (`lsp/framing.rs`, pure + tested), protocol intelligence on the frontend. Spawn cwd gated through the workspace registry; binaries resolve via the captured login-shell env (`lsp/env.rs`, GUI apps get a bare PATH on macOS); root detection walks up to markers but never to or above `$HOME`. Servers run in their own process group on Unix and are group-killed (cargo check / proc-macro children die with the server); Windows children get a `proc::job::ProcessJob` (kill-on-close, shared with pty). All sessions killed on `RunEvent::Exit`.
- `net::*` (`ai_http_stream`, `ai_http_cancel`, `ai_http_ack`, `lm_ping`): AI HTTP proxy with SSRF guard, retained from upstream with no frontend consumer since the assistant was removed; the commands stay registered so the network layer keeps its tests. Clients are cached per `(profile, host, pinned IPs, allow_private)` with a 90 s idle TTL and at most eight entries, so connections and HTTP/2 sessions are reused while DNS-rebinding protection stays per request. Classification (`net/ip.rs`) looks through IPv6 forms that carry an IPv4 destination (mapped, compatible, NAT64, 6to4, Teredo) and treats everything outside global unicast as non-public.
- `secrets::secrets_*`: OS keychain via the `keyring` crate, retained from upstream with no frontend consumer. Service constant `verta-ai`. Linux uses a file-based fallback gated behind `#[cfg(target_os = "linux")]`.
- `open_settings_window`: separate webview window for Settings (optional `tab` arg deep-links a section).
- `vibrancy::window_*`: native window backdrop (`window_backdrop_kind`, `window_set_backdrop`). macOS gets `NSVisualEffectMaterial::UnderWindowBackground`, Windows 11 gets Mica (gated on build >= 22000 via `RtlGetVersion`, since `apply_mica` fails on Windows 10), Linux reports `none` because blur there belongs to the compositor. The `window-vibrancy` crate is a macOS/Windows-only dependency so Linux builds never pull it.

### PTY shell integration

PTY shells are bootstrapped via injected init scripts in `src-tauri/src/modules/pty/scripts/`:

- **Unix** (`zshenv.zsh`, `zprofile.zsh`, `zlogin.zsh`, `zshrc.zsh`, `bashrc.bash`) for zsh/bash, plus `init.fish` installed to `~/.config/fish/conf.d/verta.fish` for fish. Emit OSC 7 (cwd) and OSC 133 A/B/C/D (prompt boundaries + exit code) so the host can track cwd and detect command boundaries without re-parsing the prompt. Fish 4.0+ writes its own OSC 133 prompt markers; Verta sets `fish_features=no-mark-prompt` and re-asserts its own prompt via `-C` to avoid doubling.
- **Windows** (`profile.ps1`) - passed via `pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File <path>`. Wraps the user's existing `prompt` function (after their `$PROFILE` runs) to emit OSC 7 + OSC 133 A/B/D. Shell priority: `pwsh.exe` (PS 7+) → `powershell.exe` (PS 5.1) → `cmd.exe` (no integration). cwd is normalized to backslashes before being passed to ConPTY (`CreateProcessW` misbehaves with forward-slash cwd).

`pty/shell_init.rs` is split into `#[cfg(unix)]` / `#[cfg(windows)]` modules - keep new platform-specific code in the right cfg arm.

ConPTY on Windows requires `CONPTY_LIFECYCLE_LOCK` (Mutex) around `openpty + spawn_command` in `session.rs`. Concurrent spawns leave one of the resulting PTYs with a stalled output pipe. Don't remove the lock without verifying first-tab stability under fast tab spam. The lock must never be held across anything that waits on the frontend: the waiter lets the reader overdraft the output queue (`close_pseudoconsole`) before taking the lock for `ClosePseudoConsole`, so a backlog the page has not acknowledged cannot stall other `pty_open` calls.

Each ConPTY child is also assigned to a per-session **Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`pty/job.rs`). When the Job HANDLE drops - clean shutdown, panic, or even SIGKILL'd Verta process - the kernel kills every descendant of the shell (e.g. `npm run dev` spawned from inside pwsh). Without this Windows orphans the entire process subtree because `TerminateProcess` only kills the immediate child. macOS/Linux rely on `Drop for Session → killer.kill()`; on dev-`Ctrl-C` of `cargo run` destructors don't fire and orphans are possible there too - acceptable for now since dev only.

### Frontend (`src/`)

Single-window React app. Path alias `@/*` → `src/*`. Tabs are a tagged union (`kind`: `terminal` | `editor` | `preview` | `markdown` | `git-diff` | `git-history` | `git-commit-file` | `projects` | `remotes`) and **not** unmounted on switch - they're hidden via `invisible pointer-events-none` so PTYs and dev servers keep streaming in the background.

`App.tsx` wires modules together - keep it a coordinator. New features go inside the appropriate `modules/<area>/`.

### Module layout (`src/modules/`)

Each module is self-contained, exports a thin barrel via `index.ts`, and owns its hooks under `lib/`.

- **terminal/** - `TerminalStack` keeps live leaves mounted. `useGhosttyTerminalSession` owns one persistent model and PTY per leaf; GPU/WebGL surfaces lease shared presentation resources independently. `terminalSessionApi.ts` exposes renderer-neutral product actions. OSC 7 paths and OSC 52 payloads are validated by pure parsers; Ghostty supplies OSC 133 events and native command anchors to the lazy block controller. WebGPU can fail over to WebGL without replacing the model, PTY, selection, search, or block history. Hidden models keep parsing through bounded PTY transport while presentation is released. There is no snapshot replay or second terminal parser. Theme colors come from the central theme engine. Session images are drawn by `GhosttyImageOverlay` over the space the agent reserved: `terminalImages.ts` finds the printed name and its mosaic band, `terminalSizeReports.ts` answers the CSI 13/14/15/16/18/19 t queries with real cell pixels, and the bitmap comes from `agent_sessions_image`. `shell_init.rs` sets `OPENTUI_IMAGE_PROTOCOL=blocks` so opencode reserves a block mosaic instead of leaving a hole.
- **editor/** - CodeMirror 6 stack (`EditorStack` mirrors `TerminalStack`). `extensions.ts` configures language modes; supports vim mode. Buffers live in LF space and the original EOL (`lib/eol.ts`, majority-vote detection) is restored on save; indent unit/tab size are detected per file (`lib/indent.ts`) via a per-pane compartment. Saves are conflict-checked against the disk mtime returned by `fs_read_file`/`fs_write_file` (mismatch → warning toast with explicit Overwrite, never silent last-writer-wins); external format-on-save only applies the disk read-back if the doc is unchanged since the save snapshot. Files over 10 MB offer "Open anyway" (hard cap 50 MB, `force` arg); above 4 MB syntax highlighting and LSP stay off. Cmd-F routes to CodeMirror's own search panel (find/replace/regex) when an editor tab is active, Ctrl-G opens go-to-line; both panels styled in `chromeTheme.ts`. Format-on-save formatters live in `lib/externalFormat.ts` (`FORMATTERS` registry: biome, prettier, ruff, rustfmt, gofmt, clang-format, shfmt, zig fmt, plus a custom `{file}` command template); `resolveFormatter` applies per-language overrides (`editorFormatterByLang`) over the global default, and a global external default only runs on languages its tool understands. Diff panes resolve the language before mounting CodeMirror: a late compartment reconfigure leaves the merge view's deleted-chunk widgets unhighlighted. Unsaved buffers are mirrored into `lib/drafts.ts` (1 MB per draft, 8 drafts, 4 MB total) 1.5 s after typing stops and on unmount, blur and window close; opening a file whose draft differs offers recovery instead of overwriting. The AI inline-completion layer upstream had is gone with the assistant. Markdown editing is GFM (`markdownLanguage` base) with fenced-code highlighting resolved through the shared lazy language registry, Cmd/Ctrl+Click URLs, and clickable task checkboxes (`markdownExtras.ts`, all inside the lazy markdown chunk; the eager-budget test enforces this). Dotenv files (`.env`, `.env.*`, and `*.env`) use the lazy shell grammar. Editor theme is decoupled from the app theme: the `editorTheme` pref is `"auto" | EditorThemeId` (default `"auto"`), resolved at render time by `useEditorThemeExt` via `resolveEditorThemeId`. In `auto` the editor follows the active app theme's `editorTheme[mode]` pairing (live, never stale); an explicit pick overrides. Theme ids + labels live in `settings/store.ts` (`EDITOR_THEMES`/`EDITOR_THEME_LABELS`); the matching extensions in `editor/lib/themes.ts` (`EDITOR_THEME_EXT`). Prebuilt `@uiw` themes plus locally-built ones in `editor/lib/cmThemes.ts` (Kanagawa wave/lotus/dragon, Everforest, Dracula, Solarized, Catppuccin, Rosé Pine) via `createTheme` (no extra deps). The two CM surfaces (`EditorPane`, `GitDiffPane`) both read the theme through `useEditorThemeExt`. The editor's right-hand `SidePreview` reuses the Markdown renderer and follows the buffer live, so preview and editor cannot disagree about images or code blocks.
  Editor code size is stored separately as `editorFontSize` and does not affect `terminalFontSize`. The editor's font is the terminal's font (`terminalFontFamily`, shared by both) and reaches CodeMirror through the `--editor-font-family` CSS variable, because its theme is built once at module load and cannot carry a changing stack.
- **explorer/** - file tree with Catppuccin icons, fuzzy search, keyboard nav, inline rename, context actions. Backslash-aware `basename`. Icons are lazy: `iconResolver.ts` is the startup-safe shell and fetches the ~360 kB set (`iconEngine.ts`) when the first `FileIcon`/`FolderIcon` mounts; until then those components render a same-size blank slot that fades the icon in, and the set is never in either window's startup graph. The tree stays mounted when the sidebar collapses but is `visible={false}`: no native fs watchers (`watchRegistry.ts` disarms them), no `fs:changed` subscription, no drop listener and no reloads; showing it re-registers the watchers and reloads loaded directories once.
- **preview/** - auto-detected dev-server preview tab (status-bar pill suggests opening when a localhost URL is detected).
- **tabs/** - `useTabs` is the source of truth for tab list + active id, in one list for the whole window. `TabBar` renders the strip and `TabChip` renders one tab in it: the chip is its own memoised component because it carries the language menu, the context menu and the rename field, and the strip re-renders for reasons that touch one or two tabs (its measured pill, a drag, a window-level state change), so inlining the chip made every menu in the strip render on every strip render. `useTabRestore` brings that list back at boot from `verta-tabs.json` (the first boot after the Spaces removal migrates the active space's tabs out of `verta-spaces.json` and deletes that key); `useTabPersistence` writes it back on a 3 s debounce and again on blur, hide and close. `useWorkspaceCwd` derives explorer root + inherited cwd for new tabs from active tab. `basename` splits on both `/` and `\`.
- **header/** - top bar + inline search (`SearchInline` adapts to terminal vs editor via `SearchTarget`). `WindowControls` rendered when `USE_CUSTOM_WINDOW_CONTROLS` is true (Linux + Windows; macOS uses native traffic lights). The header also carries the remote-repos entry and the right-panel toggle with the changed-count badge.
- **statusbar/** - bottom bar, `CwdBreadcrumb` (handles Unix paths, Windows drive letters, and home `~` segments via `pathUtils.segmentsFromCwd`), the LSP status pill and the diagnostics badge. The `privateActive` badge ("Private: hidden from AI") is a leftover of the removed assistant: nothing consumes the flag any more.
- **shortcuts/** - keymap registry (`shortcuts.ts`) + `useGlobalShortcuts`. Handlers live in `App.tsx` and are passed in by id (`tab.new`, …). `metaKey || ctrlKey` for cross-platform Cmd/Ctrl.
- **settings/** - settings store (`store.ts` via `tauri-plugin-store`), preferences hook, settings window opener. The Settings window is closed (not hidden, so its WebContent process is released) when it hands a theme edit to the main window; `open_settings_window` rebuilds it on demand. The font row uses `components/FontPicker.tsx`: a type-to-filter list of the families `fonts_list` reports, falling back to a plain text input when the machine's fonts cannot be listed.
- **sidebar/** - activity bar + collapsible side panels. Only the session list (`launcher`) and the file tree (`explorer`) live here; Git moved to the right panel and its state lives in `useRightPanel`.
- **source-control/** - git status / stage / commit / stash / branch / worktree panel in the right panel, plus the diff workflow. `useSourceControl` takes a `live` flag (`statusConsumers.ts`): `git status` runs on window focus and context changes only while the right panel is open, a git tab is active or the explorer's git decorations are on screen. Otherwise nothing runs, a snapshot for another repository is dropped (never a wrong badge), and the next consumer to appear refreshes it. The header badge alone is not a consumer; it refreshes lazily.
- **git-history/** - commit graph rail, refs, per-commit file diffs.
- **lsp/** - opt-in language server support, zero cost until enabled (no process, no PATH check, nothing in the eager bundle beyond a 14.5 kB shell). Statusbar pill offers Enable (binary found) or Install (with copyable command) per language; activation persists as `lspActivation` in the settings store (`enabled`/`dismissed`/unset). `sessionManager.ts` keys sessions by (server, workspace root), refcounts open docs, idle-kills after 3 min, and crash-backoffs (cooldown before respawn; 3 in 5 min → give up + toast with the server's stderr tail). Resource invariants: **no root marker → no session** (a dirname fallback once spawned a server per directory and burned GBs), hard cap of 4 sessions per server, lean per-preset `initializationOptions` (rust-analyzer: `cachePriming` off + bounded `lru`; tsls: `maxTsServerMemory`). Client is `codemirror-languageserver` behind a lazy import, subclassed (`lib/client.ts`) to add didClose/didSave/shutdown, `textDocument/references` (Shift-F12; multi-result definitions and references share the `locationsPanel.ts` picker) and the publishDiagnostics capability the lib forgets (tsls sends no diagnostics without it); `lib/transport.ts` bridges to the Rust pipe and answers server-to-client requests the lib ignores. `vscode-languageserver-protocol` is aliased to a 4-enum shim in vite.config.ts (~117 kB saved). Presets: typescript, rust-analyzer, pyright, ruff, gopls and more; custom stdio servers via Settings. Several presets can claim one language (pyright and ruff both take `py`): `serverForLanguage` prefers the enabled candidate, so enabling ruff while pyright is unset or dismissed routes Python to ruff. WSL workspaces excluded for now.
- **markdown/** - markdown preview renderer (backs the `markdown` tab kind). Local images resolve through `imagePath.ts`: relative references join the document's own directory, absolute paths are taken as written, and remote or `data:` URLs pass straight through. `MarkdownImage.tsx` sizes every image in a table from the table width, so a narrow window shrinks the whole table instead of overflowing it.
- **workspace/** - `envForPath` / `envForRoot` infer Local or a distro from the path itself; `useWorkspaceEnvStore` holds the distro list and the current environment. A path that cannot be classified keeps the previous environment rather than guessing.
- **theme/** - custom theme engine (no `next-themes`). `ThemeProvider` + `applyTheme` write CSS variables; built-in presets in `themes/` (verta-default - colours live in `globals.css` since ThemeProvider clears rather than applies for that id - xcode, claude, kanagawa, kanagawa-dragon, tokyo-night, catppuccin, rose-pine, everforest, nord, gruvbox, dracula, solarized, tide, sage, caffeine), each optionally declaring an `editorTheme` pairing consumed by `resolveEditorThemeId` (see editor/). User themes via `customThemes.ts` + `validateTheme.ts`, optional background image via `bgImageStore.ts` + `SurfaceLayer`.
- **updater/** - auto-updater UI built on `tauri-plugin-updater`.
- **launcher/** - the session list. Reads every source (this machine plus each distro while the WSL switch is on), hides subagent sessions unless managing, groups by source, and opens a session through `planSessionOpen`, which derives the environment and the resume command together so a local session cannot open in a distro shell.
- **projects/** - the projects tab: an ordered path list in `verta-projects.json`, scan, batch status, filter and three-state sort, a hover card with that project's sessions, and per-row actions (open workspace, terminal, new agent session, copy path, remove).
- **remotes/** - the GitHub tab: account repositories, a lazily fetched CI column, the run list, run detail with jobs and logs, rerun, cancel and delete, and the release list with its assets. Write buttons are hidden when the repo's permission is confirmed read-only; an unknown permission keeps them. A repo's own settings dialog edits the description, flips visibility (each direction spells out its consequences first) and deletes it behind a typed-out full name. Cloning from a row reuses the projects dialog, prefilled with the clone URL and a destination beside an existing project. The account chip opens a sign-in panel: current account, browser sign-in with gh's one-time code streamed in, a pasted PAT (never stored), and sign-out behind a confirmation. Everything calls `gh` through Rust; only the explicit secondary action opens a browser. An asset download streams through `gh api` into `<name>.verta-part` next to the target, reports real byte progress over `verta://github-download`, and only renames on success, so a failed or cancelled download never touches a file that is already there. A row's `⋯` menu also opens that repository's issues and pull requests: a two-stage dialog (list → detail with body, comments, PR section and check state) carrying comment, open/close, new-issue and merge actions. Whether merge is blocked is decided in the backend, which sends a reason **code** the UI resolves to a message like everything else, and the check summary reports `partial` (never a pass) when `check-runs` paging left checks unread.
- **i18n/** - the zh and en tables (`messages.ts`), `LanguagePref` resolution and `useT`. Only interface text is translated; comments are written in English, while logs, agent names and commands are left as they come.
- **command-palette/** - modal command palette (`CommandPalette.tsx`, `commands.ts`) for actions and navigation.

### No built-in agent

This fork removed the upstream assistant: `src/modules/ai/**`, `src/modules/agents/**`, `src/components/ai-elements/**`, `src-tauri/src/modules/ai_sessions.rs` and `src-tauri/src/modules/agent.rs` are gone, together with the AI diff tab, inline completion, the notification bell and the model / API-key settings. Do not describe an AI feature in this file and do not rebuild one from a leftover reference.

What remains on purpose:

- `src/components/chat-code.tsx` renders fenced code blocks (with a run button) for the terminal block overlay and Markdown. It is not an AI surface.
- `net::ai_http_*`, `lm_ping`, `secrets::*`, `shell_session_*` and `shell_bg_*` are still registered in Rust and wrapped in `src/lib/native.ts`, but nothing in the frontend calls them. They are cleanup candidates, kept until the network and keychain layer is either reused or removed.
- `TerminalTab.private` and the status bar badge that reads it lost their meaning with the assistant.

### UI conventions

- **shadcn/ui** is configured (`components.json`, style `radix-luma`, base `mist`, icon lib **hugeicons**). Primitives in `src/components/ui/` - don't hand-edit; re-run `pnpm dlx shadcn add` to upgrade. The copy they carry is the exception: it comes from the message table (`spinner.tsx` did this first, then `breadcrumb`/`dialog`/`sheet`/`command`), so a reader-visible or screen-reader string is translated in place - keep such a hand edit to the copy line so an upgrade can still be merged past it.
- **AI Elements** were removed with the assistant. `components.json` still carries the `@ai-elements` registry entry; it is inert and should not be used to add chat surfaces back.
- **Tailwind v4** - no `tailwind.config.*`, config is in `src/App.css` via `@theme`. Use `cn()` from `@/lib/utils`.
- Animation: `motion` (Framer Motion successor). Resizable layout: `react-resizable-panels`.
- **Animation cost**: nothing animates forever at display rate. Tailwind `animate-spin`/`animate-pulse` are redefined in `globals.css` with `steps()` (12 and ~4 fps), the text shimmer uses 40 steps per sweep, recording indicators use `.verta-blink`, and persisted history (`bash_background`) never animates. `modules/theme/windowActivity.ts` sets `html[data-window-inactive]` while the window is unfocused, hidden or occluded (DOM focus, document visibility and the terminal's shared native presentation feed, no extra native listener); that attribute pauses every CSS animation and an animated background image freezes on a still frame (`surfaceFrame.ts`). `prefers-reduced-motion` still removes the rest.
- **Compositing budget**: every composited layer costs a backing store, and WebKit allocates a new one per window-resize step for each layer that follows the window. At rest the shell has three layers with contents (page tile, terminal canvas, the terminal's hidden textarea); everything else is clip layers without backing. Do not add `will-change`, 3D transforms (`translateZ`, `transform-gpu`), `backdrop-filter`/`backdrop-blur` or blur filters to anything mounted by default; popovers, HUDs and chips keep their own opaque `bg-popover`/`bg-card`, and the floating layers that carry `verta-float` (menus, dialogs, the command palette) take the pane's tint instead, as plain alpha at the theme's pane opacity and never a blur, because alpha blending costs no backing store where a blur costs one and is reallocated on every window-resize step. A menu or a popover still opens over a blurred scrim (`FloatingScrim`, mounted by `DropdownMenu` and `Popover` while one is open, the same recipe the dialog overlay uses), which is a layer only for as long as that surface is up. Only the allowlist in `src/styles/compositingBudget.test.ts` (modal scrims, the background-image overlay, ...) may, each with a reason. A static background image gets no layer (`surfaceOwnsLayer`). While a window drag is live, `html[data-live-resize]` (`modules/theme/livePageResize`, macOS only) gives the document an invisible size rounded up to 512 px so WebKit keeps one page tile size across the drag instead of one per step.
- **Startup graph**: neither window may preload Streamdown, CodeMirror or the icon set. `vite.config.ts` splits chunks with two prioritised `codeSplitting` groups (eager `react`/`radix`/`ghostty-vt` outrank lazy features). The provider and `@ai-sdk/*` chunk mappings are leftovers from upstream with no source import, so they emit nothing; `dist-budget.test.ts` still lists the AI SDK, zod and Streamdown as forbidden packages, so reintroducing them fails the gate. `src/app/dist-budget.test.ts` builds into a temp dir with sourcemaps and fails if any forbidden package or chunk is reachable from `index.html`/`settings.html`; `pnpm check:dist` runs the same check on `dist/`. `eager-budget.test.ts` keeps the source-graph check.
- **Window vibrancy**: the `windowVibrancy` pref drives `WindowVibrancyBridge` (main window only - `window_set_backdrop` targets its caller). `html[data-vibrancy="on"]` (off by default; an explicitly stored choice always wins) makes `<html>`/`<body>` transparent and redefines `--frame` with alpha, so only the chrome frosts; panes keep `--background` so terminal text stays on a solid surface and the terminal canvas still matches its container. The opaque colour the pre-paint script parks on `<html>` would cover the backdrop, so `applyVibrancy` clears it while the effect is on; there is deliberately no localStorage fast path, since pre-declaring the effect would show a see-through window on any launch where the native call has not landed yet. Repeat applications are deduped, and only Mica is rebuilt on a light/dark flip (NSVisualEffectView adapts on its own).
- **Floating panes**: header and status bar are window chrome painted on `--frame` (derived from `--card`, so no theme declares it); the sidebar and the tab surface are `.verta-pane` cards on `--background` - same tone as the terminal canvas. Panes meet the chrome flush and are inset only horizontally, because the header centers its content and any vertical gutter would stack onto that padding and read as asymmetric. `.verta-pane` carries no drop shadow: `react-resizable-panels` clips panel content at the panel box, so a shadow would only render on the gutter sides.
- Path imports: always `@/…`, never relative across modules.
- Cross-platform paths: anywhere a path may originate from OSC 7, the explorer, or the OS, normalize separators with `.split(/[\\/]/)` rather than `.split("/")`.
- Canonical path form on the frontend is **forward-slash**. `homeDir()` returns backslashes on Windows; convert at the boundary (App.tsx setHome). OSC 7 already arrives as forward-slash. Equal canonical strings keep `useFileTree` from wiping its tree and flashing the explorer when `tab.cwd` first arrives.
- **Interface copy**: every string the user can read comes from `modules/i18n/messages.ts`, through `t("area.key")` from `useT()`; `i18n.test.ts` keeps both languages defining the same keys, none empty. There is no plural engine, so a counted sentence picks one key or joins table fragments (`{count} file changed` against `{count} files changed`, `closeDialog.frag.*`). Pure helpers stay pure and take the finished label as an argument: `planCommitHistoryOpen` takes a `title` like `planProjectsOpen` does, `hostLabel` takes its labels (English defaults), `normalizeError` takes an already translated fallback. A label that lives in a hook is resolved to a plain string before a callback depends on it, because `setTabs((t) => ...)` shadows `t`; where an effect must not re-run on a language switch (the tab restore), the label is read through a ref instead of a dependency. Tab titles are stored, so a label built when a tab opens keeps the language it was built in, and the restore path recomputes the preview fallback from the url. Text that is not interface copy stays English: protocol field names and state enums, renderer diagnostics, strings that no longer have a consumer in the code, and error text produced on the other side (a Rust status label, a validator message) until that side speaks keys.

### Window styling

- macOS: `titleBarStyle: Overlay` + `hiddenTitle: true` in `tauri.conf.json` (native traffic lights via overlay). The main window is created opaque, because a non-opaque `NSWindow` makes WindowServer blend every terminal frame. `window_set_backdrop` makes the window and its `WKWebView` (`drawsBackground`) see-through only while vibrancy is on, and paints the opaque window with the theme's frame colour otherwise. `macOSPrivateApi: true` stays for that `WKWebView` key and the private `NSVisualEffectView` hosting, so the macOS build uses a private API and is not App Store eligible.
- Linux: `decorations: false` + `transparent: true` from `tauri.linux.conf.json`; re-asserted post-realize for GNOME/Mutter CSD. Windows and Linux stay transparent from creation because the borderless chrome paints its own rounded corners.
- Windows: same as Linux via `tauri.windows.conf.json`. React renders custom `WindowControls`.

### Tauri capabilities

`src-tauri/capabilities/default.json` is the allowlist for plugin APIs available to the webview. New plugins (dialog, autostart, updater, window-state, store, opener, os, log are wired in `lib.rs`) typically need:
1. `Cargo.toml` dependency
2. `.plugin(...)` call in `lib.rs` `run()`
3. capability entry in `default.json`

### Cross-platform conventions

- HOME / cache dirs: use the `dirs` crate (`dirs::home_dir()`, `dirs::cache_dir()`), never raw `$HOME` / `%USERPROFILE%`.
- Shell init scripts: gate Unix-only logic behind `#[cfg(unix)]`; Windows arm in `pty::shell_init::windows`.
- Terminal input: send `\r` (CR) for Enter, not `\n` (LF) - PowerShell on Windows requires CR.

### Bundle config

- `bundle.targets: "all"` plus per-platform sections in `tauri.conf.json`:
  - **macOS**: `minimumSystemVersion: 13.0`.
  - **Linux**: deb depends `libwebkit2gtk-4.1-0`, `libgtk-3-0`; rpm `webkit2gtk4.1`, `gtk3`; AppImage bundles its media framework.
  - **Windows**: NSIS installer in `currentUser` mode (no admin required), WebView2 via `downloadBootstrapper`. Installing a missing WebView2 runtime requires internet access; there is no bundled offline runtime. Packaged and offline-install validation remains in the release-readiness gates.
- Auto-updater: **尚未配置**（发布时生成自己的签名密钥，再把 `pubkey` 与 `endpoints` 填回 `tauri.conf.json`，并把 `createUpdaterArtifacts` 重新打开）。
- `bundle.resources` includes the upstream Ghostty, Restty, ghostty-web, and xterm.js license notices under `licenses/terminal/`. Repository documentation and test-only reference WASM cores are not packaged; the frontend includes only the adapted SIMD and scalar cores.

### Known gotchas

- **Hidden windows keep the process alive**: the settings window and the screenshot overlay hide instead of destroying, so they can be reopened without rebuilding the webview. Closing the main window therefore has to destroy both of them, or `verta.exe` stays running with nothing on screen. `src-tauri/src/lib.rs` does that on the main window's `Destroyed` event, which is also where the app quits on Windows and Linux; macOS keeps an app alive with no window open, by convention.
- **React 19 strict mode** double-mounts `useEffect` in dev → terminals spawn twice on first render. The first PTY is cleaned up almost immediately. The `CONPTY_LIFECYCLE_LOCK` mutex serializes this; don't be alarmed by `pty opened id=1` followed by `pty closed id=1` in dev logs.
- **Windows PowerShell process lifecycle**: `killer.kill()` from `portable-pty` only kills the immediate child. Descendants (e.g. `npm run dev` started inside pwsh) survive unless something else takes them down. The Job Object in `pty/job.rs` handles this for the Verta-process-death case; an explicit `pty_close` from JS also kills only the immediate child + relies on the Job to take the rest. Don't disable the Job without a replacement.
- **Tab `cwd` storage**: comes from OSC 7 with forward slashes (after `parseOsc7` strips `/C:` → `C:`). Anything that consumes `tab.cwd` and passes it to a Rust fs command on Windows must normalize separators or accept both forms - `apply_common` in `pty::shell_init` handles this for PTY spawn; other call sites must do their own.
- **Two identifiers stay in the source project's spelling**, because they are compiled into the prebuilt libghostty wasm and renaming them means rebuilding it with zig: the import module `terax` that `packages/ghostty-core/lib/official/callbackBridge.ts` has to supply (the name is also spelled out as bytes in that file), and the `terax_blocks=0` marker compared inside `packages/ghostty-core/adapted/ghostty-vt.wasm`(and kept in step in `packages/ghostty-core/adapted/wasm/src/verta.zig`, the shell init scripts and the tests). Everything else is named Verta; do not "finish the rename" by touching these two.

## Further reading

This repository does not carry long-form contributor guides: what applies here is
this file and the code itself. Working records (requirements, design, plans) are
kept on this machine under `.superpowers/` and are not tracked.
