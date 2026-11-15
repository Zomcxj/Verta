# Documentation

One file per subsystem. Each one records what was measured and what broke before, so the rule it
states can be judged rather than just obeyed.

Start at [../VERTA.md](../VERTA.md) for the project, the quality bar and the conventions. This page is
the map of everything else.

## The system

| Document | What it answers |
|---|---|
| [architecture.md](architecture.md) | How the two processes divide the work, what each Rust module's command surface is, how the frontend and its modules are laid out, and the gotchas that have already bitten. |
| [terminal-rendering.md](terminal-rendering.md) | The terminal: the model, the two renderers, presentation resources, resize rules, the PTY transport and its budgets. Read before touching `src/modules/terminal/` or `src-tauri/src/modules/pty/`. |
| [ui-conventions.md](ui-conventions.md) | Surfaces, the compositing and animation budgets, the startup graph, window styling. |
| [platform-and-bundle.md](platform-and-bundle.md) | Tauri capabilities, cross-platform rules, what the installer carries. |

## Features

| Document | What it answers |
|---|---|
| [session-list.md](session-list.md) | The session list: where the rows come from, opening one, subagents, the hover card and the info dialog, delete, the watcher. |
| [usage.md](usage.md) | The usage window: the six readers, model identity, folding, the trend chart and its axis. |

## Working on it

| Document | What it answers |
|---|---|
| [testing.md](testing.md) | The gates, what each layer of testing is for, how to run a probe against a real build, and which failures are known flakes. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How a change gets in. |
| [../CHANGES.md](../CHANGES.md) | Every difference from upstream, by date, with the reason. |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability, and what this application is trusted with. |

## Adding a document

- **One subsystem per file.** A file that covers two is a file whose reader has to skip half of it.
- **English.** The code is read by the upstream and by outside readers; only interface text is Chinese.
  A quoted value keeps its own spelling.
- **State the reason, not only the rule.** "Do not add `backdrop-filter` to anything mounted by
  default" is a rule; "a blur costs a backing store and WebKit reallocates it on every window-resize
  step" is a reason someone can weigh when their case looks different.
- **Link it from this page and from `VERTA.md`.** A document nobody links is a document nobody reads,
  and `src/app/docsSet.test.ts` fails the build for an unreachable file, a broken link, or a renamed
  probe.
