# VERTA.md

Verta loads `VERTA.md` from the workspace root as agent memory (similar to AGENTS.md / CLAUDE.md).
It is the entry point: the project, the bar a change is held to, the conventions, and a map of where
the detail lives.

## Project

**Verta**: Windows-first desktop workbench for the coding-agent sessions already on this machine.
Tauri 2 + Rust (`portable-pty`) backend, React 19 + TypeScript + libghostty-vt WASM client (WebGPU,
Verta WebGL fallback). The upstream AI assistant is not part of this fork (see `CHANGES.md`).

- Bundle id: `app.verta`
- Package manager: **pnpm**
- Platforms: Windows is the target; the upstream macOS and Linux paths remain in the tree
- Frontend checks: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust checks: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`,
  `cd src-tauri && cargo test --lib`

## Quality bar

Production-grade or it does not ship. Every change is judged against all of these, not just "it
works":

- **Correctness**: edge cases, failure modes, concurrent access. No "works for now".
- **Performance**: ultra-lightweight is the product. ~7-8 MB bundle, high-performance terminal. For
  every change ask: how much RAM it costs, whether it adds IPC round-trips or redundant requests,
  whether it triggers extra re-renders or wasted work, whether it pulls a heavy dependency. Unused
  features consume zero resources.
- **Security**: no critical security holes. Validate at every boundary (IPC, fs, network, process
  spawn). File, git and spawn paths go through the `WorkspaceRegistry` allow-list.
- **UI/UX**: polished, professional, premium. Every state and detail considered.
- **Architecture**: new or changed logic lives in pure, dependency-light functions (functional core);
  tauri commands and React components stay thin (imperative shell). Keeps it testable without a later
  rewrite.

Verify before claiming done:

- Frontend: `pnpm lint`, `pnpm check-types`, `pnpm test`
- Rust: `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`,
  `cd src-tauri && cargo test --lib`

A change to a core subsystem (terminal/shell spawn, workspace auth, git, fs, IPC or process spawn)
needs a test that locks the invariant. [docs/testing.md](docs/testing.md) says what each layer of
testing is for, how to run a probe against a real build, and which failures are known flakes.

## Conventions

- **Comments**: default to none, the code should explain itself. If genuinely needed, 1-2 lines on
  *why*, never *what*, and always in English: the code is read by the upstream and by outside readers,
  while only interface text is Chinese. No AI-generic filler.
- **No em-dash** anywhere: code, comments, commits, docs.
- **No emojis** anywhere.
- **Imports**: always `@/...` on the frontend, never relative across modules.
- **pnpm only**, never npm/npx/yarn.
- **One fact, one source**: never give the same fact two entry points or two ways of saying it.

UI rules that are measurements rather than taste (compositing budget, animation cost, startup graph,
floating surfaces, window styling) are in [docs/ui-conventions.md](docs/ui-conventions.md).

## Architecture map

The full index is [docs/README.md](docs/README.md); the documents themselves are below.

The system is two processes with a narrow waist: Rust owns every OS resource, the webview owns every
pixel, and the only thing between them is `invoke()`.

- [docs/architecture.md](docs/architecture.md) - the two-process model, the command surface per
  module, PTY shell integration, the frontend layout and the module map, and the known gotchas.
- [docs/terminal-rendering.md](docs/terminal-rendering.md) - the terminal: the model, the renderers,
  presentation resources, resize rules, the PTY transport and its budgets. Read it before touching
  `src/modules/terminal/` or `src-tauri/src/modules/pty/`.
- [docs/ui-conventions.md](docs/ui-conventions.md) - surfaces, compositing and animation budgets, the
  startup graph, window styling.
- [docs/platform-and-bundle.md](docs/platform-and-bundle.md) - Tauri capabilities, cross-platform
  rules, what the installer carries.
- [docs/session-list.md](docs/session-list.md) - the session list, the hover card and the info dialog,
  subagents, delete.
- [docs/usage.md](docs/usage.md) - the usage window: the seven readers, the cc-switch hole-filling
  rule, model identity, folding, the trend chart and its axis.

## No built-in agent

This fork removed the upstream assistant: `src/modules/ai/**`, `src/modules/agents/**`,
`src/components/ai-elements/**`, `src-tauri/src/modules/ai_sessions.rs` and
`src-tauri/src/modules/agent.rs` are gone, together with the AI diff tab, inline completion, the
notification bell and the model / API-key settings. Do not describe an AI feature in these docs and do
not rebuild one from a leftover reference.

What remains on purpose:

- `src/components/chat-code.tsx` renders fenced code blocks (with a run button) for the terminal block
  overlay and Markdown. It is not an AI surface.
- `net::ai_http_*`, `lm_ping`, `secrets::*`, `shell_session_*` and `shell_bg_*` are still registered in
  Rust and wrapped in `src/lib/native.ts`, but nothing in the frontend calls them. They are cleanup
  candidates, kept until the network and keychain layer is either reused or removed.
- `TerminalTab.private` and the status bar badge that reads it lost their meaning with the assistant.

## Two identifiers stay in the source project's spelling

They are compiled into the prebuilt libghostty wasm, and renaming them means rebuilding it with zig:
the import module `terax` that `packages/ghostty-core/lib/official/callbackBridge.ts` has to supply
(the name is also spelled out as bytes in that file), and the `terax_blocks=0` marker compared inside
`packages/ghostty-core/adapted/ghostty-vt.wasm` (and kept in step in
`packages/ghostty-core/adapted/wasm/src/verta.zig`, the shell init scripts and the tests). Everything
else is named Verta; do not "finish the rename" by touching these two.

## Further reading

- [README.md](README.md) - what the app does, how to run it, how to build it.
- [CONTRIBUTING.md](CONTRIBUTING.md) - how a change gets in.
- [SECURITY.md](SECURITY.md) - how to report a vulnerability.
- [CHANGES.md](CHANGES.md) - every difference from upstream, by date, with the reason.

Working records (requirements, design, plans, probe screenshots) are kept on this machine under
`.superpowers/` and are not tracked.
