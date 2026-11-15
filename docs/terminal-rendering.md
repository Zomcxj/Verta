# Terminal rendering

libghostty-vt is the only terminal model, and this file is the record of what that costs and what
it buys: the renderer, the presentation resources, the resize rules, the transport, and the
budgets that hold them.

Read it before touching `src/modules/terminal/` or `src-tauri/src/modules/pty/`. The invariants
here are the ones that were measured the hard way, and several of them look like over-caution until
you read why.

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
