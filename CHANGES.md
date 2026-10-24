# Changes vs Upstream (Terax AI)

This project is a derivative of [crynta/terax-ai](https://github.com/crynta/terax-ai) (Apache-2.0), and that
license requires a modified project to state what was changed. This file is that statement. Newest first,
ordered by date descending.

One change per line: a **new module / new feature that upstream does not have** needs one line; a **change to a
file upstream already had** must name that file (which file, what changed). No line numbers, no function names.

Details are collapsed by date: the date itself is the summary of the collapsed block (`<details>` +
`<summary>`), which GitHub renders as an expand/collapse arrow to the left of the date and which still reads
fine as plain text. **The newest day is `open` by default**; when a new day starts, copy the previous block,
swap in the new date, and drop the `open` from the day before.

---

<details open>
<summary><strong>2026-10-24</strong></summary>

**The terminal cell pitch follows the font, not the pane**

- `src/modules/terminal/ghostty/gpu/TerminalFit.ts`: `gridDeviceSize` states the device-pixel rectangle a grid of cells covers, and the viewport fit now takes its pixel size from the same function, so what the surface reports to the shell and what the renderer draws into cannot drift apart.
- `src/modules/terminal/ghostty/gpu/TerminalFit.test.ts`: the rectangle is the cells' own and never the canvas', it agrees with the viewport fit the surface sizes the pane with, and it stays a whole number of device pixels per column.
- `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts`: the WebGL renderer draws the grid into its own rectangle instead of the whole canvas, so the GL viewport, the glyph offset and size attributes and the resolution uniform all use the grid. The backing store keeps a nearby bigger canvas on purpose, and spreading the grid across that canvas tied the cell pitch to the canvas width, which follows the pane width: letter spacing and row height moved while a divider was dragged. Hit testing, selection and the block overlays were already in font cells, so this is also what lines them up with what is drawn.
- `scripts/dev/probes/terminal-cell-pitch.mjs` (new): measures the spacing of a ruler of strokes in a screenshot, once with the sidebar shown and once hidden, and fails when the two pitches differ.

**A working directory that lost its drive letter is never used**

- `src-tauri/src/modules/pty/shell_init.rs`: a working directory is only handed to the shell when it is absolute (a drive or UNC path, or a leading slash). Windows resolves a drive-less path against whichever drive the app's own process sits on, so the shell either opened somewhere else or the spawn failed with "the system cannot find the path specified".
- `src/modules/tabs/lib/serialize.ts`: a restored tab drops a stored working directory that no longer fits its environment, and the label still comes from what was stored.
- `src/modules/tabs/lib/serialize.test.ts` (new): drive, UNC and distro paths survive, a drive-less one is dropped, and the label is kept.
- `src/modules/terminal/lib/osc-handlers.ts`: the OSC 7 report puts back the drive letter the URI authority swallowed (`file://HOSTF:/dir`), which is where those paths came from.
- `src/modules/terminal/lib/osc-handlers.test.ts`: the two glued-drive cases.

**The session-start transition belongs to its tab, and it paints no slab**

- `src/app/components/sessionOpening.ts` (new): the transition is up only while the leaf it was opened for still sits in the tab on screen, so clicking a session and closing that tab straight away lifts it instead of spinning over whatever terminal is there by then.
- `src/app/components/sessionOpening.test.ts` (new): that rule, including the tab closed right after clicking.
- `src/app/App.tsx`: the transition is held as the leaf it was opened for plus a generation token rather than a bare flag with a blind fallback timer, and the wait ends on the renderer's own painted frame (`whenLeafPaints`) rather than on output bytes, because bytes move before the frame does.
- `src/modules/terminal/lib/terminalSessionApi.ts`, `src/modules/terminal/index.ts`: `whenLeafPaints` reports when a leaf's surface has presented a frame, with a cap so a stalled renderer cannot hold the transition up for ever.
- `src/app/components/SessionOpeningOverlay.tsx`: `sessionTransitionEnabled` is exported, and the layer paints no background of its own, so the middle of a glass window shows the pane surface instead of a slab.
- `src/app/components/WorkspaceSurface.tsx`, `src/modules/terminal/TerminalStack.tsx`: the panes are hidden with `opacity: 0` while the transition covers them, which is what leaves the pane surface visible. `visibility` was wrong twice over: a pane declares its own, which overrode it from above, and hiding it that way unmounted the renderer's canvas, so the pane came back blank at the moment the transition lifted.
- `src/styles/globals.css`: the near-opaque background rule for the transition layer is gone, replaced by the reason it must not be there.
- `src/modules/preview/PreviewPane.tsx`: the preview pane stops laying down opaque backgrounds of its own (the pane, and the sheet behind a loaded page), the same fix and reason the side preview column and the markdown preview already carry: a surface that fills a pane has to let the pane's tint show, or a glass theme shows a slab.

**The local project list: pick a folder, fetch when checking, and pull one row**

- `src-tauri/src/modules/projects/pull.rs` (new): the refusal rule for a pull, with its tests. A branch is only pulled when its upstream carries the same name, and both the command and the frontend ask that one question, so a row that went stale in the list still cannot merge another branch into this one; a differently named upstream is refused by naming both branches.
- `src-tauri/src/modules/projects/commands.rs`, `src-tauri/src/modules/projects/types.rs`, `src-tauri/src/modules/projects/mod.rs`, `src-tauri/src/lib.rs`: `projects_status` takes `fetch` and runs a fetch per row first, recording a failure in the new `fetch_error` field rather than passing off a comparison with whatever the refs said last time, and `projects_pull` fast-forwards one project and answers with the branch it pulled.
- `src/modules/projects/lib/pull.ts` (new), `src/modules/projects/lib/pull.test.ts` (new): the same rule in the frontend in message-key form, so a row can disable its button and say why.
- `src/modules/projects/lib/pickDir.ts` (new): the native folder picker, imported lazily so the dialog plugin stays out of the start-up path.
- `src/modules/projects/ProjectsView.tsx`: the two paste-a-path inputs become one Choose folder button, a check fetches first, and every row carries a pull button that names what it would pull, a mark when that row's fetch failed, and a disabled state with the reason when the branch cannot be pulled.
- `src/modules/projects/lib/types.ts`, `src/lib/native.ts`: the wire gains `fetchError` and `projectsPull`, and `projectsStatus` takes the fetch flag.
- `src/modules/i18n/messages.ts`: the pull strings, the fetch warning, the folder picker and the reworded empty hint, Chinese and English, and the paste-a-path strings they replace.
- `scripts/dev/probes/projects-pull-acceptance.mjs` (new): a lab repository behind its own bare remote, checking that the row reports being behind once the check has fetched, that a differently named upstream is refused both in the interface and by the command, and that the per-row pull then leaves the row clean.

**Both lists gain an owner column, and their columns can be sorted**

- `src/lib/ownership.ts` (new), `src/lib/ownership.test.ts` (new): whether a row belongs to the signed-in account, read from the account name and the repository slug or the folder name. A name that cannot be told apart answers unknown rather than claiming it belongs to somebody else.
- `src/components/ui/sort-header.tsx` (new): the sortable header cell and the sort state both tables cycle, taken out of the project list so the two lists share one.
- `src/modules/projects/lib/rows.ts`, `src/modules/remotes/lib/rows.ts`, with their tests and types: the owner column, and sorting by repository, owner, visibility, language, pushed and description. Pushed sorts on the raw timestamp, because the label on screen is a relative string that orders the wrong way, and visibility sorts public first rather than on the translated label.
- `src/modules/projects/ProjectsView.tsx`, `src/modules/remotes/RemoteReposView.tsx`: the shared header cells and the owner cells in both tables. The project list reads the account once per panel visit, since that costs a `gh repo list`.
- `src/modules/i18n/messages.ts`: the owner labels and the two column headers, Chinese and English.

**Repositories can be created, renamed, described and switched from the list**

- `src-tauri/src/modules/github/repo_admin.rs`: the repository name rules checked locally (GitHub's limits and characters), the arguments a create is made with, and the slug read back from what gh prints instead of assumed, each with tests.
- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/native.ts`: `github_repo_create` and `github_repo_rename`, the latter answering with the new slug because the old name only redirects.
- `src/modules/remotes/lib/repoAdmin.ts`, `src/modules/remotes/lib/repoAdmin.test.ts`, `src/modules/remotes/RepoAdminDialog.tsx`: the same name rules in the frontend, so the rename field says what is wrong before gh is asked, and GitHub's own refusal is shown under the field.
- `src/modules/remotes/NewRepoDialog.tsx` (new): the create form, with visibility, a description, and the gitignore and license templates gh knows.
- `src/modules/remotes/DescriptionDialog.tsx` (new): one field, seeded from the row, so a description is written without opening anything else.
- `src/modules/remotes/RemoteReposView.tsx`: a New repository button, the row menu following a rename to the new slug, a description cell that opens the one-field dialog, and a visibility cell that switches, asking first only in the direction that goes public, since that is the direction that cannot be undone.
- `src/modules/i18n/messages.ts`: the create, rename and description strings, Chinese and English.
- `scripts/dev/probes/create-rename-acceptance.mjs`, `scripts/dev/probes/description-edit-acceptance.mjs`, `scripts/dev/probes/visibility-toggle-acceptance.mjs` (new): the three flows driven through the interface against the real account, with the GitHub side checked outside the scripts.

**A release's title and notes can be edited from its detail**

- `src-tauri/src/modules/github/releases.rs`, `src-tauri/src/modules/github/types.rs`, `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: `github_release_edit` sends both fields every time, so emptying one really clears it, and it goes through the REST call because `gh release edit` cannot take a body the way it arrives; the id is checked locally first.
- `src/modules/remotes/lib/releases.ts`, `src/modules/remotes/lib/releases.test.ts`: a release's stored title is kept apart from the name shown, so an edit cannot read back a display name it invented.
- `src/modules/remotes/ReleasesDialog.tsx`, `src/modules/remotes/ReleaseDetail.tsx`: an edit form in the detail, and the permission read that decides whether to offer it, cached per repository.
- `src/lib/native.ts`: `githubReleaseEdit` and its result type.
- `scripts/dev/probes/release-edit-acceptance.mjs` (new): opens a release, edits it, and checks the toast and the re-read detail.

**The remote repository list moves in beside the local projects**

- `src/app/App.tsx`, `src/app/components/WorkspaceSurface.tsx`: the projects panel gains a two-stop strip with a measured highlight and owns both lists, and the tab is renamed to the list on screen, since the tab chip and the window title should name what is showing. The header button opens the panel on the local list, which is what its icon is for, and switching between the two lists inside the open panel is left alone.
- `src/modules/tabs/lib/useTabs.ts`, `src/modules/tabs/TabBar.tsx`, `src/modules/tabs/lib/tabLabel.ts`, `src/modules/tabs/NewTabMenu.tsx`: the remote-repositories tab kind is gone, along with the planner that opened it, and the panel renames its own tab instead.
- `src/modules/header/Header.tsx`, `src/modules/command-palette/commands.ts`, `src/modules/command-palette/commands.test.ts`, `src/modules/i18n/messages.ts`: one header button and one palette item for the panel, with the remote list's keywords folded into it, Chinese and English.
- `scripts/dev/probes/auth-acceptance.mjs`, `scripts/dev/probes/issues-acceptance.mjs`, `scripts/dev/probes/permission-acceptance.mjs`, `scripts/dev/probes/releases-acceptance.mjs`, `scripts/dev/probes/repo-admin-acceptance.mjs`: the header button title they look for is the new one.

**An opened image no longer lays down a slab of its own**

- `src/modules/editor/EditorPane.tsx`: the viewer that fills the pane for an image, a video, an audio file or a PDF stops painting `bg-background` itself, the same fix and reason the side preview column, the markdown preview, the preview pane and the editor area already carry. A glass theme tints its panes to 0.28, so that opaque background covered the tint and the whole pane read as a different surface than the window around it; a theme that does not tint paints the same colour on the pane itself, so nothing changes there. Measured on the running app with the repository's own `opaque-surfaces.js`: the viewer was the only opaque surface large enough to cover a pane (59% of the window) and is gone.

**A picture opened in the editor really does show its own pixels**

- `src/modules/editor/EditorPane.tsx`: original size says `max-w-none`, because the base layer caps every image at its container's width and a picture wider than the pane was therefore drawn at the same size in both modes. The scrollport that holds the picture centres with `safe center`: plain centring aligns an overflowing picture in the middle of its own box, which leaves its leading edge outside the scrollable range, so the left of a wide picture could not be scrolled to. Measured on the running app: a 1079 x 811 picture was 844 x 635 in both modes before, and is 844 x 635 fitted and 973 x 732 at original size after, with both edges reachable in the scrollport.

**The projects panel opens on the statuses it last read**

- `src/modules/projects/lib/statusStore.ts` (new): the statuses of the last check, kept in memory for this window and in the `statuses` key of `verta-projects.json` for the next one, with a pure validator so a hand-edited or half-written file reads as "nothing remembered" instead of raising.
- `src/modules/projects/lib/statusStore.test.ts` (new): the validator refuses what is not a snapshot and keeps the entries that are, the snapshot comes back from memory and then from disk, the same statuses are not written twice, and a project that left the list has its status dropped on disk as well.
- `src/modules/projects/ProjectsView.tsx`: the panel starts from what it remembers and checks right after; the file is still read, since it can be newer than the copy in memory, and a read that lands after a check has run loses to the check's own stamp. A project that is not in the list yet does not count as "no projects", so the list loading never wipes the remembered statuses. A batch that fails keeps the rows and reports the failure above them, and a project removed from the list has its status forgotten.
- `scripts/dev/probes/panel-state-restore.mjs` (new): proves this on the running app. A marked snapshot is put in the store, the panel's tab is closed and opened again, and the marker has to be on screen while the batch of git reads is still out; the store is then put back and the panel's own check has to settle the rows.

**The repository list opens on the list it last read**

- `src/modules/remotes/lib/listStore.ts` (new): the last `ready` repository list, in memory for this window and in `verta-remotes.json` for the next one. A read that describes this machine rather than the account (gh missing, nobody logged in) is held in memory only, so the next window still opens on the last real list and then finds out for itself.
- `src/modules/remotes/lib/listStore.test.ts` (new): only a `ready` payload is remembered, a state of this machine is never written to disk, and the same object handed to the store twice is written once.
- `src/modules/remotes/RemoteReposView.tsx`: the list is drawn from what it remembers and the gh read runs right after it; a read that came back saying something about the machine, or that failed outright, is reported above the rows it already has rather than replacing them.

</details>


<details>
<summary><strong>2026-10-23</strong></summary>

**A notification-area icon keeps the app reachable, and closing the window can hide it there**

- `src-tauri/src/modules/tray.rs` (new): the notification-area icon. A left click brings the main window back and focuses it; the right-button menu shows the window or asks the page to quit. The menu labels arrive from the frontend, which owns the message table, so the menu is in the interface language from its first paint instead of being hard-coded here. A second command mirrors the close-to-tray preference into an atomic, because the handler that decides what the window's close button does runs in Rust, where the preferences store cannot be reached.
- `src-tauri/Cargo.toml`, `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`: the `tray-icon` feature is on, the module and its commands are registered, and the main window's close request hides the window instead of ending the process while the preference is on.
- `src/app/hooks/useTray.ts` (new): sends the menu labels again whenever the language changes, mirrors the preference into Rust, and forwards the tray's quit request to the page.
- `src/app/hooks/useAppCloseGuard.ts`: the close listener stops the close in both cases and then decides, and it hands out `requestAppQuit` for the tray to call. Stopping the close is not optional: registering that listener is what makes Tauri withhold the close, and the JS side destroys the window by itself when a handler does not stop it, so a handler that returned early would have hidden the window and then destroyed it, ending the app.
- `src/app/hooks/useTaskbarPresence.ts` (deleted), `src/app/hooks/useAgentAttentionFlash.ts`, `src-tauri/src/modules/taskbar.rs`: the permanent taskbar button is gone, since the tray is what keeps the app reachable and that preference only ever added a button. The flash for a waiting or finished agent is unchanged.
- `src/modules/settings/store.ts`, `src/settings/sections/GeneralSection.tsx`: a close-to-tray preference replaces the permanent-button one, on by default.
- `src/modules/i18n/messages.ts`: the tray menu labels and the preference, one in Chinese and one in English each.
- Verified on the running app with the help of the window manager: with the preference on, the close button leaves the window hidden and the process running, three times in a row, and the hidden window can be brought back; with it off, the close button ends the process, after nothing was left unsaved.

**Issues can be deleted**

- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: a new `github_issue_delete` command removes an issue through `gh api --method DELETE repos/{slug}/issues/{number}`, with the same local validation and error classification the other write commands use.
- `src/lib/native.ts`, `src/modules/remotes/IssueDetail.tsx`, `IssuesDialog.tsx`: the action bar gets a Delete button, only on a plain issue. GitHub offers no way to delete a pull request, so those still only close. It goes through the confirmation dialog the other writes use, and once it lands the detail closes and the list reloads, because the item is gone.
- `src/modules/i18n/messages.ts`: four strings, Chinese and English.

**A keyboard shortcut for the screenshot**

- `src/modules/shortcuts/shortcuts.ts`, `src/app/App.tsx`: `Alt+A` grabs a region, next to the header button. It sits in the General group, so it appears in Settings, Shortcuts, General with the others, and Alt is a chord the shell never claims, so it also works from a focused terminal.
- `src/modules/i18n/messages.ts`: one string, Chinese and English.
- `src/modules/shortcuts/shortcuts.test.ts`: asserts the binding is Alt+A.
- `src/app/App.tsx`: `startScreenshot` moved above the shortcut table. The binding is wired there, and a declaration further down the component is used before it is initialized.

**English mode stopped leaking Chinese in the source-control and remotes panels**

- `src/modules/source-control/SourceControlPanel.tsx`: the repository and branch label was built in a `useMemo` whose dependency list left out `t`, under a comment claiming those three strings do not depend on the language. Two of them are translations, so the label kept the previous language until something else happened to change. `t` is a dependency now.
- `src/modules/launcher/lib/relativeTime.ts`, `src/modules/remotes/lib/rows.ts`, `issues.ts`, `releases.ts`, `runs.ts`: `relativeTime` took an optional language that defaulted to Chinese, and the remotes row builders never passed it, so every time column (remote repositories, issues and pull requests, releases, CI runs) stayed Chinese in an English UI. The argument is required now, so a caller that forgets it fails to compile instead of quietly rendering the wrong language.
- `src/modules/remotes/RemoteReposView.tsx`, `IssuesDialog.tsx`, `ReleasesDialog.tsx`, `RunListDialog.tsx`, `RunDetail.tsx`: they read the language from `useLanguage()` and pass it into those builders.
- Six new tests assert the English wording of each builder. The existing assertions are unchanged apart from the extra argument.
- Verified on the running app with the interface set to English: the source-control selector reads Source Control, and the repository list shows English wording and dates. The only Chinese left on screen is repository descriptions, which is text from GitHub rather than interface copy.

**PR review: approve and request changes**

- `src-tauri/src/modules/github/commands.rs`, `issues.rs`, `lib.rs`: a new `github_pr_review` command posts a review through `gh api --method POST repos/{slug}/pulls/{n}/reviews`, with `approve` / `request_changes` mapped to GitHub's `APPROVE` / `REQUEST_CHANGES` and an optional comment. The verb is validated locally the way the merge path validates its method, and any failure carries what `gh` said. Two unit tests cover the mapping and the payload (a blank comment is left off the payload rather than sent as an empty string).
- `src/lib/native.ts`, `src/modules/remotes/IssueDetail.tsx`, `IssuesDialog.tsx`: the PR block gets a Review group with Approve and Request changes beside the merge controls, shown only while the pull request is open. Both go through the same confirmation dialog the merge uses, plus an optional comment box.
- `src/modules/i18n/messages.ts`: ten strings, Chinese and English.
- Verified on the running app against a throwaway pull request in this repository: both actions were driven from the real UI and both landed on GitHub (one approved review and one changes-requested review, each carrying the typed comment). The app could only do that while signed in as a second account, because GitHub does not let an author review their own pull request; that account's collaborator access was removed right after, and the repository was never made public.

**PR detail lists the checks one by one**

- `src-tauri/src/modules/github/types.rs`, `issues.rs`: `CheckSummary` now carries the rows it was already counting (`CheckItem`: an id, a name, the state, a link), and the per-row verdict moved into a single `CheckRow` value that both the rows and the counts go through, so the list and the summary cannot disagree. No new request: the pages that were already fetched supply them. The `partial` rule is untouched (a page short of `total` still reports `partial`, never a pass), and three tests cover the list, the fallback name and that rule.
- `src/lib/native.ts`, `src/modules/remotes/IssueDetail.tsx`: the PR block lists the checks under the summary badge in a scrollable list, with the same colours the badge uses. Read only, no actions.
- `src/modules/i18n/messages.ts`: six strings, Chinese and English.
- Verified against a public pull request that has checks (read only, nothing written): seven rows came back for a total of seven, every row carried a link, and the row states matched the summary counts exactly.

**PR detail lists the commits**

- `src-tauri/src/modules/github/commands.rs`: `read_issue_detail` already asks the pulls endpoint speculatively (a plain issue 404s, and that is ignored). When it comes back, one more `gh api "repos/{slug}/pulls/{n}/commits"` runs and the result is attached. Any failure there leaves the list empty instead of failing the page, the way the comment fetch already behaves.
- `src-tauri/src/modules/github/types.rs`, `issues.rs`: `PullRequestCommit` (sha, first line of the message, author, html url) and `IssueDetail.commits: Option<Vec<...>>`, following the convention `checks` set (None means unavailable, Some of an empty list means this PR has none). The author falls back to the git name when a commit is not linked to an account, and an entry without a sha is dropped. Two unit tests cover both.
- `src/lib/native.ts`, `src/modules/remotes/lib/issues.ts`, `src/modules/remotes/IssueDetail.tsx`: the PR block lists the commits under the check summary, one per line with the short sha, the first line of the message and the author. One page of a hundred is read; when the cap is reached the heading says so and carries the count.
- `src/modules/i18n/messages.ts`: two strings, Chinese and English.
- Gates are green: cargo test --lib 715 passed with the two new cases, clippy with -D warnings, tsc, biome and the build. Verified on the running app against a throwaway PR in this repository (two commits, opened for the check and closed right after): the detail payload carries both, each with the sha, the first line of the message, the author and the commit url, and the check summary sitting next to it is unchanged.

**Opening a folder from Explorer does something now**

- `src/lib/launchDir.ts`: `get_launch_dir` drains its state, so that one call is the only place that can tell a folder passed as an argument apart from the remembered workspace; it keeps that flag now.
- `src/app/App.tsx`: a folder argument opens a terminal on it once the spaces restore is done, unless a terminal is already open there, the same way a launch file is opened. The Explorer verb in `installer-hooks.nsh` runs `verta.exe "%V"`, so right-clicking a folder lands in that folder instead of only setting where the next session would start; the restored tabs used to win, which is why the click looked like it did nothing.

**Lint: the baseline warnings are gone**

- Twenty-five files under `src/` carried the 67 warnings that came in with the upstream baseline import (`1cd3921`). They are all cleared, so `pnpm lint` reports nothing at all now. Twenty-two were real fixes: optional chains, template strings, `indexOf`, two `while ((m = re.exec(t)))` loops written as `for` loops, three `reduce` blocks that accumulated into an object written as `Object.fromEntries`, a dependency in `GitDiffPane` that could not change on its own, and a `{}` in `settings/store.ts` narrowed to `Record<string, never>`.
- Forty-five could not be fixed without changing behaviour and carry a `biome-ignore` with the reason, which the repository already used in seven places: seventeen `useExhaustiveDependencies`, where adding the entry would re-run the effect on every render, which is exactly what the code avoids; the a11y warnings on chips and rows that live inside a button, where a real `button` would nest and a `tabindex` would take DOM focus off the control that owns the keyboard; and three `noArrayIndexKey` on lists whose items have no identity of their own and are never reordered.
- No interface changed. `tsc`, the build, the 1981 frontend tests, `cargo clippy --all-targets -D warnings` and the Rust tests are green.

**Theme validation messages come from the message tables**

- `src/modules/theme/validateTheme.ts`: the validator returned whole English sentences, so a bad theme file showed English whatever the interface language was. It returns a message key plus its values now (`ValidationFailure`), and the path building, the accepted ranges and the order in which fields are checked are unchanged.
- `src/modules/theme/themeFiles.ts`: the invalid-JSON case returns the key too, while a parser message is still passed through verbatim, since that is runtime data rather than copy.
- `src/settings/sections/ThemesSection.tsx`: the import error resolves the key when it renders, so it follows the language.
- `src/modules/theme/validateTheme.test.ts`: the assertions that pinned the sentences now pin the keys.
- `src/modules/i18n/messages.ts`: fifteen new strings, one in Chinese and one in English each.
- Verified on the running app by feeding a broken theme file straight to the import input: the dialog shows the localized message for an id that is not kebab-case, with no English left in it.

**Window titles and one tooltip follow the language**

- `settings.html`, `screenshot.html`: the static titles joined `Verta` to `Settings` / `Screenshot` with an em-dash, which `VERTA.md` forbids, and were English either way. They carry the neutral app name now, and the settings window sets its own title from the message table at runtime so it follows the language (`capabilities/default.json` covers that window with `allow-set-title`). The screenshot overlay cannot do the same (`capabilities/screenshot.json` gives it events only, and the window is frameless, out of the taskbar and invisible in practice), so it keeps the title Rust gives it in `src-tauri/src/modules/screenshot/mod.rs`.
- `src/modules/tabs/lib/useWindowTitle.ts`: the main window title joined the project and the tab with an em-dash; it is a middle dot now.
- `src/modules/statusbar/CwdBreadcrumb.tsx`: the more button in the collapsed path took the show-hidden-folders string for its tooltip; it has its own string now.
- `src/modules/i18n/messages.ts`: three new strings (the two window titles and the more-paths tooltip), one in Chinese and one in English each.

**Helper windows do not outlive the main window**

- `src-tauri/src/lib.rs`: the settings window and the screenshot overlay hide instead of destroying, so they can be reopened without rebuilding the webview. Since they hide rather than close, something else has to end them, and the handler that destroyed the settings window when the main window went was macOS-only, so on Windows closing the main window left `verta.exe` running with nothing on screen. That handler now destroys both windows and exits, on every platform but macOS, which keeps an app alive with no window open by convention. It acts on `Destroyed`, so it fires when the window is really gone rather than when its close button was pressed, which now only hides it by default.

**Repo panels reuse a recent read instead of asking again**

- `src/modules/remotes/lib/listSnapshot.ts` (new): a small time-boxed cache keyed by what was read (repo, plus the state filter for issues), so a list is served again while it is younger than two minutes (ten for the permission answer, which changes when the user changes it rather than while they browse). The panels drop a key when they change something themselves, so an action never leaves a stale list behind.
- `src/modules/remotes/RunListDialog.tsx`, `src/modules/remotes/IssuesDialog.tsx`, `src/modules/remotes/ReleasesDialog.tsx`: reopening the same repo paints from that read instead of spending the requests again; the run list still reports to the row's CI badge from the cached payload. Issues needed the filter in the effect's dependencies, since the cache is keyed by it.
- `src/modules/remotes/lib/listSnapshot.test.ts` (new): keys stay apart, entries expire at the TTL, forgetting forces a re-read, and a stored falsy value is still a hit.

**Taskbar: a flash when an agent needs you**

- `src-tauri/src/modules/taskbar.rs` (new): flashes the window's taskbar button: until the window comes to the front for "an agent is asking", a fixed handful of times for "finished". Whether the window gets a button at all is the shell's call and no longer a setting here, since the notification-area icon is what keeps the app reachable.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`: the module and its command registered.
- `src/modules/terminal/lib/agentAttention.ts` (new): decides "waiting for an answer" and "finished" from the two things visible outside an agent's full-screen UI: the leaf's cumulative output bytes and whether the shell still has a child process. The CLI repaints while it works, so four seconds of silence with the child alive is a wait; the child disappearing is a finish. None of the CLIs announce this themselves.
- `src/app/hooks/useAgentAttentionFlash.ts` (new): samples the tabs that were opened for an agent, once a second, and flashes the taskbar button.
- `src/modules/settings/store.ts`, `src/settings/sections/GeneralSection.tsx`: a preference for the flash, on by default. The switch is only shown on Windows, where it does something.
- `src/modules/i18n/messages.ts`: its label, one copy in Chinese and one in English.

**Chinese text keeps its own font when the font changes**

- `src/lib/fonts.ts`: the fallback chain ends in an explicit CJK run before the generic `monospace`: Windows (Microsoft YaHei UI / YaHei / DengXian / Sarasa Mono SC), macOS (PingFang SC / Hiragino Sans GB), Linux (Noto Sans CJK SC / Noto Sans Mono CJK SC / Source Han Sans SC / WenQuanYi Micro Hei). Code fonts such as Cascadia Mono carry no Han glyphs, so without that run the browser chose a system face for Chinese by itself: changing the font moved the Latin text and left the Chinese untouched, and mixed lines stopped lining up. The terminal stack and the editor family are both built from this one chain.
- `src/lib/fonts.test.ts`: reads the chain from the module instead of keeping a copy, and asserts the CJK faces are named and come after the Latin pick.

**Explorer drag: Ctrl copies, and the pane header accepts drops**

- `src/modules/explorer/lib/useExplorerDnd.ts`: the modifier is read while the pointer moves (so the ghost can say which mode is armed) and read again at drop time; `Ctrl` / `Cmd` copies through a new `onCopy` callback, a plain drag still moves.
- `src/modules/explorer/FileExplorer.tsx`: `onCopy` goes through the same `fs_copy` path and conflict handling as paste and refreshes the destination; the header row of the pane is now a drop target that resolves to the root, so items can be dragged back up when the root's rows are scrolled away. The drag ghost shows the copy mode.
- `src/modules/i18n/messages.ts`: one key for the copy label on the drag ghost.

**Comments across the code base are in English**

- The whole source tree, `src/`, `src-tauri/src/` and `scripts/`, had its comments translated to English. Code, string literals, identifiers and data (benchmark payloads, language names, the string tables) are untouched; only the prose in comments changed.
- `CHANGES.md`: this file is in English now.
- A second pass finished the leftovers: 26 files still carried a Chinese comment the first pass missed. `src/modules/theme/themes/themeNames.ts` had a whole block (the names-versus-descriptions rule), the rest were one or two explanatory lines in twenty test files, and there were the four in `.gitignore`, the block in `screenshot.html`, one in `src-tauri/Cargo.toml` and two trailing comments in the Rust crate (`screenshot/encode.rs`, `workspace.rs`). Same rule as before: only the prose in comments changed, no string, identifier or fixture data.

**Chinese strings still hardcoded in the session list moved into the message tables**

- `src/modules/i18n/messages.ts`: added the strings the session list still hardcoded (empty list, sub-agent badge, the five context-menu items, the copy-succeeded toast, rounds / tokens / relative time), one copy in Chinese and one in English.
- `src/modules/launcher/components/SessionList.tsx`, `src/modules/launcher/lib/sessionStats.ts`, `src/modules/launcher/lib/relativeTime.ts`, `src/modules/launcher/components/LauncherPanel.tsx`, `src/modules/projects/ProjectsView.tsx`: now go through the message tables; the formatting functions take an extra locale argument (Chinese by default, and the pure formatting logic is still callable directly).
- Chinese wording unchanged (verified on the running app: `99 轮 · 652 M tokens · 刚刚`, `13 分钟前`); no Chinese leaks through once the locale is switched.

**Theme page item renamed to "session start transition"**

- `src/modules/i18n/messages.ts`: the title goes from "会话打开过渡" to "会话开启过渡", and the description's "开启会话" follows (English `Session start transition`). The item is about the moment a session starts, not about the act of clicking it open.

**A session can no longer be deleted once its project directory is gone**

- `src-tauri/src/modules/agent_sessions/opencode.rs`: deletion goes through opencode's own command, and that command has to run inside the directory recorded on the session (it locates the session by working directory). When the project is deleted but the session row remains, that directory no longer exists and the launch fails at the OS layer (Windows: "The directory name is invalid"), so the session can never be deleted. Now the recorded directory is used when it still exists and a temporary directory is used when it does not: the command only finds the session by id, with or without that directory.

**Session opening transition: four animations, chosen on the theme page in settings**

- `src/modules/settings/store.ts`: new preference `sessionTransition` (`ripples` / `pulse` / `orbit` / `bars` / `none`, default `ripples`), plus `coerceSessionTransition` to fall back to the default for an unrecognized older value.
- `src/app/components/SessionOpeningOverlay.tsx`: draws a different animation per preference: ripple spread / concentric pulse / orbiting glow / bar bounce; with `none` the whole layer is not drawn (the command written into the terminal stays visible as before).
- `src/styles/globals.css`: styles for the three new animations, under the same constraints as the ripple (transform / opacity only, fixed iteration count, not played under `prefers-reduced-motion`).
- `src/settings/sections/ThemesSection.tsx`: the theme page gains a "session start transition" dropdown.
- `src/modules/i18n/messages.ts`: one key in Chinese and one in English.

**The delete-session dialog no longer names opencode / pi**

- `src/modules/i18n/messages.ts`: `launcher.deleteBody` drops the "(opencode N, pi N)" part, and the two notices no longer name the tool, only the consequence (child sessions / artifact directory go with it): naming a tool in the copy means growing the sentence every time an agent is added.
- `src/modules/launcher/components/LauncherPanel.tsx`: those two notices are now appended **only when a session of that kind is actually part of this batch** (previously both were always concatenated regardless of the selection), and the two now-unused count placeholders are gone.

**Opening a session no longer shows the command being typed into the terminal; it shows a centered transition instead**

- `src/app/components/SessionOpeningOverlay.tsx` (new): a centered transition layer: three ripples spread outward in sequence, the app icon in the middle, with the icon jolting as it appears (shrink, overshoot, settle). The old behavior wrote the resume command straight into the terminal, and that line being painted is exactly what "someone typed the command for you" looks like.
- `src/app/App.tsx`: both places that open a session (clicking one in the session list, and "open with an agent" on a project row) cover the terminal with this layer while opening the tab; it is removed **after the agent UI has painted**: the leaf's cumulative output bytes are sampled once before writing the command, and the layer is removed when both "the shell has a child process (`leafHasForegroundProcess`)" and "another 900 bytes were painted" hold, capped at 8 seconds with a hard fallback at 8.5 seconds. Watching the process alone is not enough: the agent takes another second or two to paint its first frame, and removing the layer too early exposes the terminal with the command just typed into it. "Output went quiet" does not work either: a live TUI repaints constantly (measured: never quiet for 420ms), so the criterion is **cumulative** output rather than quiet duration.
- `src/app/components/WorkspaceSurface.tsx`: the layer is drawn **inside the terminal layer** and covers only that area, not the whole screen: the only thing that needs hiding is that one command line, so the sidebar, tab bar and status bar stay visible.
- `src/modules/terminal/ghostty/useGhosttyTerminalSession.ts` + `src/modules/terminal/lib/terminalSessionApi.ts`: the terminal side tracks one more counter, cumulative output bytes per leaf (`leafOutputBytes`), feeding the criterion above; it is cleared when the session is destroyed.
- `src/styles/globals.css`: styles for the transition layer. Only transform / opacity are animated (anything that adds a compositing layer hits the compositing budget), soft edges come from radial gradients; the ripple iterations are fixed rather than an infinite loop: the global animation budget only allows infinite animations to use step timing. One ripple cycle is 1.9 seconds and the icon jolt is 0.85 seconds; no animation plays under `prefers-reduced-motion`.

**The side-by-side preview column no longer lays down its own 60% background**

- `src/modules/editor/SidePreview.tsx`: the column hardcoded `bg-background/60`. In opaque themes it is invisible (same color as the panel); in glass themes it is a different story: the panel gives a 0.28 tint and this layer piles 0.6 on top, so it is visibly heavier than the editor next to it and the side-by-side preview does not look like the same UI. The layer is gone, the background is left to the panel it sits in, and the boundary with the editor is the border on the left.

**Markdown "rendered / source" and the "preview" button at the editor's bottom right merged into one three-way control**

- `src/modules/markdown/MarkdownViewToggle.tsx`: the control goes from two states to three (rendered / source / preview), single-select; the "preview" state is only drawn on the editor side (side-by-side preview belongs to the editor, and it is not present when a whole page is rendered).
- `src/modules/editor/EditorPane.tsx`: the "preview" button at the bottom right is removed: document files (Markdown) are handled by the control above, while files with no view toggle such as images keep the original button. The control now receives the side-by-side preview on/off state so it can be drawn in the same group.
- `src/modules/editor/EditorStack.tsx`: Markdown tabs wire the side-by-side preview toggle into the control; choosing "rendered" or "source" collapses the side-by-side preview first, so the three states really are single-select.

**Settings window texture uses the same values as the main window and covers the whole page**

- `src/styles/globals.css`: `.settings-shell` in the settings window hardcoded an 82% background, heavier than the main window frame (`--frame`, 55% when Mica is on), so the same texture came out at a third of its strength there (measured: about 3 per-channel variation in the settings window margins vs about 11 in the main window status bar). It now takes `--frame` directly: same values in both places, the texture covers the entire settings page, and the cards and switches themselves stay solid and readable; with Mica off both go solid together.

**Light appearance: Carbon Fiber's honeycomb texture shows through, Verta stays black**

- `src/modules/theme/themes/pattern-base.ts`: the light-side texture was **white lines with `multiply`**: white is the identity element for `multiply`, so no opacity tweak would ever make that texture show; it now uses dark ink lines with `multiply`, with strength set against the dark side (dark: white lines lift about 22 per channel, light: ink lines knock down about 15).
- `src/modules/theme/themes/verta.ts`: the palette comes from the icon's black background yet flipped to white background with black text in light appearance. Both appearances now share the same near-black palette, and the editor stays dark too: picking this theme is black, regardless of appearance.

**Session tabs: draw the icon of the matching agent instead of always drawing the terminal icon**

- `src/modules/tabs/lib/useTabs.ts`: terminal tabs record an extra `agent` (which agent this tab was opened for); both entry points that create session tabs accept it.
- `src/app/App.tsx`: opening a session passes the session's own tool; the "open with an agent" project row does the same.
- `src/modules/tabs/TabBar.tsx`: the tab icon draws that agent's brand mark when the tab records an `agent`, and the terminal icon as before when it does not (plain terminal, command block, private terminal).
- `src/modules/tabs/lib/serialize.ts`: `agent` is persisted and restored with the tab, so the icon survives a restart.

**Descriptions of the three new themes: each had its own narration, now one line like the others**

- `src/modules/theme/themes/verta.ts`, `src/modules/theme/themes/acrylic.ts`, `src/modules/theme/themes/pattern-base.ts`: all three descriptions were long sentences (with colons or semicolons, and explaining how the material is implemented: blur, noise, whether the panel is solid). Every other entry in the theme list is one short phrase about how it looks, so these three stood out; they are now written the same way.
- `src/modules/theme/themes/themeNames.ts`: the matching Chinese entries are shortened too, and the style rule is written into the file header (a description states only how it looks; origin and implementation stay in comments inside the theme file) so the next one does not turn into narration again.

**Shortcut for closing a tab (terminals included): add a binding the terminal does not swallow, and the settings page draws every binding**

- `src/modules/shortcuts/shortcuts.ts`: `tab.close` gains an additional default binding, `Ctrl/⌘+Shift+W`. When focus is in the terminal the plain `Ctrl+W` never reaches the app: the shell consumes it as `^W` (delete previous word), so closing a terminal tab needs a chord the shell does not recognize; it is also the chord Windows Terminal uses to close a tab. Configs that only bound the plain one are unchanged.
- `src/settings/sections/ShortcutsSection.tsx`: each row in the shortcut list drew only the **first** binding, so the extra one was invisible to the user (`sidebar.toggle` / `view.zenMode` already had two), which created the impression that the shortcut did not exist. Every binding is drawn now, separated by `/`.
- `src/settings/sections/ShortcutsSection.tsx`: the tokens of one binding are keyed by the token itself instead of the array index, which is what the one new lint warning in this change was about.

**Glass themes: the editor area and Markdown preview laid down an opaque background of their own, covering the panel's tint entirely**

- `src/modules/editor/EditorStack.tsx`, `src/modules/markdown/MarkdownPreviewPane.tsx`: `bg-background` removed in both: their parent is the panel (`.verta-pane`), which already paints `--background` under opaque themes (appearance unchanged) and paints its own tint under glass themes, which those two layers were completely covering (measured: 66% of the window area was solid `--background`).

**The two hints at the bottom of the command block: one was fake, one missed translation**

- `src/modules/i18n/messages.ts`, `src/modules/terminal/block/ShellInput.tsx`: the "`{shortcut} 切换到 AI`" part of the input block placeholder is removed: **nothing** in the repository binds that chord (`Ctrl+U` exists neither in the shortcut table nor in the terminal keymap), so it advertised a shortcut that does not exist; the `fmtShortcut` interpolation goes with it.
- `src/app/components/WorkspaceInputBar.tsx`, `src/modules/i18n/messages.ts`: the hint in plain mode was hardcoded English (`Type directly in the terminal`, one spot missed in the i18n pass); it now uses the key `term.typeDirectly` (Chinese and English).

**Preview page and commit graph: no longer carry their own color schemes**

- `src/modules/preview/PreviewPane.tsx`: the preview page background was hardcoded `bg-white` (painted as soon as the address bar holds a URL), a blank white sheet under dark themes; it now follows the theme (`bg-background`). Colors of the previewed page itself are unchanged.
- `src/modules/git-history/lib/graph.ts`: the commit graph lane colors were a hardcoded palette (blue-400 / purple-400 / amber-400 …) that did not change with the theme; they now come from the theme's own terminal palette (`var(--terminal-ansi-*)`): every theme fills in those 16 colors, which are already a set made to be told apart, so the graph now recolors with the theme. The rail is still drawn with `var()` as before (that is how `--background` has always been used there); the browser re-resolves it, no React re-render needed.

</details>

<details>
<summary><strong>2026-10-22</strong></summary>

**Themes: default theme renamed to Terax, plus new "Verta", "Acrylic" and "Carbon Fiber"**

- `src/modules/theme/themes/verta-default.ts`: only the display name goes from `Verta Default` to `Terax` (`id` stays `verta-default`, the colors stay in `styles/globals.css`).
- `src/modules/theme/themes/verta.ts`, `src/modules/theme/themes/acrylic.ts`, `src/modules/theme/themes/pattern-base.ts`: three new themes (each with a dark and a light variant, listed first on the settings page): Verta is black and white after the app icon; Acrylic uses the native Windows 11 acrylic material, with the desktop really showing through; Carbon Fiber is a graphite base with a fine honeycomb grid and solid, opaque panels.
- `src/modules/theme/themes/themeNames.ts`: new, the Chinese theme names and descriptions; the existing themes are covered too (proper names such as Dracula / Nord stay untranslated).
- `src/modules/theme/types.ts`, `applyTheme.ts`, `validateTheme.ts`: themes gain two optional blocks: "surface layer" (base color, texture, opacity, blend mode) and "glass" (frame and panel opacity, highlight strength, whether the desktop shows through too); custom theme JSON accepts both as well.
- `src/modules/theme/SurfaceLayer.tsx`, `src/styles/globals.css`: one more element at the very bottom of the UI dedicated to drawing the surface layer; it is not displayed in themes without a texture and does not block anything; it covers the settings window as well.
- `src-tauri/src/modules/vibrancy.rs`, `src/modules/theme/vibrancy.ts`, `src/modules/theme/WindowVibrancyBridge.tsx`: the window background material gains an "acrylic" option (Windows' `DWMSBT_TRANSIENTWINDOW`, showing more of the desktop than Mica), declared by the theme itself rather than turned on manually in settings.
- `src/settings/sections/ThemesSection.tsx`, `src/settings/components/LspInstallDialog.tsx`, `src/modules/i18n/messages.ts`: "blur" in the theme settings and "checking… / check again" in the language server dialog were hardcoded English and are now Chinese copy (following the UI language).

**Session list: everything in one block sorted by time by default, or grouped by agent**

- `src/modules/launcher/lib/sessionGroups.ts`: new, the grouping and sorting rules (section order follows the tool order, and tool names missing from the list are still listed).
- `src/modules/launcher/components/LauncherPanel.tsx`: an "all / by agent" toggle under the search box, defaulting to "all".

**Session round count and "last conversation time" could not see today's data (newer opencode switched its storage tables)**

- `src-tauri/src/modules/agent_sessions/opencode.rs`: messages are read from the new `session_message` table (newer opencode writes messages there; the old `message` table stopped being updated long ago, so reading only the old table misses the last few days of conversation), falling back to the old table only when the new one is absent; the round count now counts user messages (it used to count all messages, and the assistant sends several per round), and sessions whose messages were cleared but whose tokens remain get an estimated round count from the tokens; tokens were also computed as 0 when every field was empty, fixed here too.
- `src-tauri/src/modules/agent_sessions/wsl.rs`: the equivalent query inside a distro changed the same way.
- `src/modules/launcher/lib/sessionStats.ts`: last conversation time refined to "just now / N minutes ago / 1·3·6·12 hours ago / yesterday / day before yesterday / concrete date".

**Session list: rows show rounds / tokens / last conversation date, context menu copies and renames**

- `src-tauri/src/modules/agent_sessions/stats.rs`: new, the pure logic of session statistics (how pi's usage folds into tokens, and "unknown" rather than 0 when there is none).
- `src-tauri/src/modules/agent_sessions/opencode.rs`, `pi.rs`, `wsl.rs`, `types.rs`, `mod.rs`: the list also carries rounds, tokens and last conversation time (null when unavailable); new `agent_sessions_rename` command (opencode rewrites the `title` column, pi appends a `session_info` line, neither touches any other field).
- `src/modules/launcher/components/SessionList.tsx`, `components/LauncherPanel.tsx`: rows no longer show the path but "N rounds · tokens · last conversation date"; the context menu offers copying the absolute path / relative path / session id and renaming in place.
- `src/modules/launcher/lib/sessionStats.ts`, `lib/sessionPaths.ts`: new; the former holds the display rules for the three numbers (ten thousand and above folded to "万"), the latter computes the path relative to the workspace.

**Session name unreadable (a renamed long Pi session still showed its old name in the list)**

- `src-tauri/src/modules/agent_sessions/pi.rs`: the name is no longer looked for only in the first 8 MB of the file: in a long session the rename line can sit tens of MB in; it now searches backwards from the end of the file and takes the last name.

**Settings window: closing and reopening no longer rebuilds the whole webview**

- `src-tauri/src/lib.rs`: on a close request the settings window now does `prevent_close()` + `hide()` and is reused on the next open (it used to destroy the webview, so every click on Settings reloaded the settings page, slow enough to be reported as a bug). It is still destroyed per the original logic when the main window is hidden or exits.

**Issues / PR: lock the head sha before merging, page through more than 100 checks, a few list fixes**

- `src-tauri/src/modules/github/commands.rs`: the PR merge carries the head sha of the PR as it was when the confirmation dialog opened (the `sha` field): if somebody pushes commits between your confirmation and the request landing, GitHub answers 409 and the raw text is surfaced, so commits you never saw are not merged along; `check-runs` above 100 entries are fetched page by page (up to 10 pages) and counted once all are in.
- `src-tauri/src/modules/github/issues.rs`: new `head_sha_problem` (empty is allowed, a given value must be 40 hex digits), `summarize_check_pages` (state computed once over the merged pages, still `partial` when pages are missing), `checks_page_path` / `checks_have_more` / `count_check_runs`.
- `src/lib/native.ts`, `src/modules/remotes/IssuesDialog.tsx`: the head sha is carried from the detail into the merge; list requests are numbered so a slow response does not overwrite newer results when switching "open / closed"; the empty state speaks to the current filter ("only open ones", "only closed ones", "none at all").
- `src/modules/remotes/lib/issues.ts`: a keyword containing `#` still searches by number (`#20` equals `20`).
- `src/modules/command-palette/commands.ts`, `src/modules/command-palette/types.ts`, `src/modules/i18n/messages.ts`: the disabled reasons in the command palette were hardcoded English (`Last tab` / `Pane limit` / `No workspace root`) and are now i18n keys, so the Chinese UI stops popping English.

**GitHub panel: check status is no longer falsely green, and the merge-blocked reason is no longer hardcoded Chinese**

- `src-tauri/src/modules/github/commands.rs`: fetching `check-runs` now passes `per_page=100` explicitly (GitHub's default page holds only
  30 entries). With 40 checks on a page only the first 30 are seen, and the UI takes "not all seen" for "all passed".
- `src-tauri/src/modules/github/issues.rs`: `parse_checks` records `truncated` (fewer entries received than `total_count`);
  `check_state` gains a `partial`: **when only part was seen and the part that was seen is all green it no longer reports `pass`** (a
  seen failure, or something still running, still takes precedence as `fail` / `pending`). `merge_block_reason` is renamed `merge_block_code` and no
  longer returns a Chinese sentence but a reason code (`merged` / `closed` / `draft` / `conflict` / `computing` / `unknown`).
- `src-tauri/src/modules/github/types.rs`: `CheckSummary` gains `truncated`; `merge_blocked_reason` is renamed
  `merge_blocked` (its content is the reason code, no longer a sentence that can be painted straight onto the screen).
- `src/lib/native.ts`, `src/modules/remotes/lib/issues.ts`: wire and mapping follow; `mergeBlocked()` passes the reason code through,
  `checkTone` accepts `partial` (a neutral color, not green).
- `src/modules/remotes/IssueDetail.tsx`: the merge-blocked sentence is no longer the backend's Chinese string shown verbatim but goes through i18n by code.
- `src/modules/i18n/messages.ts`: new `remotes.issues.checks.partial` and `remotes.issues.mergeBlocked.*`,
  six keys (Chinese and English).

**Acrylic theme: terminal background can be transparent, and the settings window switches window material too**

- `src/modules/terminal/ghostty/gpu/terminalVisuals.ts`, `gpu/ScreenUniform.ts`, `gpu/WebGpuTerminalSurface.ts`, `gpu/WebGpuWindowCanvas.ts`, `gpu/WebGpuTerminalRuntime.ts`, `gpu/shaders.ts`: the terminal background supports transparency. When a theme writes `terminal.background` as a color with alpha, the terminal canvas clears to that alpha (the canvas alpha mode follows the panel's theme background); the two shaders output premultiplied and the glyph pipeline's blend state follows (identical results while opaque). **Colors the app itself sets (TUI blocks, selection, search hits, underlines) stay opaque** and are unaffected by theme transparency; the placeholder background before the terminal's first frame is no longer painted solid under transparent themes either.
- `src/modules/theme/themes/acrylic.ts`: terminal background made fully transparent (glass covers the terminal area), panel and frame tints thinned by one step, name and description switched to English.
- `src/settings/SettingsApp.tsx`: the settings window now renders the component that switches the window background material (it was not rendered, so the settings window was not acrylic while the main window was).
- `src/styles/globals.css`: the settings window root hardcoded `--background` (opaque), inconsistent with `--frame` used by `#root` in the main window, so it stayed an opaque block while the main window was transparent. When the window can show what is behind it (native material / glass theme) it now uses the same layering: the root takes `--frame`, and the `.settings-shell` block takes the panel tint.

**Acrylic material: switch to a blur with an adjustable tint**

- `src-tauri/src/modules/vibrancy.rs`, `src-tauri/Cargo.toml`: acrylic no longer uses DWM's `DWMSBT_TRANSIENTWINDOW` but `ACCENT_ENABLE_ACRYLICBLURBEHIND`. Per Microsoft's documentation the former is the "brightest step" of that material, and in practice the material itself is a **uniform light gray** (window pixels do not vary, the desktop does not show through at all), and adding `DWMWA_USE_IMMERSIVE_DARK_MODE` does not push it; the latter blurs the real content behind the window, with the tint and opacity supplied by us and the theme's `glass` tint layered on top. That attribute is undocumented, so its address is taken from `user32.dll` at runtime and Mica is the fallback when it cannot be resolved; `windows-sys` gains `Win32_Graphics_Dwm` and `Win32_System_LibraryLoader` accordingly.

**Window corners: no more square-cornered material showing through**

- `src-tauri/src/modules/vibrancy.rs`: switching the window material also sets `DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`. The material covers the entire window rectangle, so without rounding on the window itself a square patch of material is left outside each of the four corners.
- `src/styles/globals.css`: the window corner radius is extracted into `--window-radius: 8px`, aligned with DWM's `DWMWCP_ROUND`: a larger CSS radius leaves a crescent of material at the corners.

**Theme names and descriptions: Acrylic / Carbon Fiber use English names**

- `src/modules/theme/themes/themeNames.ts`, `themes/acrylic.ts`, `themes/pattern-base.ts`: Acrylic and Carbon Fiber use English names (same rule as proper names such as Dracula; they refer to the material itself), the Chinese descriptions stay, and the acrylic description now describes the effect.

**Shortcuts: "close tab" is findable from both search entry points**

- `src/settings/sections/ShortcutsSection.tsx`: the shortcut list search compared against **untranslated keys** (label `shortcut.closeTabOrPane`, group id `Tabs`), so in the Chinese UI searching "终端", "关闭" or "标签" gave an empty page and only English like `tab` matched by chance. It now compares what is visible on screen (translated labels and group names) and adds the chord itself (`Ctrl+W`), so both languages work.
- `src/modules/shortcuts/shortcuts.ts`, `src/modules/shortcuts/index.ts`: new `SHORTCUT_ALIASES` (search aliases, not drawn in the UI): close-tab accepts "终端 / 删除 / 关闭 / 标签 / 面板 / terminal / close" and the like. The row is titled "close tab or pane" while users call it "terminal", and comparing titles alone will never find it.
- `src/modules/command-palette/CommandPalette.tsx`, `commands.ts`: the command palette's fuzzy match folds this alias set in by `shortcutId`, so both entry points share one set of aliases.
- `scripts/dev/cdp-key.mjs`: it used to accept only 6 named keys (the comment claiming you could send Ctrl+C with a digit was wrong); it now supports chords like `Ctrl+W` and any letter/digit, and `--match` selects the page (the settings window is a different page, and the default would pick the wrong one).

**On machines without WebGPU the terminal is dead black (the WebGL fallback path was missed)**

- `src/modules/terminal/ghostty/webgl/WebGlCellRenderer.ts`: this fallback path created its `webgl2` context with `alpha: false`, hardcoded the clear color's alpha to 1, had both fragment shaders output non-premultiplied colors, and blended glyphs with `SRC_ALPHA`. So when a theme made the terminal background transparent (acrylic), the canvas stayed an opaque block: on machines that get no WebGPU adapter the terminal can never show the desktop. The context now has alpha and premultiplied; the clear color is given premultiplied from the theme's `backgroundAlpha` (with the default background no rectangle is drawn, so the clear color is the terminal background itself); both fragment shaders output premultiplied and blending uses `ONE`. With alpha 1 this is exactly equivalent to before, so opaque themes are unaffected.
- `src/modules/terminal/ghostty/webgl/WebGlTerminalSurface.ts`: the root element's placeholder background becomes `transparent` when the theme is translucent (matching the WebGPU path) instead of always painting an opaque theme color.
- `VERTA.md`: the sentence about the WebGL fallback having an opaque block now describes the new premultiplied alpha behavior.


**Tabs: the project list tab is now called "local projects"**

- `src/modules/i18n/messages.ts`: `tabs.new.projects` goes from "项目 / Projects" to "本地项目 / Local projects", mirroring the other tab "远程仓库". This single key drives both the tab title and the item in the tab bar's "+" menu, so both change together.

**Preview pane and the "new file" dialog hooked up to i18n**

- `src/modules/preview/PreviewPane.tsx`: the two empty-state sentences, the `Preview suspended` sentence and the `Reload` button were all hardcoded in JSX; they now go through `preview.empty.*`, `preview.suspended.*` and the existing `preview.reload`. The little rounded `Ports` chip inside the empty-state body is split into a before and an after segment (`preview.empty.before` / `.after`) wrapped around it, so both Chinese and English read naturally.
- `src/modules/preview/PreviewAddressBar.tsx`: the `Ports` label in the address bar goes through `preview.ports`.
- `src/modules/editor/NewEditorDialog.tsx`: the title reuses `explorer.newFile`, the description and the two validation messages ("please enter a file name / relative path only") gain `editor.newFile.*`, cancel and create reuse `scm.common.cancel` / `scm.common.create` as the other dialogs do, and "no workspace root" reuses the command palette's `cmd.noWorkspaceRoot`. The validation messages store **keys** rather than sentences (so switching language while the dialog is open follows along); raw error strings thrown back by the backend are still shown verbatim.
- `src/modules/i18n/messages.ts`: the 9 new keys above (Chinese and English, inserted together in one place to keep the conflict surface with another session small).

**Close dialogs: copy of the five dialogs hooked up to i18n**

- `src/app/components/CloseDialogs.tsx`: the five confirmation dialogs (unsaved files, processes still running in a terminal, file already deleted, close to the right / close other tabs, quit the app) had all their copy hardcoded in JSX; it now all goes through `closeDialog.*`, with titles reusing `tabs.unsaved` / `tabs.closeRight` / `tabs.closeOthers` and cancel reusing `scm.common.cancel`. The message table has no plural rules, so this is done as "pick the key by count, and put the fragments in the table too": the two builders (`appCloseMessage` / `closeManyMessage`) return only `{ key, params }`, while the sentences and fragments (`closeDialog.frag.*`) live in the table, so Chinese and English each read naturally without pulling in a plural engine.
- `src/modules/i18n/messages.ts`: 29 new keys (Chinese and English).

**The source control panel on the right does not follow the project (deleting Spaces made "pinned repository" too coarse)**

- `src/modules/source-control/repositoryTarget.ts`: the pinned repository used to be recorded per **environment** (one for the host, one per distro). Before Spaces were removed it was recorded per space, and a space was a project root: after the switch to per environment, changing project within the same environment (the root changed) left the pin on the previous project's repository, so the changes list and commit graph in the right panel stayed on the old repository, which looks exactly like "switched project but nothing followed". It is now recorded per **workspace root** (environment + root path), the same approach as `useFileTree`'s scopeKey in the explorer; new `repositoryTargetScope` does that assembly.
- `src/app/App.tsx`, `src/modules/source-control/index.ts`: use the new scope key; `isRepositoryContextCurrent` now only re-checks that the environment has not changed (the assembly format is guaranteed by `repositoryTargetScope`).
- `src/modules/source-control/repositoryTarget.test.ts`: three cases now assert "bucketed by root", plus a new case turning the reported symptom into a regression test (changing project in the same environment ⇒ follows the context again).

**The screenshot overlay window cannot read its preferences (permission not granted)**

- `src-tauri/capabilities/screenshot.json`: the frontend of the screenshot overlay window needs to read preferences (to color the selection, handles and action bar per the current theme), but this capability file only granted `core:default` and event listening, so every screenshot produced `store.load not allowed on window "screenshot"` and the window's "hide myself if the script crashes" fallback ran its course too. `store:default` is added (matching the main window), and the description now states it accurately: it listens for the arm event and also reads preferences.

**UI copy long tail: tab names, source control panel, Git history panel**

- `src/modules/tabs/lib/useTabs.ts`: fallback tab names used to be English hardcoded inside pure functions: the commit history title (`History · {branch}` / `Git History`), `preview` when naming a preview tab by url fails, and `shell` / `blocks` for terminal and command block tabs. The hook now generates them with `t(...)` before handing them to the planning functions: `planCommitHistoryOpen` now takes `{ repoRoot, title }`, the same approach as `planProjectsOpen`, so the planners stay pure. `t` would be shadowed by the tab array inside `setTabs((t) => ...)`, so the three fallback strings are computed at the top of the hook and the callbacks depend on the strings rather than on `t`.
- `src/modules/tabs/lib/serialize.ts`, `useTabRestore.ts`: the preview fallback name on restore is language-dependent too: only the url is persisted, and the name is computed at restore time. Restore runs once and must not re-run on a language switch, so the copy is read through a ref instead of being put into the effect's dependencies.
- `src/modules/tabs/lib/planCommitHistoryOpen.test.ts`: three cases changed to "the title is supplied by the caller", plus a new case asserting the planner does not invent a title (a Chinese title is passed through as given).
- `src/modules/source-control/SourceControlPanel.tsx`: 21 strings hooked up to `t()` (branch dropdown, status, commit box, file list, context menu and discard confirmation). The `to commit` line under the commit box is now "提交", and `Commit with {shortcut}.` is in the table too (the shortcut itself is a key name and is not translated). Existing `scm.*` keys were reused wherever possible; only genuinely missing ones were added.
- `src/modules/git-history/GitHistoryPane.tsx`, `lib/remoteWebUrl.ts`: 34 strings hooked up to `t()` (table headers commit / subject / author / date / changes, loading and empty states, `Copy SHA` / `Copied`, the author fallback name, the file-count sentence and the `View on GitHub` button group). `normalizeError` takes one more parameter, an already-translated fallback, and `hostLabel` takes an optional set of strings (English by default, so the pure functions and existing unit tests are unaffected).
- `src/modules/i18n/messages.ts`: new `tabs.preview` / `tabs.shell` / `tabs.blocks`, 29 `gitHistory.*` and 18 `scm.*` keys (Chinese and English).

**UI copy long tail (second round): explorer, source control hook layer, settings page and shell, terminal and editor, updater / LSP / preview**

- `src/modules/explorer/**` (18 keys): also fixed the real bug: the **hardcoded `Reveal in Finder` in the search results context menu** was shown on Windows too. Both call sites (the search results menu and the file / root context menus) now branch on platform, `IS_MAC ? t("explorer.revealFinder") : t("explorer.revealManager")`, matching how `SourceControlPanel` does it. The search empty state and "showing partial results", the delete and drag-and-drop item counts, the clipboard and paste / copy / move failure toasts, and the duplicate-name replace confirmation all went into the table.
- `src/modules/source-control/useSourceControlPanel.ts`, `useRepositoryTargeting.ts` (11 keys): the four `pushHint` variants on the push button tooltip (previously hardcoded inside the hook's `useMemo`), the feedback bars after commit / push, "N unstaged files" in the discard confirmation, two toasts, and the fallbacks of the two `normalizeError` calls (changed to take an already-translated fallback parameter, following `GitHistoryPane`). The spot in `useSourceControl.ts` that must not re-run on a language switch reads the copy through a ref; its dependency array is untouched.
- `src/settings/sections/*`, `src/settings/components/LspInstallDialog.tsx`, `src/components/WindowControls.tsx`, `src/modules/statusbar/CwdBreadcrumb.tsx` (39 keys): font weight and cursor shape dropdowns, the recording indicator, theme import failure, the eight states of the update button on the about page, the formatter selection, the LSP install dialog, the window controls' `aria-label` and tooltips, and the breadcrumb (home directory / no directory / no subfolders).
- `src/modules/terminal/**`, `src/modules/editor/lib/useDocument.ts` (21 keys): the terminal cannot-display / cannot-start / session-kept error states, block copy and find, the input placeholder (**double spaces preserved exactly**: those two spots are deliberate spacing), the output paused / failed / waiting toasts, and the save conflict dialog. Only those four toasts were translated in `lib/pty-bridge.ts`; invoke command names, protocol fields and the `"running" | "stalled" | "failed"` status enum are untouched (that is the protocol surface). That module is not a component, so it gains an optional `notices` parameter through which the hook passes the current language's strings.
- `src/modules/updater/UpdaterDialog.tsx`, `src/modules/lsp/**`, `src/modules/markdown/**`, `src/components/chat-code.tsx` (46 keys): the eight states of the update dialog, the LSP status card and the crash / exit / start-failure toasts, `LspSessionLabels` for document extensions (module-level code, so a parameter carries the copy, following precedent), the markdown preview's loading / binary / too-large states and the "rendered / source" toggle, and chat-code's generating / sent / run.
- `src/modules/i18n/messages.ts`: 135 new keys (Chinese and English). Existing keys were reused wherever possible (`explorer.revealFinder`, `explorer.loading`, `scm.unknownError`, `lsp.stopped`, `common.copyCode` and others); strings like "Retry" stay local to each module per the repository's "each module emits its own keys" convention.
- Two strings that used to carry an em-dash were normalized along the way: `Check failed - retry` in the settings update failure and markdown's `Binary file - cannot render as markdown.`; the originals used U+2014, conflicting with the repository rule "No em-dash anywhere", and are now hyphens (only that character changed, everything else is verbatim).
- Explicitly **not translated** (all are dead strings with no consumer, protocol surface, or technical diagnostics): `statusLabel` and `stagedEmptyText` / `unstagedEmptyText` in `useSourceControlPanel.ts` (nothing in the repository reads them), the ghostty renderer's internal diagnostic strings, `pty-bridge`'s protocol fields and status enum, the unreachable fallback placeholder in `block/lib/shellEditor.ts` (`ShellInput` always passes `placeholderText`), tool proper names, and unit symbols like `ms` / `px`.

**UI copy long tail (third round): repository-wide scan to fill the gaps**

The previous round was "do the modules on the handover list one by one" ✗, which is why a fair number were missed ✗; this round is **scan-driven** ✓, across nine shapes: bare JSX text ✓, string literals and JSX expressions in `title`/`aria-label`/`placeholder` ✓, `toast(...)` ✓, English sentences in template strings ✓, English strings in object arrays ✓, native `alert`/`confirm` ✓, `sr-only` ✓, static HTML ✓, and strings on the Rust side that reach the UI ✓.

- `src/modules/tabs/TabBar.tsx`: `Rename` / `Close` in the tab context menu were hardcoded ✗ (the same menu already used `tr(...)` for "close to the right" and "close others" ✗) → now go through the existing `tabs.rename` / `tabs.close` ✓. **This is the spot the user reported** ✓, verified on the running app: the menu now reads "重命名标签页 / 关闭标签页 / 关闭右侧所有标签页 / 关闭其他标签页" ✓.
- `src/app/components/WorkspaceInputBar.tsx`: the branch chip's `` title={`Branch: ${branch}`} `` ✗ → `t("workspace.branchChip")` ✓ (that chip only appears on command block tabs ✓).
- `src/modules/preview/PreviewAddressBar.tsx`: `` setNotice(`No server listening on :${port}.`) `` ✗ → `t("preview.noServerOnPort")` ✓.
- `src/app/hooks/useAppCloseGuard.ts`, `useWorkspaceSwitcher.ts`: the window close failure toast ✓ and the native long prompt before switching workspace ✓; the latter reads the copy through a ref ✓ (the callback's identity is used as a dependency by consumers ✗, so it must not change identity on a language switch ✓, following the precedent in `useTabRestore.ts` ✓).
- `src/modules/editor/EditorStack.tsx`, `GitDiffPane.tsx`: `renderedHint="Save to preview"` ✓, diff preview unavailable / binary / file too large / loading diff ✓. The translation function inside `EditorStack` is named `tr` ✓: in that file `t` is already taken by the tab object in `.map((t) => …)` ✓.
- `src/modules/editor/EditorPane.tsx`: **another session's work in progress** ✗, hooked up in this round only after explicit user sign-off ✓. 14 spots: the language server format success / failure toasts ✓, `Binary file` / `File too large` / `Hide preview` / `Show preview` / `Original size` / `Fit to window` ✓, `Loading…` / `Open anyway` / image unreadable ✓. **Only the copy lines were touched** ✓ (the half-finished work in the file is left as is ✓). The key-name parser (`Mod-s` / `Ctrl-g`) and the extension table ✗ are not translated ✓.
- `src/components/ui/*` (shadcn primitives): `breadcrumb`'s `sr-only` "More" and `aria-label="breadcrumb"` ✓, `dialog` / `sheet`'s `sr-only` "Close" ✓, the **visible** `Close` button in `dialog` ✓, and `command`'s two default parameters ✓. **This is a one-time exception hand-editing primitives** ✓ (`VERTA.md` used to say "do not hand-edit" ✗), because screen-reader and visible copy alike have to follow the language ✓, with `spinner.tsx` already using `t("common.loading")` as precedent ✓; `command.tsx` was changed by **dropping the default values and falling back with `?? t(...)` in the component body** ✓ (default parameters do not depend on hooks ✓, signature unchanged ✓). `VERTA.md` now records this exception as a rule ✓.
- `src/modules/i18n/messages.ts`: 29 new keys (Chinese and English ✓), reusing `tabs.rename` / `tabs.close` / `palette.title` / `editor.hidePreview` / `editor.showPreview` / `editor.preview.title` ✓.
- ⚠️ Two things noted in this round and **left for the next one**: ① several groups of **synonymous keys** in `messages.ts` ✗ (`editor.hidePreview` alongside `editor.preview.hide`, and `preview.show` / `preview.hide` / `preview.label` ✗); deduplicating spans several files ✓; ② English coming from the backend ✗ (Rust's `Added` / `Modified` status labels, theme validation strings, the updater's `status.message`, LSP stderr ✗) and the two window titles ✗.

**UI copy wrap-up: synonymous keys and English coming from the backend**

- `src/modules/i18n/messages.ts`: the "editor preview toggle" group of synonymous keys is folded into one pair: `SidePreview.tsx` uses `editor.preview.hide`, while `EditorPane.tsx` used `editor.hidePreview` / `editor.showPreview` (the same English sentence), now unified as `editor.preview.hide` / `editor.preview.show`, and three dead keys **referenced by nothing in the repository** are removed (`preview.hide` / `preview.show` / `preview.label`, the first two being byte-identical in English to `editor.preview.*`).
  ⚠️ **The other ninety-odd groups of synonymous keys are all kept**: they follow the repository's established "each module emits its own keys" convention (7 instances of "cancel", 5 of "retry", 4 of "refresh", 5 of "close"…), and many are **dynamic keys** (`` t(`shortcut.${id}`) ``, `` t(`cmd.${id}`) ``); a static script judging "unused" would misclassify them as dead, so this round **leaves them alone**. The audit script's conclusions (`.superpowers/keys-audit.mjs`, reusable) are recorded in the todo list for later reference.
- `src/modules/editor/EditorPane.tsx`: those two `tr(...)` calls follow to the new keys (`tr` is the translation alias in that file).
- `src/modules/git-history/GitHistoryPane.tsx`: the file row's `title` used to show the **English sentence** passed in from Rust directly (`Added` / `Modified` / `Deleted` / `Renamed` / `Copied` / `Unmerged` / `Untracked`) → the frontend now maps it to `gitStatus.*`, and **values the map does not match pass through as is** (so a future backend status does not turn into a blank). **Not a byte changed on the Rust side**: not touching the backend avoids a recompile and restart, the English strings in `status_label_for` / `parser.rs` stay, and the frontend no longer depends on them.
- ⬜ **Not done** this round, left for the next one: ① the validation strings in `src/modules/theme/validateTheme.ts`: it returns **whole English sentences** and `validateTheme.test.ts` asserts exactly those sentences → changing it means changing the return contract plus the tests, worth its own round; ② the updater's `status.message` (a string from the plugin) and the LSP stderr tail (diagnostic data); ③ the two **window titles** (`Verta` and `Settings` joined by an em-dash).

</details>

<details>
<summary><strong>2026-10-21</strong></summary>

**Tabs: drop "spaces" and keep a single tab list**

- `src/modules/spaces/**` (14 files), `src/modules/i18n/spaceName.ts`: the whole module is deleted. A space (name, root
  directory, environment, color scheme, its own tab persistence, `SpaceSwitcher`) was a second way of saying what the
  project list already says, and it forced a space id onto every tab. The two genuinely useful pieces in
  `src/modules/spaces/lib/serialize.ts` and `activeSpace.ts` moved elsewhere (see below).
- `src/modules/tabs/lib/useTabs.ts`: `Tab.spaceId`, `DEFAULT_SPACE_ID`, the per-space deduplication in the various `plan*`
  functions (open file / markdown / git diff / commit history / project list / remote repositories), space deletion and
  cross-space moves are all removed; deduplication, closing and drag reordering now act on one list. **The "the last tab
  refuses to close" semantics is kept** (`nextActiveInSpace` is therefore renamed `nextActiveTab`), and private tabs still do
  not get persisted.
- `src/modules/tabs/lib/serialize.ts` (moved over from the spaces module, minus `spaceId`), plus new `tabStorage.ts` and
  `useTabRestore.ts`: the tab list is now stored as a single `state` key in `verta-tabs.json`. On the first launch with the
  new format, the `state:<space id>` of the then-active space is read from the old `verta-spaces.json`, written into the new
  file and that key is deleted, leaving the old file on disk; restore still requires each tab to return to its own
  environment (leaves record the environment, tabs that only recorded a cwd are inferred from the path), and a cwd is
  authorized before the terminal opens. `usePreferencesStore.init()` is still called in exactly one place, and disk writes
  are still held back until restore finishes.
- `src/app/App.tsx`: space state, `SpaceSwitcher`, the six handlers that only fed it, the three space shortcuts, the five
  space commands in the command palette and "clicking a project row = switch to a space rooted at that project" are all
  gone. A project row now does one thing: switch to that project's environment (host / distro) and open a terminal at the
  project root.
- `src/modules/header/Header.tsx`: the slot reserved for the switcher in the title bar is removed.
- `src/modules/source-control/repositoryTarget.ts`, `useRepositoryTargeting.ts`: the repository pinned in the right panel is
  recorded per **environment** (host / a given distro) rather than per space.
- `src/modules/control/lib/context.ts`, `useControlBridge.ts`: `space_id` is kept but fixed to `default`:
  `verta-cli identify` prints it, and removing it would change the protocol.
- `src/modules/i18n/messages.ts`: the 14 space keys in both Chinese and English (`spaces.*`, `shortcut.nextSpace` /
  `prevSpace` / `openSpaces`, `cmd.spacesOverview` / `newSpace` / `switchToSpace` / `currentSpace`,
  `cmdGroup.Spaces`, `shortcutGroup.Spaces`) are deleted.
- `src/modules/shortcuts/shortcuts.ts`, `src/modules/command-palette/commands.ts`, `types.ts`,
  `CommandPalette.tsx`: the space shortcut group, the space commands and `spaceName` are cleared out too.

**Area screenshot: no screen freeze like the system tool, and the capture happens on save**

- `src-tauri/src/modules/screenshot/mod.rs`: changed to **not freeze the screen**. The screen stays live while the
  selection is being drawn (the overlay window is transparent and only lays down a light gray wash), and the capture moves to
  **the moment save is clicked**: the overlay is hidden first and the capture waits until it has really left the screen
  (`hide()` only hands the request to the OS, that frame is still there), otherwise the gray wash, selection box, handles and
  action bar end up in the image; the whole thing runs on a blocking thread. The window is still **created once and kept**
  (each use only shows it: about 0.4 seconds to build the webview the first time, just over 0.1 afterwards); on failure the
  window is shown again with the selection intact, so it can be adjusted and saved again.
- `src-tauri/src/modules/screenshot/capture.rs`: new `virtual_screen_bounds()`: the capture and the overlay window take
  their extent from the same place, so selection coordinates line up. `RawShot` no longer carries an origin (the overlay
  position comes from that same place).
- `src-tauri/src/modules/screenshot/encode.rs`: the BMP preview encoder is deleted (there is no preview file any more); only
  the PNG that gets saved remains.
- `src/modules/screenshot/ScreenshotOverlay.tsx`: **canvas and frozen frame removed**. A 25% light gray wash covers the
  screen; as soon as a selection is drawn the wash goes away and a shadow around the selection darkens the outside: the
  inside is a fully transparent hole, showing the live screen behind it (this is the point of "like the system tool": no
  freeze, the screen keeps moving). A corner-radius slider (0-40, default **15**, WYSIWYG) and two icon buttons for save /
  cancel sit at the bottom right of the selection; stroke, handles and buttons take theme colors. After releasing the mouse
  the selection stays adjustable: drag the whole block, resize with the eight handles. Enter saves, Esc cancels, unchanged.
- `screenshot.html`, `src/screenshot/main.tsx`: this window **must be transparent**: both spots paint the background
  transparent according to the window's nature (globals.css gives body a theme background) and add the `.light` / `.dark`
  classes (`--primary` and friends cannot resolve without that class on the root, and the stroke would fall back to gray). Also:
  if the window's own script crashes, it calls `screenshot_failed` to hide itself rather than leaving an unclickable gray
  layer in front of the user.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: `screenshot_begin` no longer returns the captured image; `screenshot_pending` /
  `screenshot_pixels` are deleted (neither the preview file nor shipping pixels over IPC is needed any more); the completion
  copy is in a more formal tone (no more "it is in the clipboard too", and the Rust-side error strings changed with it).
- `src-tauri/capabilities/screenshot.json`: showing and focusing are done by Rust now, so the overlay window's permissions
  shrink to "listen to events only".
- `scripts/dev/probes/`: the acceptance probes follow: `screenshot-arm-timing-*` (measures "message received to first
  frame"), `capture-desktop.ps1` (captures the whole screen as evidence; `CopyFromScreen` and the window's own CDP screenshot
  are not the same thing), `screenshot-begin-timing.js` (measures only "click to gray wash appearing").

**Area screenshot: capture, select, save and clipboard all inside the app**

- `src-tauri/src/modules/screenshot/` (a new module, four files):
  - `capture.rs`: Windows captures the whole virtual desktop with GDI. GDI returns BGRA with garbage alpha, which is
    filled in as opaque RGBA: without that, the saved PNG and the clipboard image are semi-transparent; other platforms
    refuse honestly instead of pretending to work.
  - `geom.rs`: selection snapping (dragging back and dragging off-screen are handled correctly), cropping by selection, file
    names and local timestamps. All pure functions with unit tests.
  - `encode.rs`: PNG encoding via the `image` crate already in the dependency tree, with only the `png` feature enabled.
  - `mod.rs`: screenshot state and commands (`begin` shows the overlay window / `finish` hides the window, captures, crops,
    writes to disk, puts it on the clipboard / `cancel` / `failed`). Cropping uses the raw captured pixels: feeding the whole
    screen to the asset protocol and cropping on a canvas would taint it cross-origin and make `toBlob` throw. Cropping is in
    the backend and selection in the frontend, so the backend snaps the selection once more.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`: register the module, state and commands;
  windows-sys gains `Win32_UI_WindowsAndMessaging` (for `GetSystemMetrics` and the virtual screen constants).
- `src-tauri/capabilities/screenshot.json` (new): the overlay window gets its own **minimal** capability: events only, with
  show and focus done by Rust, and none of the store / dialog / opener permissions it does not need.
- `screenshot.html`, `src/screenshot/main.tsx`, `vite.config.ts`: the frontend entry of the second window (a transparent
  window), one more entry in the multi-page build.
- `src/modules/screenshot/ScreenshotOverlay.tsx` (new): light gray wash, drag a box (with a physical-pixel size hint),
  movable and resizable after release, corner-radius slider, save / cancel icon buttons, Enter to save, Esc to cancel; no
  screen freeze: the screen stays live.
- `src/modules/screenshot/lib/selection.ts` (new): CSS pixel ↔ physical pixel conversion: at 125% display scaling the two
  differ by a devicePixelRatio and sending CSS coordinates directly crops off target; rounding is "one column too many rather
  than one too few". With unit tests.
- `src/modules/header/Header.tsx`: a "screenshot" entry appears to the left of the Git button at the top right.
- `src/app/App.tsx`, `src/lib/native.ts`, `src/modules/i18n/messages.ts`: the completion toast (stating where it was saved
  and whether the clipboard worked, reported separately) and "insert path": clicking it inserts the path into the current
  terminal input line with bracketed paste, so spaces in the path are fine, with no automatic insert and no Enter; on tabs
  that are not a terminal the button is not offered at all (there would be nowhere to insert it).
- `scripts/dev/cdp-input.mjs` (new) plus `scripts/dev/probes/` (the probes for this area and `capture-desktop.ps1`):
  send real input to a **specific** window and capture evidence for acceptance. `cdp-key.mjs` only ever finds the first
  page and the overlay window is the second, and mouse dragging also needs a full press/move/release (synthesizing a
  PointerEvent in the DOM will not do: `setPointerCapture` only honors real pointers).

**Pi session list: show the latest session name**

- `src-tauri/src/modules/agent_sessions/pi.rs`: the session name is no longer looked for only in the first 8 MB of the file
  (in a long session the rename line can be tens of MB in; when it was not found the first user message was used); it now
  searches backwards from the end of the file in blocks for `session_info`, takes the last name and reads that whole line at
  the match. The header window drops from 8 MB to 1 MB.

**Markdown preview: small images without a size are no longer stretched into a full-width banner**

- `src/modules/markdown/MarkdownImage.tsx`: images without a height used to be pinned to `height: 260px` (with `object-fit: contain`),
  so a 116×20 badge was blown up into a full-column banner; they now reserve 260px before load and go back to their own size
  once loaded (260px is only a cap). The sizing decision is extracted into a pure function `previewImageStyle`.
- `src/modules/markdown/MarkdownImage.test.ts`: new, covering the four branches.

**Markdown preview: inline images sit on one line again**

- `src/modules/markdown/MarkdownImage.tsx`: image `display` changes from `block` to `inline-block` (with `mr-2 last:mr-0`), so
  several images in one line display side by side with spacing between them.

**Fonts: pick an installed font from a dropdown (terminal and editor share one font)**

- `src-tauri/src/modules/fonts.rs`: new, lists installed font families (Windows GDI `EnumFontFamiliesExW` / Linux `fc-list` /
  macOS `system_profiler`); new command `fonts_list`.
- `src/lib/fontOptions.ts`, `src/settings/components/FontPicker.tsx`, `src/settings/lib/useInstalledFonts.ts`: new; the options are
  "auto-detect" plus installed fonts (the current value is listed and marked even when it is not installed), searchable.
- `src/settings/sections/GeneralSection.tsx`, `src/modules/i18n/messages.ts`: the font row becomes a dropdown, and the
  description states that the terminal and the editor share it.
- `src/modules/settings/store.ts`: the default for `terminalFontFamily` changes from empty to `Cascadia Code` (stored values
  are untouched).
- `src/lib/fonts.ts`: the terminal font stack is "selected font → auto-detected Nerd Font (icons) → fallback chain".
- `src/modules/editor/lib/useApplyEditorFontFamily.ts`, `src/modules/editor/lib/extensions.ts`: the editor font goes through the
  `--editor-font-family` variable.
- `src-tauri/Cargo.toml`: `windows-sys` gains the `Win32_Graphics_Gdi` feature.

**GitHub: account and sign-in**

- `src-tauri/src/modules/github/auth.rs`: new. Parses `gh auth status --json hosts` (picks the active account, splits scopes,
  does not crash on missing fields), and rejects obviously wrong pasted tokens locally.
- `src-tauri/src/modules/github/gh.rs`: extracts `command()` (arguments passed one by one, interactive prompts off, proxy applied,
  console hidden: all prepared centrally); new `spawn` / `pump` / `run_with_stdin` (a pasted PAT can only come in over stdin);
  new `AUTH_TOKEN_TIMEOUT_SECS` / `AUTH_WEB_TIMEOUT_SECS`.
- `src-tauri/src/modules/github/types.rs`: new `AuthStatusPayload` / `AuthActionPayload` / `AuthLoginProgress`.
- `src-tauri/src/modules/github/commands.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_auth_status` /
  `github_auth_login_token` / `github_auth_login_web` (streams the one-time code gh prints to the UI in real time, cancellable) /
  `github_auth_login_web_cancel` / `github_auth_logout`, plus `AuthLoginState`.
- `src/lib/native.ts`: new wrappers and wire types for those five.
- `src/modules/remotes/lib/auth.ts`: new. Folds the sign-in state into what the UI needs, detects a missing
  `delete_repo` authorization, and pre-checks a pasted token locally.
- `src/modules/remotes/AuthDialog.tsx`: new. Current state / browser authorization (live output of the one-time code,
  cancellable) / paste a PAT (the input is cleared immediately on submit) / sign out (the confirmation states the
  consequences first).
- `src/modules/remotes/RemoteReposView.tsx`: the account in the page header becomes an entry point; a prompt block for "not signed
  in / gh not installed" gains an entry point too; the list is re-read when the panel closes.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `scripts/dev/probes/auth-acceptance.mjs`: new; acceptance script for the account panel (the `--isolated` run exercises
  the "not signed in" flow in a temporary `GH_CONFIG_DIR` without touching the real sign-in state).

**GitHub: repository management (edit description / switch visibility / delete repository) and clone locally**

- `src-tauri/src/modules/github/repo_admin.rs`: new. Reads `gh repo view --json description,visibility,viewerPermission`;
  descriptions over 350 characters are rejected locally; recognizes the recoverable "gh lacks the delete_repo authorization"
  failure.
- `src-tauri/src/modules/github/permission.rs`: new `admin_allowed` (only `ADMIN` counts as administrator; an unknown or
  unresolvable level counts as allowed to change).
- `src-tauri/src/modules/github/types.rs`: new `RepoSettingsPayload` (`can_admin` is still true on failure) and
  `RepoActionResult`.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_settings` /
  `github_repo_set_description` / `github_repo_set_visibility` / `github_repo_delete` (60 second timeout; after the delete request
  it re-queries `gh api repos/{slug}` and only a 404 counts as success; when the delete_repo authorization is missing, the command
  to run is included in the error text).
- `src/lib/native.ts`: new `githubRepoSettings` / `githubRepoSetDescription` / `githubRepoSetVisibility` / `githubRepoDelete`
  and wire types.
- `src/modules/remotes/lib/repoAdmin.ts`: new. `canAdmin` (unresolved / unfetchable counts as allowed to change), the read-only
  prompt key, `isPrivateVisibility`, the "type the full name" check for deleting a repository, the description length, and the
  adjacent-path guess for a clone target directory.
- `src/modules/remotes/RepoAdminDialog.tsx`: new. Description saving, visibility switching (each of public / private gets its own
  consequence confirmation) and a danger zone (the delete button only appears once the full repository name is typed; after
  deletion the result is reported back so the list can drop that row); none of the three entry points render for non-admins.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "clone locally…" and "repository settings…"; a successful description /
  visibility change updates only that row; the clone and settings dialogs are wired in. Also fixed: the menu content is portalled to
  the body by Radix, but React events still bubble along the component tree, so clicking a menu item also triggered the row click
  (and "repository settings…" therefore also opened the runs panel): intercepted on the menu content.
- `src/modules/remotes/RunListDialog.tsx`: fixed: the confirmation dialog (AlertDialog) is another Radix layer, and clicking it was
  taken by the layer above as "clicked outside the panel", closing the panel too; it no longer closes while the confirmation is open.
- `src/modules/projects/CloneRepoDialog.tsx`: optional prefilling of the URL and target directory (used when entering from a remote
  repository row).
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `scripts/dev/probes/repo-admin-acceptance.mjs`: new; acceptance script for repository management and cloning.

**GitHub: permission gate**

- `src-tauri/src/modules/github/permission.rs`: new. Reads `gh repo view --json viewerPermission`, treating `TRIAGE` / `READ` as
  not writable; an unknown or unresolvable level counts as writable (the button is still offered and GitHub gets to refuse).
- `src-tauri/src/modules/github/types.rs`: new `RepoPermissionPayload`; `can_write` is still true on failure.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_permission` command
  (30 second timeout) and its registration.
- `src/lib/native.ts`: new `githubRepoPermission` and `WireRepoPermissionPayload`.
- `src/modules/remotes/lib/permission.ts`: new. `canWrite` (unresolved / unfetchable counts as writable) and the read-only prompt key.
- `src/modules/remotes/RunListDialog.tsx`: checks that repository's permission once on open; when not writable it does not render
  rerun / cancel / delete and adds a read-only note.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the read-only note.
- `scripts/dev/probes/permission-acceptance.mjs`: new; acceptance script for the permission gate.

**GitHub: releases and asset downloads**

- `src-tauri/src/modules/github/releases.rs`: new. Parses the release list, pre-checks asset file names on disk, thresholds progress
  coalescing, renames `<name>.verta-part` only on success (on failure only the temporary file is deleted), and keeps a per-id cancel flag.
- `src-tauri/src/modules/github/types.rs`: new `RepoRelease` / `RepoReleaseAsset` / `RepoReleasesPayload` / `ReleaseDownloadProgress` /
  `ReleaseDownloadResult`.
- `src-tauri/src/modules/github/commands.rs`: new `github_releases`; new `github_release_download` (streams gh output, 45 second stall and
  30 minute total timeout, a byte count that does not match the asset size counts as failure, progress emitted over
  `verta://github-download`) and `github_release_download_cancel`.
- `src-tauri/src/modules/github/mod.rs`, `src-tauri/src/lib.rs`: register the new module, the three commands and `DownloadState`.
- `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.lock`: add
  `tauri-plugin-dialog` and `@tauri-apps/plugin-dialog`, with only the `dialog:allow-open` permission granted.
- `src/lib/native.ts`: new `githubReleases` / `githubReleaseDownload` / `githubReleaseDownloadCancel` and wire types.
- `src/modules/remotes/lib/releases.ts`: new. List mapping, size and speed copy, percentages, progress smoothing.
- `src/modules/remotes/lib/pickDownloadDir.ts`: new. Directory picking, defaulting to the system downloads folder and falling back to
  the home directory.
- `src/modules/remotes/ReleasesDialog.tsx`: new. List → detail, with progress events claimed by download id.
- `src/modules/remotes/ReleaseDetail.tsx`: new. Asset rows with download / progress / speed / cancel / open containing folder, and the
  body rendered with a lazily loaded Markdown renderer.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "releases…".
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `README.md`: the feature table gains releases and asset downloads.
- `scripts/dev/probes/releases-acceptance.mjs`: new; acceptance script for releases and asset downloads.

**Area screenshot: no screen freeze like the system tool, and the capture happens on save**

- `src-tauri/src/modules/screenshot/mod.rs`: changed to **not freeze the screen**. The screen stays live while the
  selection is being drawn (the overlay window is transparent and only lays down a light gray wash), and the capture moves to
  **the moment save is clicked**: the overlay is hidden first and the capture waits until it has really left the screen
  (`hide()` only hands the request to the OS, that frame is still there), otherwise the gray wash, selection box, handles and
  action bar end up in the image; the whole thing runs on a blocking thread. The window is still **created once and kept**
  (each use only shows it: about 0.4 seconds to build the webview the first time, just over 0.1 afterwards); on failure the
  window is shown again with the selection intact, so it can be adjusted and saved again.
- `src-tauri/src/modules/screenshot/capture.rs`: new `virtual_screen_bounds()`: the capture and the overlay window take
  their extent from the same place, so selection coordinates line up. `RawShot` no longer carries an origin (the overlay
  position comes from that same place).
- `src-tauri/src/modules/screenshot/encode.rs`: the BMP preview encoder is deleted (there is no preview file any more); only
  the PNG that gets saved remains.
- `src/modules/screenshot/ScreenshotOverlay.tsx`: **canvas and frozen frame removed**. A 25% light gray wash covers the
  screen; as soon as a selection is drawn the wash goes away and a shadow around the selection darkens the outside: the
  inside is a fully transparent hole, showing the live screen behind it (this is the point of "like the system tool": no
  freeze, the screen keeps moving). A corner-radius slider (0-40, default **15**, WYSIWYG) and two icon buttons for save /
  cancel sit at the bottom right of the selection; stroke, handles and buttons take theme colors. After releasing the mouse
  the selection stays adjustable: drag the whole block, resize with the eight handles. Enter saves, Esc cancels, unchanged.
- `screenshot.html`, `src/screenshot/main.tsx`: this window **must be transparent**: both spots paint the background
  transparent according to the window's nature (globals.css gives body a theme background) and add the `.light` / `.dark`
  classes (`--primary` and friends cannot resolve without that class on the root, and the stroke would fall back to gray). Also:
  if the window's own script crashes, it calls `screenshot_failed` to hide itself rather than leaving an unclickable gray
  layer in front of the user.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: `screenshot_begin` no longer returns the captured image; `screenshot_pending` /
  `screenshot_pixels` are deleted (neither the preview file nor shipping pixels over IPC is needed any more); the completion
  copy is in a more formal tone (no more "it is in the clipboard too", and the Rust-side error strings changed with it).
- `src-tauri/capabilities/screenshot.json`: showing and focusing are done by Rust now, so the overlay window's permissions
  shrink to "listen to events only".
- `scripts/dev/probes/`: the acceptance probes follow: `screenshot-arm-timing-*` (measures "message received to first
  frame"), `capture-desktop.ps1` (captures the whole screen as evidence; `CopyFromScreen` and the window's own CDP screenshot
  are not the same thing), `screenshot-begin-timing.js` (measures only "click to gray wash appearing").

**Area screenshot: capture, select, save and clipboard all inside the app**

- `src-tauri/src/modules/screenshot/` (a new module, four files):
  - `capture.rs`: Windows captures the whole virtual desktop with GDI. GDI returns BGRA with garbage alpha, which is
    filled in as opaque RGBA: without that, the saved PNG and the clipboard image are semi-transparent; other platforms
    refuse honestly instead of pretending to work.
  - `geom.rs`: selection snapping (dragging back and dragging off-screen are handled correctly), cropping by selection, file
    names and local timestamps. All pure functions with unit tests.
  - `encode.rs`: PNG encoding via the `image` crate already in the dependency tree, with only the `png` feature enabled.
  - `mod.rs`: screenshot state and commands (`begin` shows the overlay window / `finish` hides the window, captures, crops,
    writes to disk, puts it on the clipboard / `cancel` / `failed`). Cropping uses the raw captured pixels: feeding the whole
    screen to the asset protocol and cropping on a canvas would taint it cross-origin and make `toBlob` throw. Cropping is in
    the backend and selection in the frontend, so the backend snaps the selection once more.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`: register the module, state and commands;
  windows-sys gains `Win32_UI_WindowsAndMessaging` (for `GetSystemMetrics` and the virtual screen constants).
- `src-tauri/capabilities/screenshot.json` (new): the overlay window gets its own **minimal** capability: events only, with
  show and focus done by Rust, and none of the store / dialog / opener permissions it does not need.
- `screenshot.html`, `src/screenshot/main.tsx`, `vite.config.ts`: the frontend entry of the second window (a transparent
  window), one more entry in the multi-page build.
- `src/modules/screenshot/ScreenshotOverlay.tsx` (new): light gray wash, drag a box (with a physical-pixel size hint),
  movable and resizable after release, corner-radius slider, save / cancel icon buttons, Enter to save, Esc to cancel; no
  screen freeze: the screen stays live.
- `src/modules/screenshot/lib/selection.ts` (new): CSS pixel ↔ physical pixel conversion: at 125% display scaling the two
  differ by a devicePixelRatio and sending CSS coordinates directly crops off target; rounding is "one column too many rather
  than one too few". With unit tests.
- `src/modules/header/Header.tsx`: a "screenshot" entry appears to the left of the Git button at the top right.
- `src/app/App.tsx`, `src/lib/native.ts`, `src/modules/i18n/messages.ts`: the completion toast (stating where it was saved
  and whether the clipboard worked, reported separately) and "insert path": clicking it inserts the path into the current
  terminal input line with bracketed paste, so spaces in the path are fine, with no automatic insert and no Enter; on tabs
  that are not a terminal the button is not offered at all (there would be nowhere to insert it).
- `scripts/dev/cdp-input.mjs` (new) plus `scripts/dev/probes/` (the probes for this area and `capture-desktop.ps1`):
  send real input to a **specific** window and capture evidence for acceptance. `cdp-key.mjs` only ever finds the first
  page and the overlay window is the second, and mouse dragging also needs a full press/move/release (synthesizing a
  PointerEvent in the DOM will not do: `setPointerCapture` only honors real pointers).

**Pi session list: show the latest session name**

- `src-tauri/src/modules/agent_sessions/pi.rs`: the session name is no longer looked for only in the first 8 MB of the file
  (in a long session the rename line can be tens of MB in; when it was not found the first user message was used); it now
  searches backwards from the end of the file in blocks for `session_info`, takes the last name and reads that whole line at
  the match. The header window drops from 8 MB to 1 MB.

**Markdown preview: small images without a size are no longer stretched into a full-width banner**

- `src/modules/markdown/MarkdownImage.tsx`: images without a height used to be pinned to `height: 260px` (with `object-fit: contain`),
  so a 116×20 badge was blown up into a full-column banner; they now reserve 260px before load and go back to their own size
  once loaded (260px is only a cap). The sizing decision is extracted into a pure function `previewImageStyle`.
- `src/modules/markdown/MarkdownImage.test.ts`: new, covering the four branches.

**Markdown preview: inline images sit on one line again**

- `src/modules/markdown/MarkdownImage.tsx`: image `display` changes from `block` to `inline-block` (with `mr-2 last:mr-0`), so
  several images in one line display side by side with spacing between them.

**Fonts: pick an installed font from a dropdown (terminal and editor share one font)**

- `src-tauri/src/modules/fonts.rs`: new, lists installed font families (Windows GDI `EnumFontFamiliesExW` / Linux `fc-list` /
  macOS `system_profiler`); new command `fonts_list`.
- `src/lib/fontOptions.ts`, `src/settings/components/FontPicker.tsx`, `src/settings/lib/useInstalledFonts.ts`: new; the options are
  "auto-detect" plus installed fonts (the current value is listed and marked even when it is not installed), searchable.
- `src/settings/sections/GeneralSection.tsx`, `src/modules/i18n/messages.ts`: the font row becomes a dropdown, and the
  description states that the terminal and the editor share it.
- `src/modules/settings/store.ts`: the default for `terminalFontFamily` changes from empty to `Cascadia Code` (stored values
  are untouched).
- `src/lib/fonts.ts`: the terminal font stack is "selected font → auto-detected Nerd Font (icons) → fallback chain".
- `src/modules/editor/lib/useApplyEditorFontFamily.ts`, `src/modules/editor/lib/extensions.ts`: the editor font goes through the
  `--editor-font-family` variable.
- `src-tauri/Cargo.toml`: `windows-sys` gains the `Win32_Graphics_Gdi` feature.

**GitHub: account and sign-in**

- `src-tauri/src/modules/github/auth.rs`: new. Parses `gh auth status --json hosts` (picks the active account, splits scopes,
  does not crash on missing fields), and rejects obviously wrong pasted tokens locally.
- `src-tauri/src/modules/github/gh.rs`: extracts `command()` (arguments passed one by one, interactive prompts off, proxy applied,
  console hidden: all prepared centrally); new `spawn` / `pump` / `run_with_stdin` (a pasted PAT can only come in over stdin);
  new `AUTH_TOKEN_TIMEOUT_SECS` / `AUTH_WEB_TIMEOUT_SECS`.
- `src-tauri/src/modules/github/types.rs`: new `AuthStatusPayload` / `AuthActionPayload` / `AuthLoginProgress`.
- `src-tauri/src/modules/github/commands.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_auth_status` /
  `github_auth_login_token` / `github_auth_login_web` (streams the one-time code gh prints to the UI in real time, cancellable) /
  `github_auth_login_web_cancel` / `github_auth_logout`, plus `AuthLoginState`.
- `src/lib/native.ts`: new wrappers and wire types for those five.
- `src/modules/remotes/lib/auth.ts`: new. Folds the sign-in state into what the UI needs, detects a missing
  `delete_repo` authorization, and pre-checks a pasted token locally.
- `src/modules/remotes/AuthDialog.tsx`: new. Current state / browser authorization (live output of the one-time code,
  cancellable) / paste a PAT (the input is cleared immediately on submit) / sign out (the confirmation states the
  consequences first).
- `src/modules/remotes/RemoteReposView.tsx`: the account in the page header becomes an entry point; a prompt block for "not signed
  in / gh not installed" gains an entry point too; the list is re-read when the panel closes.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `scripts/dev/probes/auth-acceptance.mjs`: new; acceptance script for the account panel (the `--isolated` run exercises
  the "not signed in" flow in a temporary `GH_CONFIG_DIR` without touching the real sign-in state).

**GitHub: repository management (edit description / switch visibility / delete repository) and clone locally**

- `src-tauri/src/modules/github/repo_admin.rs`: new. Reads `gh repo view --json description,visibility,viewerPermission`;
  descriptions over 350 characters are rejected locally; recognizes the recoverable "gh lacks the delete_repo authorization"
  failure.
- `src-tauri/src/modules/github/permission.rs`: new `admin_allowed` (only `ADMIN` counts as administrator; an unknown or
  unresolvable level counts as allowed to change).
- `src-tauri/src/modules/github/types.rs`: new `RepoSettingsPayload` (`can_admin` is still true on failure) and
  `RepoActionResult`.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_settings` /
  `github_repo_set_description` / `github_repo_set_visibility` / `github_repo_delete` (60 second timeout; after the delete request
  it re-queries `gh api repos/{slug}` and only a 404 counts as success; when the delete_repo authorization is missing, the command
  to run is included in the error text).
- `src/lib/native.ts`: new `githubRepoSettings` / `githubRepoSetDescription` / `githubRepoSetVisibility` / `githubRepoDelete`
  and wire types.
- `src/modules/remotes/lib/repoAdmin.ts`: new. `canAdmin` (unresolved / unfetchable counts as allowed to change), the read-only
  prompt key, `isPrivateVisibility`, the "type the full name" check for deleting a repository, the description length, and the
  adjacent-path guess for a clone target directory.
- `src/modules/remotes/RepoAdminDialog.tsx`: new. Description saving, visibility switching (each of public / private gets its own
  consequence confirmation) and a danger zone (the delete button only appears once the full repository name is typed; after
  deletion the result is reported back so the list can drop that row); none of the three entry points render for non-admins.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "clone locally…" and "repository settings…"; a successful description /
  visibility change updates only that row; the clone and settings dialogs are wired in. Also fixed: the menu content is portalled to
  the body by Radix, but React events still bubble along the component tree, so clicking a menu item also triggered the row click
  (and "repository settings…" therefore also opened the runs panel): intercepted on the menu content.
- `src/modules/remotes/RunListDialog.tsx`: fixed: the confirmation dialog (AlertDialog) is another Radix layer, and clicking it was
  taken by the layer above as "clicked outside the panel", closing the panel too; it no longer closes while the confirmation is open.
- `src/modules/projects/CloneRepoDialog.tsx`: optional prefilling of the URL and target directory (used when entering from a remote
  repository row).
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `scripts/dev/probes/repo-admin-acceptance.mjs`: new; acceptance script for repository management and cloning.

**GitHub: permission gate**

- `src-tauri/src/modules/github/permission.rs`: new. Reads `gh repo view --json viewerPermission`, treating `TRIAGE` / `READ` as
  not writable; an unknown or unresolvable level counts as writable (the button is still offered and GitHub gets to refuse).
- `src-tauri/src/modules/github/types.rs`: new `RepoPermissionPayload`; `can_write` is still true on failure.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_permission` command
  (30 second timeout) and its registration.
- `src/lib/native.ts`: new `githubRepoPermission` and `WireRepoPermissionPayload`.
- `src/modules/remotes/lib/permission.ts`: new. `canWrite` (unresolved / unfetchable counts as writable) and the read-only prompt key.
- `src/modules/remotes/RunListDialog.tsx`: checks that repository's permission once on open; when not writable it does not render
  rerun / cancel / delete and adds a read-only note.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the read-only note.
- `scripts/dev/probes/permission-acceptance.mjs`: new; acceptance script for the permission gate.

**GitHub: releases and asset downloads**

- `src-tauri/src/modules/github/releases.rs`: new. Parses the release list, pre-checks asset file names on disk, thresholds progress
  coalescing, renames `<name>.verta-part` only on success (on failure only the temporary file is deleted), and keeps a per-id cancel flag.
- `src-tauri/src/modules/github/types.rs`: new `RepoRelease` / `RepoReleaseAsset` / `RepoReleasesPayload` / `ReleaseDownloadProgress` /
  `ReleaseDownloadResult`.
- `src-tauri/src/modules/github/commands.rs`: new `github_releases`; new `github_release_download` (streams gh output, 45 second stall and
  30 minute total timeout, a byte count that does not match the asset size counts as failure, progress emitted over
  `verta://github-download`) and `github_release_download_cancel`.
- `src-tauri/src/modules/github/mod.rs`, `src-tauri/src/lib.rs`: register the new module, the three commands and `DownloadState`.
- `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.lock`: add
  `tauri-plugin-dialog` and `@tauri-apps/plugin-dialog`, with only the `dialog:allow-open` permission granted.
- `src/lib/native.ts`: new `githubReleases` / `githubReleaseDownload` / `githubReleaseDownloadCancel` and wire types.
- `src/modules/remotes/lib/releases.ts`: new. List mapping, size and speed copy, percentages, progress smoothing.
- `src/modules/remotes/lib/pickDownloadDir.ts`: new. Directory picking, defaulting to the system downloads folder and falling back to
  the home directory.
- `src/modules/remotes/ReleasesDialog.tsx`: new. List → detail, with progress events claimed by download id.
- `src/modules/remotes/ReleaseDetail.tsx`: new. Asset rows with download / progress / speed / cancel / open containing folder, and the
  body rendered with a lazily loaded Markdown renderer.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "releases…".
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.
- `README.md`: the feature table gains releases and asset downloads.
- `scripts/dev/probes/releases-acceptance.mjs`: new; acceptance script for releases and asset downloads.

**Documentation reconciliation**

- `VERTA.md`: removed the section on the built-in agent, which no longer exists; the module list gains `launcher` / `projects` / `remotes` / `i18n`,
  the Rust command list gains `agent_sessions` / `projects` / `github`; tab kinds gain `projects` / `remotes`; the Git panel is now
  documented as the right panel, with the sidebar keeping only sessions and files; references to the removed performance scripts are gone;
  added unsaved draft backups, terminal session images, Markdown image sizing and release downloads; the gate command is now `cargo test --lib`;
  two statements that no longer matched the code (image authentication, secret deny-list) are removed.

</details>

<details>
<summary><strong>2026-10-20</strong></summary>

**GitHub: the CI badge follows the runs panel, duplicate entry point removed**

- `src/modules/remotes/lib/runs.ts`: new `ciFromRuns` (folds the runs list into what that one CI badge should show:
  the newest run is the badge; an empty list is a confirmed "no runs"; a failed query is passed through as is); with unit tests.
  The "check CI" item in the row menu and "runs…" were two ways of saying one thing: the badge is cached per row, so after an
  old run was deleted it could keep an outdated verdict and contradict the panel. The panel is now the single source.
- `src/modules/remotes/RunListDialog.tsx`: new `onLoaded`, called once each time the runs list is fetched (including the
  reconciliation after a delete).
- `src/modules/remotes/RemoteReposView.tsx`: wired to `onLoaded`, so a freshly loaded panel updates that row's badge with its newest
  run; the duplicate "check CI" item in the row menu is removed (hover auto-query and clicking the badge to query on demand both stay).

**GitHub: delete a run; clicks no longer jump to the browser**

- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: `RunAction` gains a `Delete`, plus a new
  `github_run_delete` (`gh run delete <id> --repo <slug>`). Rerun / cancel / delete share one path, with the same pre-checks,
  failure classification and raw-text pass-through. **After deleting, whether that run still exists is re-checked**
  (`repos/{o}/{r}/actions/runs/{id}`): only an explicit 404 reports success, a run still there is reported honestly as
  "possibly not deleted", and anything unclear (rate limiting / a flaky proxy / permissions) carries its reason out:
  the exit code of `gh run delete` alone is not enough, and if any link in that chain misleads us once, the UI permanently
  hides a record that is actually still on GitHub (the row is removed and filtered out again on refresh).
- `src-tauri/src/modules/github/actions.rs`: new `classify_run_probe` (the re-check verdict: gone / still there / unclear)
  and `RunProbe`, with unit tests.
- `src/modules/remotes/RunListDialog.tsx`: a "delete" item in the row, offered only for finished runs (GitHub does not allow
  deleting a running one); the confirmation states that logs and results are deleted with it and cannot be restored, and on failure
  keeps gh's own wording in the confirmation. After the delete is **confirmed by the backend re-check**, the UI drops that row
  immediately and reconciles in the background; previously it showed a toast first and waited two or three seconds for the refresh,
  so the toast and the panel disagreed briefly and the user saw it; freshly deleted ids are also recorded and filtered out on refresh so
  GitHub lagging a beat does not bring the row back (only "confirmed deleted" ids are filtered; failed deletes always stay in the list).
- `src/modules/remotes/RemoteReposView.tsx`: clicking a repository row and clicking the CI badge both open that repository's runs panel
  inside the app ("open in browser" stays only in the row menu). With that, every "one click jumps to the browser" path in the GitHub panel is gone.
- `src/modules/remotes/lib/runs.ts`: new `canDelete` (only finished runs can be deleted) and `withoutRun` (drop a row by id); with unit tests.

**GitHub: run detail inside the app (jobs / steps / logs)**

- `src-tauri/src/modules/github/actions.rs`: new `parse_jobs` (reads `actions/runs/{id}/jobs`, including the step tree),
  `parse_log` (splits `job\tstep\t<time> body` into three parts; lines whose prefix is not recognized are kept as is, lines are never
  dropped; the BOM before the first line's timestamp is stripped), `cap_lines` (only the last `MAX_LOG_LINES = 2000` log lines are kept).
  With 7 unit tests.
- `src-tauri/src/modules/github/types.rs`: new `RepoRunJob` / `RepoRunStep` / `RepoRunJobsPayload` /
  `RepoRunLogLine` / `RepoRunLogPayload`. The two kinds of log truncation are reported separately: `clipped` (only the tail was kept) and
  `capped` (a per-request limit was hit and the beginning was received), and the UI words them differently.
- `src-tauri/src/modules/github/gh.rs`: `GhOutput` carries `stdout_truncated`, and `run_with_cap` is split out of
  `run`; logs get their own 90 second and 8 MB limits (`LOG_TIMEOUT_SECS` / `LOG_STDOUT_CAP`).
- `src-tauri/src/modules/github/commands.rs`, `src-tauri/src/lib.rs`: new `github_run_jobs` and
  `github_run_log` (`failed_only` goes through `gh run view --log-failed`).
- `src/modules/remotes/RunDetail.tsx`: new. In-app run detail: job and step tree (a status per step), a log pane
  (time + step shown only when it changes + coloring by `##[error]` / `##[warning]`), a "failures only" toggle, and a
  separate notice per truncation kind; "open on GitHub" drops to a secondary exit: it is only really needed when the log was truncated.
- `src/modules/remotes/RunListDialog.tsx`: the row's "open browser" becomes "detail", switching views inside the same dialog
  (no stacked dialogs).
- `src/modules/remotes/lib/runs.ts`: new `logLineTone` (error / warning / group / normal) and `logClock`; with unit tests.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: command wrappers and Chinese / English copy.

**Layout: both gutters are the same width**

- `src/app/App.tsx`: the middle area's padding changes from `pl-0.5 pr-2` to `pl-0.5 pr-0.5`. Before, sidebar↔terminal was 0.5+0.5 and
  terminal↔Git was 2+0.5, so the right one looked more than twice as wide; both gutters are now 2px + 4px separator + 2px = 7.58px,
  and the outer margin on both sides of the window still comes from the sidebar's `pl-2` and the right panel's `pr-2`, 8px each.

**GitHub: runs list (with rerun / cancel)**

- `src-tauri/src/modules/github/actions.rs`: new. Parses the runs list `repos/{owner}/{repo}/actions/runs?per_page=N`.
  Tolerant per entry (entries missing id / status / html_url are dropped, other missing fields are treated as empty); but "the response had
  entries and none of them survived" is reported honestly as a parse failure, not as "no runs". With 7 unit tests.
- `src-tauri/src/modules/github/types.rs`: new `RepoActionRun` / `RepoActionRunsPayload` /
  `RepoRunActionResult`, an empty list maps to `none` (the same kind set as the CI call); the `failed` "never return an empty error" rule is folded into
  a small helper, which the CI call uses too.
- `src-tauri/src/modules/github/commands.rs`: new `github_repo_runs` (one repository at a time, count clamped to 1..=50,
  default 20), `github_run_rerun`, `github_run_cancel` (internally `gh run rerun/cancel <id> --repo <slug>`).
  The run id is an integer so no option injection can be built from it; 0 is rejected locally.
- `src-tauri/src/lib.rs`, `gh.rs`, `mod.rs`: register the three commands and `RUN_ACTION_TIMEOUT_SECS`.
- `src/modules/remotes/RunListDialog.tsx`: new. Lists the latest 20 runs: status badge, workflow · branch · #number,
  event, raw conclusion, relative time, plus an "open" link. Rerun and cancel both need confirmation; on failure gh's own wording stays in
  the confirmation (on success the dialog closes first and then refreshes, since a refresh problem should not make it look like a failure).
- `src/modules/remotes/lib/runs.ts`: new. The per-row view rules (only finished runs can be rerun; cancel only applies before that) and time
  parsing; with 4 unit tests.
- `src/modules/remotes/lib/ci.ts`: `runState` / `runDetail` / `TONE_CLASS` are extracted for the CI column and the runs list to share;
  one inconsistency fixed along the way: `timed_out` had a red badge but read "finished", and now reads as a failure.
- `src/modules/remotes/RemoteReposView.tsx`: the row menu gains "runs…".
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: command wrappers and Chinese / English copy.

**UI copy: input placeholders that never adapted to Chinese**

- `src/modules/command-palette/CommandPalette.tsx`: the command palette's four placeholders (default / theme / file contents / command history)
  now go through i18n; they were hardcoded English.
- `src/modules/header/SearchInline.tsx`: "Search" and "Git search" in the header search box now go through i18n (the shortcut suffix is still
  concatenated as before).
- `src/modules/explorer/FileExplorer.tsx`, `src/modules/explorer/TreeRow.tsx`: the inline placeholders for new file / new folder
  now use `explorer.newFile` / `explorer.newFolder`: both keys existed already but were never used.

**GitHub: CI status column (remote repository list)**

- `src-tauri/src/modules/github/ci.rs`: new. Parses the latest run of `repos/{owner}/{repo}/actions/runs?per_page=1`;
  plus a pre-check on `owner/repo` (empty values, a leading `-`, no slash, multiple segments, out-of-charset values are all rejected locally
  so they never reach gh).
- `src-tauri/src/modules/github/types.rs`: new `RepoCiRun` / `RepoCiPayload`, and one more kind, `none`:
  "confirmed there are no runs" is kept apart from a failure, so a failure never masquerades as no CI.
- `src-tauri/src/modules/github/commands.rs`, `gh.rs`, `mod.rs`, `src-tauri/src/lib.rs`: new `github_repo_ci`
  command (one repository at a time, 30 second timeout), reusing the repository list's "gh not installed / not signed in / other failure" classification
  and raw-text pass-through.
- `src/modules/remotes/RemoteReposView.tsx`: the repository list gains a CI column. Only the row the pointer is on gets queried (not the whole list in bulk,
  to avoid burning the API quota); the row menu also has a "check CI" that forces a re-query; clicking the badge opens this run's URL.
- `src/modules/remotes/lib/ci.ts`: new, folds status/conclusion into "what to say, what color, where it links"; with 7 unit tests.
- `src/lib/native.ts`, `src/modules/i18n/messages.ts`: command wrappers and Chinese / English copy.

**Git panel: branch create / rename / delete, worktrees, commit-level actions**

- `src-tauri/src/modules/git/types.rs`: `MAX_TIMEOUT_SECS` goes up to 900 seconds, and cloning uses its own
  `CLONE_TIMEOUT_SECS`: a clone transfers the whole history from scratch and 120 seconds is not enough.
- `src-tauri/src/modules/git/errors.rs`: new `InvalidRefName`; empty names and names starting with `-` are rejected here, and
  errors show the value quoted so an empty value is visible too.
- `src-tauri/src/modules/git/operations.rs`: new branch create / rename / delete, worktree add / remove, cherry-pick, revert, soft reset,
  abort cherry-pick/revert, and repository clone. Names, revisions and clone URLs are pre-checked (blocking empty values and `-`-leading argument
  injection), with the rest of validity left to git; a new directory's parent must exist first and be registered as authorized (the path the user
  typed is itself the authorization).
- `src-tauri/src/modules/git/commands.rs`, `src-tauri/src/lib.rs`: register the corresponding ten commands.
- `src/lib/native.ts`: wrappers for those commands.
- `src/modules/source-control/SourceControlPanel.tsx`: branch rows and worktree rows become submenus (switch / rename /
  delete, open / remove), plus two entry points, "new branch" and "new worktree".
- `src/modules/source-control/BranchDialogs.tsx`: five new dialogs. Deleting a branch and removing a worktree are first attempted the normal way;
  when git refuses, its wording stays in the dialog and a "force delete (-D)" / "force remove" is offered.
- `src/modules/git-history/CommitActions.tsx`: new, cherry-pick / revert / soft reset in the commit detail. On success the dialog closes first and then refreshes
  (a refresh problem should not make the dialog look like a failure); on failure git's wording stays in the dialog and the stuck step can be aborted directly.
- `src/modules/git-history/GitHistoryPane.tsx`: wired to those three actions, re-reading the commit list afterwards.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.

**Projects page: clone a repository**

- `src/modules/projects/CloneRepoDialog.tsx`: new; enter a repository URL and a target directory, and the clone is added to the project list afterwards.
- `src/modules/projects/ProjectsView.tsx`: the projects page gains a "clone repository…" entry point.

**Editor: backup of unsaved content (nothing is lost when editing is interrupted)**

- `src/modules/editor/lib/drafts.ts`: new. After changes, the buffer is mirrored into `verta-drafts.json`:
  1 MB per draft, at most 8 drafts, 4 MB total, the oldest dropped when exceeded; keys normalize path separators but do **not** fold
  case (two files in WSL that differ only by case must not be treated as one). With 11 unit tests.
- `src/modules/editor/lib/useDocument.ts`: the mirror runs only once typing has stopped for 1.5 seconds (so it is not one IPC call per
  keystroke); the draft is deleted only on a successful save or when the user chooses to discard; closing a tab (unmount), the window
  losing focus and closing the window all flush immediately. When a file is opened (including tabs restored after a crash) and the disk
  content differs from the draft, "restore / discard" is handed to the UI.
- `src/modules/editor/EditorPane.tsx`: a restore notice with the interruption time at the top of the editor; it does not block editing
  and does not change the file automatically: restoring only puts the content back into the buffer, and saving is up to the user.
- `src/modules/i18n/messages.ts`: Chinese and English copy for this notice.

**Tests**

- `src/modules/terminal/ghostty/AdaptedGhosttyGpu.test.ts`: the hundred-thousand-update stress case gets a 60 second timeout; on a busy machine
  it takes longer than the 5 second default, and this case measures behavior, not speed.

**Acceptance scripts**

- `scripts/dev/probes/click-remotes.js`: deleted, an old probe for the remote repository panel, used once and discarded.

</details>

<details>
<summary><strong>2026-10-19</strong></summary>

**Git panel: stash**

- `src-tauri/src/modules/git/types.rs`: new `GitStashEntry`, carrying the reference, index, message and branch.
- `src-tauri/src/modules/git/parser.rs`: new `parse_stash_list`, parsing the NUL-separated output of
  `git stash list`; when no branch can be parsed out of the message it is left empty rather than invented. With three unit tests.
- `src-tauri/src/modules/git/operations.rs`: new `stash_list`, `stash_push` (optional message and
  `--include-untracked`), `stash_apply`, `stash_pop`, `stash_drop`, all through the existing authorization and timeout wrappers.
- `src-tauri/src/modules/git/commands.rs`, `src-tauri/src/lib.rs`: register the corresponding five commands.
- `src/lib/native.ts`: new `GitStashEntry` type and `gitStashList` / `gitStashPush` /
  `gitStashApply` / `gitStashPop` / `gitStashDrop`.
- `src/modules/source-control/StashSection.tsx`: new, the stash area at the bottom of the Git panel. Collapsed by default and only read when
  expanded; a message can be entered and untracked files optionally included; each stash's menu offers apply, apply and drop, and drop.
  Dropping needs confirmation first.
- `src/modules/source-control/SourceControlPanel.tsx`: the stash area is wired in below the file list, and the panel refreshes after an operation.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the stash area.

**Installer copy**

- `src-tauri/tauri.conf.json`: `shortDescription` and `longDescription` were still upstream copy (mentioning an AI-native terminal,
  voice input and AI agents, all of which have been removed) and now describe what the product actually is; NSIS gains Simplified Chinese and
  the language selection is enabled, where the installer previously only had English.

</details>

<details>
<summary><strong>2026-10-18</strong></summary>

**App icon (brand assets)**

- `assets/icon-stroke.svg`: new, a hand-drawn vector app icon (dark rounded base + white V), replacing the upstream icon.
- `src-tauri/icons/**`: the full platform icon set (`.ico`/`.icns`, the Windows Store variants, Android/iOS) regenerated
  from that vector with `pnpm tauri icon`, replacing the upstream artwork.
- `public/logo.png`: replaced with a 256px render of the same vector, used by the page head, the about page and the terminal watermark.

**Remote repository panel (new feature)**

- `src-tauri/src/modules/github/**`: new, one `github_repos` command reading the repositories the account can access through
  the locally signed-in `gh` (pagination, parsing and failure classification as pure functions with unit tests).
- `src-tauri/src/modules/proxy.rs`: new, prepares a proxy address for external programs (explicit argument > environment
  variable > system registry) and injects it into child processes after clearing inherited proxy variables; `gh` already uses it, and
  git's fetch/push/clone can reuse it later.
- `src-tauri/Cargo.toml`: enables the `Win32_System_Registry` feature on `windows-sys`.
- `src-tauri/src/modules/mod.rs`, `src-tauri/src/lib.rs`: register the new module and command.
- `src/modules/remotes/**`: new, the remote repositories tab (row mapping, filtering, four-state notices with unit tests).
- `src/lib/native.ts`: new `githubRepos` and wire types.
- `src/modules/tabs/**`: new `remotes` tab type and `planRemoteReposOpen`, plus the tab bar icon.
- `src/modules/header/Header.tsx`: a remote repositories entry point at the top right.
- `src/modules/command-palette/commands.ts`: one new command, "open remote repositories list".
- `src/app/App.tsx`, `src/app/components/WorkspaceSurface.tsx`: wired to the middle-area tabs.

**Environment for resuming a session**

- `src/modules/launcher/lib/openSession.ts`: new, computes the environment together with the resume command, so a host session no longer
  lands in a distro terminal.
- `src/modules/launcher/index.ts`, `src/app/App.tsx`: switched to that pure function.

**Git panel on the right and the projects entry point**

- `src/modules/sidebar/**`: the Git view is removed from the sidebar (`SidebarViewId` keeps only sessions and files), and a new
  `useRightPanel` manages the right panel's width and collapsed state.
- `src/modules/source-control/**`: panel visibility is decided by "is the right panel expanded" instead of "is Git selected in the sidebar".
- `src/modules/header/Header.tsx`: a right panel toggle at the top right, which also takes over the change-count badge.
- `src/modules/projects/**`, `src-tauri/src/modules/projects/**`: the project list tab, scanning and status queries.
- `src/modules/tabs/lib/useTabs.ts`: new `projects` tab type and `planProjectsOpen`.
- `src/modules/i18n/messages.ts`: Chinese and English copy for the UI above.

**Repository cleanup and branding**

- `LICENSE`: the upstream text (Apache-2.0) is kept, with the body unchanged; the copyright lines required for compliance are in another
  revision in this directory.
- The local draft of the upstream artwork (an icon png in the repository root) and the remote pointing at upstream have been removed.
- `src-tauri/src/modules/agent_sessions/opencode.rs`, `src/modules/launcher/lib/resumeCommand.test.ts`:
  test fixtures replaced with neutral paths and titles that no longer reference the upstream author's project directory.
- `scripts/dev/shot-window.ps1`: the comment no longer names another application installed on this machine.

**Feature reduction (built-in agent removed)**

- `src/modules/ai/**`, `src/modules/agents/**`, `src/components/ai-elements/**`: the whole modules are deleted, so upstream's
  built-in AI assistant UI, sub-agent runner and notifications no longer exist. Code block rendering in the terminal is kept.
- `src-tauri/src/modules/agent.rs`, `src-tauri/src/modules/ai_sessions.rs`,
  `src-tauri/src/modules/pty/agent_detect.rs`: upstream's Rust-side agent session storage and detection are deleted with them.
- `src/settings/sections/**`, `src/settings/components/**`: the settings related to the built-in agent and the launch-at-login item are removed.
- `src/modules/editor/**`, `src/modules/markdown/**`, `src/modules/launcher/**`,
  `src/modules/statusbar/**`: branches referencing the built-in agent are removed, the rest stays.
- The launch-at-login option is removed.

**Upstream metadata**

- `TERAX.md`: renamed to `VERTA.md` and rewritten as Verta's engineering notes (keeping the two upstream wasm identifier notes that cannot be changed).
- `.github/**` (CI, release, issue templates, dependabot, CODEOWNERS), `CLAUDE.md`, `AGENTS.md`:
  upstream's project governance files are removed in the baseline cleanup.
- `docs/**`: all upstream documentation removed (the directory is empty and not in version control).
- `CODE_OF_CONDUCT.md`: removed in the baseline cleanup.
- `CONTRIBUTING.md`, `ROADMAP.md`, `SECURITY.md`: upstream's contributing guide, roadmap and security notes are no longer distributed
  with the repository (their content still describes Terax's feature set); the files stay on this machine as they are and are ignored by
  `.gitignore`; Verta's own engineering notes live in `VERTA.md`.
- `.coderabbit.yaml`: upstream's review configuration is not in version control (`.gitignore` already ignores it).
- `package.json`: the package name becomes `verta`, and upstream's release and documentation scripts are removed.
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`: product name, crate name and app identifier changed to Verta.
- `index.html`, `src/main.tsx`, `vite.config.ts`, `biome.json`: name and path references changed to Verta.
- `.gitignore`: upstream's local draft and documentation entries removed, replaced by ignoring `.superpowers/`.
- `.gitattributes`: line-ending rules adjusted to keep the working tree LF.

**License and change log**

- `LICENSE`: the Apache-2.0 body stays as upstream wrote it; two copyright lines are added at the top, for this project (Zomcxj) and for upstream Crynta.
- `README.md`: copyright notice and acknowledgements added, pointing at Terax AI and stating that the differences are recorded in `CHANGES.md`.
- `CHANGES.md`: new, recording every difference between this project and upstream, in reverse chronological order.
- `AGENTS.md`: the local working conventions, stating that this file is updated with every change (not in version control).
- `README.md`: rewritten in the layout of the upstream README (centered title, badges, sectioned feature table, tech stack, license), with the content
  replaced by Verta's own features; the "work log" section is dropped and workspace information is left to `AGENTS.md`.
- `docs/**`: upstream documentation and screenshots deleted from this machine (directory and contents), and the corresponding path rules removed
  from `.gitignore`.
- Cleanup of files left over from upstream: `.github/**` (CI, release workflow, issue templates, dependabot, CODEOWNERS),
  `.coderabbit.yaml`, `CONTRIBUTING.md`, `ROADMAP.md`, `SECURITY.md`, `flake.nix`, `flake.lock`,
  `nix/` and `scripts/dev/upstream-drift.sh` are deleted from this machine, and the corresponding dead rules are cleared from `.gitignore`.

**Wrap-up cleanup of the built-in AI feature (feature gone, scaffolding left)**

- `src/modules/editor/AiDiffPane.tsx`, `AiDiffStack.tsx`, `AiDiffStackLazy.tsx`: deleted, void along with the built-in AI's
  diff view.
- `src/modules/tabs/lib/useTabs.ts`: the `AiDiffTab` and `AiDiffStatus` types, `openAiDiffTab`,
  `setAiDiffStatus` and `closeAiDiffTab` are deleted (exported, but with no callers).
- `src/modules/tabs/index.ts`, `src/modules/tabs/lib/tabLabel.ts`, `src/modules/tabs/TabBar.tsx`:
  the `ai-diff` re-export, title branch and tab icon are removed.
- `src/modules/editor/useEditorFileSync.ts`: the listener that reloaded the editor after an approved AI change is removed.
- `src/components/chat-code.tsx`: the unused `ChatStreamingProvider` export is removed (the file itself is still used for code block
  rendering in the terminal and Markdown).
- `src/app/feature-loading.test.tsx`: the loading test for the deleted component is removed.
- `src/lib/usePresence.ts`: deleted, a dead file with no references.
- `knip.json`: the ignore for the deleted `src/components/ai-elements/**` and the `swiftc` ignore that only the deleted
  scripts needed are removed.

**Cleanup of upstream performance and visual tooling**

- `scripts/ipc-profile/`, `scripts/renderer-profile/`, `scripts/pty-smoke/`, `scripts/terminal-visual/`,
  `scripts/ghostty-profile.*`, `scripts/ghostty-soak.*`, `scripts/ghostty-webkit-memory*`: deleted, together with the
  `package.json` scripts pointing at them (`test:ipc:macos`, `profile:ghostty`, `soak:ghostty`,
  `profile:renderer:*`). `scripts/ipc-profile/smoke.ts` imported exactly the deleted built-in AI modules and could not have run anyway.
- Kept: `scripts/dev/**` (this project's acceptance tooling), `scripts/build-cli.mjs`, `scripts/dist-graph.*` and
  `scripts/eager-graph.*` (imported directly by the bundle-size budget tests), `scripts/app-lab/**` (the driver for `src/bench`,
  and `src/bench` is referenced by `src/main.tsx` and `src/app/App.tsx`).
- `src/modules/sidebar/useRightPanel.ts`: `shouldPersistRightWidth` is no longer exported (no callers).
- `src/app/dist-budget.test.ts`: the case that runs two full builds gets its own timeout, since the 5 second default goes red falsely under concurrency.

**Dependency cleanup (empty dependencies left after the built-in AI and related features were removed)**
- `package.json`: `ai` and `@ai-sdk/*` (9 packages in total) are removed, along with `zod`, `@radix-ui/react-use-controllable-state`,
  `use-stick-to-bottom`, `@tauri-apps/plugin-autostart`, `@tauri-apps/plugin-notification` and the dev dependency
  `react-compiler-healthcheck`. Nothing in the source imports these packages; they only survived as strings in the bundle-size test's deny list.
- `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`: the dependency, registration and permissions of
  `tauri-plugin-notification` are removed. The notification code was deleted with the built-in AI module, leaving the plugin as an
  empty shell that was registered but never used; `@tauri-apps/plugin-autostart` was only ever a frontend package, never registered on the Rust side.
- `pnpm-lock.yaml` and `src-tauri/Cargo.lock` are updated accordingly, and the packages themselves are removed from `node_modules`.

</details>

<details>
<summary><strong>2026-10-17</strong></summary>

**Session panel (new feature)**

- `src-tauri/src/modules/agent_sessions/**`: new, reads real sessions of the local opencode (`session_v2`) and pi (jsonl
  inside the project), reading sessions inside a distro from within that distro; deleting a session goes through the respective CLI or a file operation.
- `src/modules/launcher/**`: new, the pure functions and UI for the session list, the resume command, sub-agent filtering, selection and deletion.
- `src/modules/i18n/**`: new, Chinese and English UI copy plus language switching.
- `src/app/App.tsx`, `src/modules/sidebar/**`: wired into the sidebar, so the session panel is there as soon as the app opens.
- `src-tauri/src/lib.rs`, `src-tauri/src/modules/mod.rs`: register the new commands.

**Environment following**

- `src/modules/workspace/**`: the environment is now inferred from the path (`envForPath`), and opening a terminal prepares the environment before landing.
- `src-tauri/src/modules/workspace.rs`, `src-tauri/src/modules/pty/**`: start the matching shell per the environment the leaf carries.

**Foundational changes**

- `src-tauri/tauri.conf.json`: the app identifier changed to Verta's own.
- `.gitattributes`: keeps the working tree LF so the frontend lint gate works on Windows.
- `scripts/dev/**`: new screenshot and probe scripts for acceptance (not part of packaging).

</details>

