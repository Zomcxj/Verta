# Contributing

This is a personal fork, so the short version: open an issue before you write a patch, and keep a
pull request to one thing.

## Before you start

- Read [VERTA.md](VERTA.md). It states the quality bar a change is held to and the conventions this
  repository does not bend (no em-dash, no emoji, comments in English, interface text in Chinese).
- Read the doc for the area you are touching. `docs/` has one file per subsystem, and each one records
  what was measured and what broke before, which is usually the reason a rule looks over-cautious.
- Open an issue for anything larger than a typo. A feature or a UI change needs agreement on the shape
  before the code, because most of the cost here is in the details a patch alone does not show.

## What a change has to carry

1. **A `CHANGES.md` entry, in the same commit.** Every difference from upstream is recorded there, by
   date, and the entry says *why*. This is not optional: the file is how the fork stays explainable.
2. **The gates, all green.** `pnpm check-types`, `pnpm lint`, `pnpm test`, `pnpm build`, and in
   `src-tauri` `cargo clippy --all-targets -- -D warnings` and `cargo test --lib`. See
   [docs/testing.md](docs/testing.md) for what each layer is for and for the known flakes.
3. **A test for the invariant, if you touched a core subsystem.** Terminal spawn, workspace
   authorization, git, fs, IPC and process spawn all have one; a change there without a test is a
   change nobody can check next time.
4. **A real measurement for anything visual.** `scripts/dev/probes/` drives the running application
   over the DevTools protocol. "It looks right" is not a verification here.

## Style

- Comments explain *why*, in English, in one or two lines. Code that needs a paragraph of explanation
  needs to be rewritten instead.
- Pure logic goes in a pure function with a test; the component or the command stays a thin shell.
- Do not reformat a file you are only passing through, and never run `cargo fmt` in `src-tauri`: it
  reorders the whole workspace.
- Match the surrounding code. Where this repository differs from what you would have written, the
  difference is usually a fix for something specific.

## Commits

`type(scope): one line`, then a body that says what the change is for. One commit does one thing; the
code and its `CHANGES.md` entry are that one thing.

## Bugs

Open an issue with the version, the smallest steps that reproduce it, what you expected, what happened,
and what you ruled out. A stranger should be able to reproduce it from the issue alone.
