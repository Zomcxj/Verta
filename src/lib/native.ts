import { invoke } from "@tauri-apps/api/core";
import { envForPath, type WorkspaceEnv } from "@/modules/workspace";

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

/** Projects list: wire format for discovery and status queries. */
export type WireProjectTarget = {
  path: string;
  workspace: WorkspaceEnv;
};

export type WireProjectStatus = {
  path: string;
  name: string;
  workspace: WorkspaceEnv;
  kind: "repo" | "notRepo" | "missing" | "error";
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  dirty: number;
  stashed: number;
  error: string | null;
};

/** Remote repos: wire format for a single repository. */
export type WireRemoteRepo = {
  fullName: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  language: string | null;
  /** ISO8601 exactly as GitHub returns it; the UI folds it into relative time. */
  pushedAt: string | null;
  description: string | null;
  webUrl: string;
};

/**
 * Result of a remote repo listing. `kind` says what the read produced; only
 * `ready` means we really got the data (even an empty list). On failure
 * `error` carries gh's own words rather than a pretended empty list.
 */
export type WireRemoteReposPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  login: string | null;
  accountName: string | null;
  repos: WireRemoteRepo[];
  /** Hit the pagination limit; later repos were not fetched. */
  truncated: boolean;
  error: string | null;
};

/** The most recent workflow run of a repository. */
export type WireRepoCiRun = {
  /** Workflow name. */
  name: string;
  /** `queued` / `in_progress` / `completed` etc., verbatim from GitHub. */
  status: string;
  /** `success` / `failure` / `cancelled` etc.; null while still running. */
  conclusion: string | null;
  runNumber: number;
  headBranch: string | null;
  /** ISO8601; the UI folds it into relative time. */
  updatedAt: string | null;
  url: string;
};

/**
 * CI query result for one repository.
 * `none` is a confirmed "no runs on record", not a failure.
 */
export type WireRepoCiPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  run: WireRepoCiRun | null;
  error: string | null;
};

/**
 * Current account permission on a repository.
 *
 * When `canWrite` is false the UI hides write actions. When the lookup itself
 * fails (`notInstalled` / `notLoggedIn` / `error`) the backend still reports
 * true, so the buttons stay visible and GitHub gets to reject the click.
 */
export type WireRepoPermissionPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  /** `ADMIN` / `MAINTAIN` / `WRITE` / `TRIAGE` / `READ`; null when unknown. */
  permission: string | null;
  canWrite: boolean;
  error: string | null;
};

/**
 * Admin info for a repository (description, visibility, whether edits are
 * allowed).
 *
 * When `canAdmin` is false the UI hides edit-description / change-visibility /
 * delete; when the lookup fails the backend still reports true.
 */
export type WireRepoSettingsPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  description: string | null;
  /** `PUBLIC` / `PRIVATE` / `INTERNAL`; null when unavailable. */
  visibility: string | null;
  canAdmin: boolean;
  error: string | null;
};

/** Result of an admin action (edit description / change visibility / delete). */
export type WireRepoActionResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  error: string | null;
};

/**
 * Local gh login state.
 *
 * `none` is a confirmed "no host logged in", not an error. **The token itself
 * is never carried here.**
 */
export type WireAuthStatusPayload = {
  kind: "ready" | "none" | "notInstalled" | "error";
  host: string | null;
  login: string | null;
  state: string | null;
  active: boolean;
  tokenSource: string | null;
  gitProtocol: string | null;
  scopes: string[];
  error: string | null;
};

/** Result of a login / logout action; `cancelled` means the user aborted the browser flow. */
export type WireAuthActionPayload = {
  kind: "ready" | "cancelled" | "notInstalled" | "error";
  /** Whatever gh printed during the browser flow (one-time code, failure reason). */
  output: string | null;
  error: string | null;
};

/** A chunk of gh output emitted while the browser auth flow runs. */
export type WireAuthLoginProgress = { text: string };

/** One entry in the run list (rerun/cancel need `id`). */
export type WireRepoActionRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  runNumber: number;
  headBranch: string | null;
  /** `push` / `pull_request` / `workflow_dispatch` etc., verbatim from GitHub. */
  event: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
};

/** Run list for a repository; `none` is a confirmed "no runs on record", not a failure. */
export type WireRepoActionRunsPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runs: WireRepoActionRun[];
  error: string | null;
};

/** Rerun / cancel result: success carries no data, failure puts gh's words in `error`. */
export type WireRepoRunActionResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runId: number;
  error: string | null;
};

/** One step inside a run's detail view. */
export type WireRepoRunStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
};

/** One job inside a run's detail view (with its step tree). */
export type WireRepoRunJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  /** Which runner it ran on; falls back to the first label when GitHub omits it. */
  runner: string | null;
  steps: WireRepoRunStep[];
};

/** Job list for a run; `none` means "this run has no jobs at all". */
export type WireRepoRunJobsPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runId: number;
  jobs: WireRepoRunJob[];
  error: string | null;
};

/** One log line: the prefix split into job / step / time. */
export type WireRepoRunLogLine = {
  job: string;
  step: string;
  /** ISO8601; empty string when it cannot be parsed. */
  time: string;
  text: string;
};

/**
 * Log of a single run.
 * `clipped` means we kept only the tail; `capped` means the per-request
 * limit was hit and we got the head instead.
 */
export type WireRepoRunLogPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runId: number;
  lines: WireRepoRunLogLine[];
  totalLines: number;
  clipped: boolean;
  capped: boolean;
  error: string | null;
};

/** An asset attached to a release. `id` is what to pass back when downloading. */
export type WireReleaseAsset = {
  id: number;
  name: string;
  /** Size in bytes; 0 when GitHub does not report it. */
  size: number;
  downloadCount: number;
  contentType: string | null;
  updatedAt: string | null;
};

/** A release: body and assets ship with the list response, so detail needs no extra request. */
export type WireRelease = {
  id: number;
  tagName: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  createdAt: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  assets: WireReleaseAsset[];
};

/** Release list for a repository; an empty list is a confirmed "no releases". */
export type WireReleasesPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  releases: WireRelease[];
  error: string | null;
};

/** Download progress: the backend coalesces updates at 64 KiB / 100 ms. */
export type WireReleaseDownloadProgress = {
  id: string;
  written: number;
  total: number;
};

/** Outcome of a download; cancelling is not an error. */
export type WireReleaseDownloadResult = {
  kind: "ok" | "cancelled" | "error";
  path: string | null;
  error: string | null;
};

/**
 * An issue or PR (list form).
 *
 * GitHub's `issues` endpoint returns both; a PR carries an extra
 * `pull_request` object, and `isPullRequest` is derived from that field.
 */
export type WireIssueSummary = {
  number: number;
  title: string;
  /** Body. The list does not render it, but keyword filtering needs it, so it comes along. */
  body: string;
  /** `open` / `closed`. */
  state: string;
  isPullRequest: boolean;
  /** Draft state only exists in PR detail; the list endpoint cannot supply it. */
  isDraft: boolean;
  /** Already merged into the base branch (PRs only). */
  merged: boolean;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** Comment count. */
  comments: number;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  /** Locked items cannot be commented on. */
  locked: boolean;
};

/** Issue / PR list for a repository. */
export type WireIssueListPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  issues: WireIssueSummary[];
  /** Item cap reached with a full last page: more were probably left unfetched. */
  truncated: boolean;
  error: string | null;
};

/** One comment. */
export type WireIssueComment = {
  id: number;
  author: string;
  body: string;
  createdAt: string | null;
};

/** PR-only info (plain issues have no such block). */
export type WirePullRequestInfo = {
  head: string;
  headSha: string;
  base: string;
  draft: boolean;
  merged: boolean;
  /** `null` = GitHub is still computing it (async); it does not mean "cannot merge". */
  mergeable: boolean | null;
  mergeableState: string;
  /**
   * Why the PR cannot merge right now; null when it can.
   *
   * This is a **reason code** (merged / closed / draft / conflict / computing /
   * unknown): the UI looks the sentence up by code so it follows the UI
   * language. The backend only classifies; the UI just disables buttons.
   */
  mergeBlocked: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  state: string;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  locked: boolean;
};

/** Rolled-up check status. */
export type WireCheckSummary = {
  total: number;
  ok: number;
  failed: number;
  pending: number;
  /** Only some checks were seen (100 per page max): never report "all passed" here. */
  truncated: boolean;
  state: "pass" | "fail" | "pending" | "partial" | "none";
};

/** Detail of a single issue / PR. */
export type WireIssueDetail = {
  number: number;
  title: string;
  body: string;
  state: string;
  isPullRequest: boolean;
  isDraft: boolean;
  merged: boolean;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  locked: boolean;
  comments: WireIssueComment[];
  /** Explanation when comments could not be fetched; the body is still returned. */
  commentsError: string | null;
  pullRequest: WirePullRequestInfo | null;
  /** Explanation when PR info could not be fetched. */
  pullRequestError: string | null;
  /** `null` = unavailable (a PR without checks is different: that is state === "none"). */
  checks: WireCheckSummary | null;
};

/** Result of an issue / PR detail query. */
export type WireIssueDetailPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  detail: WireIssueDetail | null;
  error: string | null;
};

/** Result of a write action (comment / open / close / merge / create). */
export type WireIssueActionResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  /** On create, the new item's number; otherwise the number of the item acted on. */
  number: number;
  error: string | null;
};

/** Screenshot outcome: where it was saved, its size, and whether the clipboard got it. */
export type WireScreenshotSaved = {
  path: string;
  width: number;
  height: number;
  /** Why the image was saved but the clipboard write failed; null on success. */
  clipboardError: string | null;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export type GitBranchEntry = {
  name: string;
  kind: "local" | "worktree";
  worktreePath: string | null;
  isHead: boolean;
  isDetached: boolean;
};

export type GitBranchListResult = {
  branches: GitBranchEntry[];
};

/** One stash entry. `reference` looks like `stash@{0}`; commands take it verbatim. */
export type GitStashEntry = {
  reference: string;
  /** Position in the list; 0 is the newest entry. */
  index: number;
  message: string;
  /** Which branch this stash was created on; null when it cannot be parsed. */
  branch: string | null;
};

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  workspaceAuthorize: (path: string, env?: WorkspaceEnv) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: env ?? envForPath(path),
    }),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: envForPath(path),
    }),
  writeFile: (path: string, content: string) =>
    invoke<void>("fs_write_file", {
      path,
      content,
      workspace: envForPath(path),
    }),
  canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace: envForPath(path),
    }),
  createFile: (path: string) =>
    invoke<void>("fs_create_file", {
      path,
      workspace: envForPath(path),
    }),
  createDir: (path: string) =>
    invoke<void>("fs_create_dir", {
      path,
      workspace: envForPath(path),
    }),
  // AI tooling never sees dot-prefixed entries regardless of the user's
  // explorer preference — keeps .git / .env / .ssh out of agent context.
  readDir: (path: string) =>
    invoke<DirEntry[]>("fs_read_dir", {
      path,
      showHidden: false,
      workspace: envForPath(path),
    }),
  grep: (params: {
    pattern: string;
    root: string;
    glob?: string[];
    caseInsensitive?: boolean;
    maxResults?: number;
  }) =>
    invoke<GrepResponse>("fs_grep", {
      pattern: params.pattern,
      root: params.root,
      glob: params.glob ?? null,
      caseInsensitive: params.caseInsensitive ?? null,
      maxResults: params.maxResults ?? null,
      workspace: envForPath(params.root),
    }),
  glob: (params: { pattern: string; root: string; maxResults?: number }) =>
    invoke<GlobResponse>("fs_glob", {
      pattern: params.pattern,
      root: params.root,
      maxResults: params.maxResults ?? null,
      workspace: envForPath(params.root),
    }),
  runCommand: (command: string, cwd?: string | null, timeoutSecs?: number) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: envForPath(cwd),
    }),

  shellSessionOpen: (cwd?: string | null) =>
    invoke<number>("shell_session_open", {
      cwd: cwd ?? null,
      workspace: envForPath(cwd),
    }),
  shellSessionRun: (
    id: number,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      truncated: boolean;
      cwd_after: string;
    }>("shell_session_run", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: envForPath(cwd),
    }),
  shellSessionClose: (id: number) =>
    invoke<void>("shell_session_close", { id }),
  shellBgSpawn: (command: string, cwd?: string | null) =>
    invoke<number>("shell_bg_spawn", {
      command,
      cwd: cwd ?? null,
      workspace: envForPath(cwd),
    }),
  shellBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
  shellBgList: () =>
    invoke<
      {
        handle: number;
        command: string;
        cwd: string | null;
        started_at_ms: number;
        exited: boolean;
        exit_code: number | null;
      }[]
    >("shell_bg_list"),
  gitResolveRepo: (cwd: string) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: envForPath(cwd),
    }),
  /** Find git repos up to `depth` levels below root (default 2). */
  projectsScan: (root: string, depth?: number) =>
    invoke<string[]>("projects_scan", {
      root,
      maxDepth: depth ?? null,
    }),
  /** Batch project status; each row succeeds or fails on its own, with the
   * reason in its `error`. */
  projectsStatus: (items: WireProjectTarget[]) =>
    invoke<WireProjectStatus[]>("projects_status", { items }),
  /**
   * Remote repos the local gh can see (owned + collaborator + org), an
   * account-level query independent of the current workspace. Conditions like
   * gh missing or not logged in are reported via `kind` instead of throwing.
   */
  githubRepos: (limit?: number) =>
    invoke<WireRemoteReposPayload>("github_repos", { limit: limit ?? null }),
  /** Latest CI run for one repo; the UI calls it on demand, never for a whole list. */
  githubRepoCi: (repo: string) =>
    invoke<WireRepoCiPayload>("github_repo_ci", { repo }),
  /** Current account permission on one repo; also on demand, it decides whether
   * write buttons show. */
  githubRepoPermission: (repo: string) =>
    invoke<WireRepoPermissionPayload>("github_repo_permission", { repo }),
  /** Admin info for one repo (description / visibility / editability); fetched
   * once when the settings dialog opens. */
  githubRepoSettings: (repo: string) =>
    invoke<WireRepoSettingsPayload>("github_repo_settings", { repo }),
  /** Update the repo description; an empty string clears it. */
  githubRepoSetDescription: (repo: string, description: string) =>
    invoke<WireRepoActionResult>("github_repo_set_description", {
      repo,
      description,
    }),
  /** Change visibility; `private` = true makes it private. */
  githubRepoSetVisibility: (repo: string, isPrivate: boolean) =>
    invoke<WireRepoActionResult>("github_repo_set_visibility", {
      repo,
      private: isPrivate,
    }),
  /** Delete a repo (irreversible); the backend re-checks that it is really gone
   * before reporting success. */
  githubRepoDelete: (repo: string) =>
    invoke<WireRepoActionResult>("github_repo_delete", { repo }),
  /** Login state of the local gh. */
  githubAuthStatus: () =>
    invoke<WireAuthStatusPayload>("github_auth_status", {}),
  /** Log in with a pasted PAT; the token only crosses memory and goes to gh's stdin. */
  githubAuthLoginToken: (token: string) =>
    invoke<WireAuthActionPayload>("github_auth_login_token", { token }),
  /** Browser auth; gh's output streams out via the `verta://gh-auth` event. */
  githubAuthLoginWeb: () =>
    invoke<WireAuthActionPayload>("github_auth_login_web", {}),
  /** Abort the browser auth flow (kills that gh process). */
  githubAuthLoginWebCancel: () =>
    invoke<void>("github_auth_login_web_cancel", {}),
  /** Log out; the UI asks for confirmation before sending this. */
  githubAuthLogout: (login?: string) =>
    invoke<WireAuthActionPayload>("github_auth_logout", {
      login: login ?? null,
    }),
  /** Font families installed locally (feeds the settings dropdown); throws when
   * unreadable, and the UI falls back to a text field. */
  fontsList: () => invoke<string[]>("fonts_list", {}),
  /** Run list for a repo (20 by default). */
  githubRepoRuns: (repo: string, limit?: number) =>
    invoke<WireRepoActionRunsPayload>("github_repo_runs", {
      repo,
      limit: limit ?? null,
    }),
  /** Re-run a workflow run. */
  githubRunRerun: (repo: string, runId: number) =>
    invoke<WireRepoRunActionResult>("github_run_rerun", { repo, runId }),
  /** Cancel an in-progress run. */
  githubRunCancel: (repo: string, runId: number) =>
    invoke<WireRepoRunActionResult>("github_run_cancel", { repo, runId }),
  /** Delete a run's record (cannot be undone). */
  githubRunDelete: (repo: string, runId: number) =>
    invoke<WireRepoRunActionResult>("github_run_delete", { repo, runId }),
  /** Jobs and step tree of one run. */
  githubRunJobs: (repo: string, runId: number) =>
    invoke<WireRepoRunJobsPayload>("github_run_jobs", { repo, runId }),
  /** Log of one run; `failedOnly` restricts it to failed steps. */
  githubRunLog: (repo: string, runId: number, failedOnly?: boolean) =>
    invoke<WireRepoRunLogPayload>("github_run_log", {
      repo,
      runId,
      failedOnly: failedOnly ?? false,
    }),
  /** Release list for a repo (30 by default, bodies and assets included). */
  githubReleases: (repo: string, limit?: number) =>
    invoke<WireReleasesPayload>("github_releases", {
      repo,
      limit: limit ?? null,
    }) /**
   * Download one asset into `dir`. The frontend generates `id` and progress
   * events carry it. `total` is the asset size from the list, used for the
   * percentage and for an integrity check.
   */,
  githubReleaseDownload: (params: {
    id: string;
    repo: string;
    assetId: number;
    name: string;
    dir: string;
    total: number;
  }) =>
    invoke<WireReleaseDownloadResult>("github_release_download", {
      id: params.id,
      repo: params.repo,
      assetId: params.assetId,
      name: params.name,
      dir: params.dir,
      total: params.total,
    }),
  /** Cancel an in-progress download (looked up by the frontend-generated id). */
  githubReleaseDownloadCancel: (id: string) =>
    invoke<void>("github_release_download_cancel", { id }),
  /**
   * Issue / PR list for a repo. `state` is `open` / `closed` / `all`.
   * Kind filtering (issues only, PRs only) happens in the frontend, since one
   * request already returns both.
   */
  githubIssues: (repo: string, state: string, limit?: number) =>
    invoke<WireIssueListPayload>("github_issues", {
      repo,
      state,
      limit: limit ?? null,
    }),
  /** Detail of one issue / PR: body, comments, PR-only info, check status. */
  githubIssueDetail: (repo: string, number: number) =>
    invoke<WireIssueDetailPayload>("github_issue_detail", { repo, number }),
  /** Add a comment to an issue / PR. */
  githubIssueComment: (repo: string, number: number, body: string) =>
    invoke<WireIssueActionResult>("github_issue_comment", {
      repo,
      number,
      body,
    }),
  /** Open or close an issue (same for PRs). */
  githubIssueSetState: (repo: string, number: number, state: string) =>
    invoke<WireIssueActionResult>("github_issue_set_state", {
      repo,
      number,
      state,
    }),
  /** Create an issue. `labels` is a comma- or space-separated label list. */
  githubIssueCreate: (
    repo: string,
    title: string,
    body?: string,
    labels?: string,
  ) =>
    invoke<WireIssueActionResult>("github_issue_create", {
      repo,
      title,
      body: body ?? null,
      labels: labels ?? null,
    }),
  /** Merge a PR. `method` is `merge` / `squash` / `rebase`. */
  githubPrMerge: (repo: string, number: number, method?: string, headSha?: string) =>
    invoke<WireIssueActionResult>("github_pr_merge", {
      repo,
      number,
      method: method ?? null,
      headSha: headSha ?? null,
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: envForPath(cwd),
    }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: envForPath(repoRoot),
    }),
  gitDiff: (repoRoot: string, path: string | null, staged: boolean) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      staged,
      workspace: envForPath(repoRoot),
    }),
  gitDiffContent: (
    repoRoot: string,
    path: string,
    staged: boolean,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      staged,
      originalPath: originalPath ?? null,
      workspace: envForPath(repoRoot),
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: envForPath(repoRoot),
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: envForPath(repoRoot),
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: envForPath(repoRoot),
    }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      workspace: envForPath(repoRoot),
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: envForPath(repoRoot),
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
      workspace: envForPath(repoRoot),
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: envForPath(repoRoot),
    }),
  gitLog: (
    repoRoot: string,
    options?: { limit?: number; beforeSha?: string },
  ) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace: envForPath(repoRoot),
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: envForPath(repoRoot),
    }),
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace: envForPath(repoRoot),
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
      workspace: envForPath(repoRoot),
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace: envForPath(repoRoot),
    }),
  gitListBranches: (repoRoot: string) =>
    invoke<GitBranchListResult>("git_list_branches", {
      repoRoot,
      workspace: envForPath(repoRoot),
    }),
  gitCheckoutBranch: (repoRoot: string, branch: string) =>
    invoke<void>("git_checkout_branch", {
      repoRoot,
      branch,
      workspace: envForPath(repoRoot),
    }),
  gitStashList: (repoRoot: string) =>
    invoke<GitStashEntry[]>("git_stash_list", {
      repoRoot,
      workspace: envForPath(repoRoot),
    }),
  gitStashPush: (
    repoRoot: string,
    message: string | null,
    includeUntracked: boolean,
  ) =>
    invoke<void>("git_stash_push", {
      repoRoot,
      message,
      includeUntracked,
      workspace: envForPath(repoRoot),
    }),
  gitStashApply: (repoRoot: string, reference: string) =>
    invoke<void>("git_stash_apply", {
      repoRoot,
      reference,
      workspace: envForPath(repoRoot),
    }),
  gitStashPop: (repoRoot: string, reference: string) =>
    invoke<void>("git_stash_pop", {
      repoRoot,
      reference,
      workspace: envForPath(repoRoot),
    }),
  /** Drop a stash. The user must have confirmed beforehand. */
  gitStashDrop: (repoRoot: string, reference: string) =>
    invoke<void>("git_stash_drop", {
      repoRoot,
      reference,
      workspace: envForPath(repoRoot),
    }),
  /** Create a branch; with `switchTo` it also checks it out right away. */
  gitCreateBranch: (
    repoRoot: string,
    name: string,
    startPoint: string | null,
    switchTo: boolean,
  ) =>
    invoke<void>("git_create_branch", {
      repoRoot,
      name,
      startPoint,
      switch: switchTo,
      workspace: envForPath(repoRoot),
    }),
  /** Delete a branch. `force` maps to `-D` and discards unmerged commits. */
  gitDeleteBranch: (repoRoot: string, name: string, force: boolean) =>
    invoke<void>("git_delete_branch", {
      repoRoot,
      name,
      force,
      workspace: envForPath(repoRoot),
    }),
  gitRenameBranch: (repoRoot: string, from: string, to: string) =>
    invoke<void>("git_rename_branch", {
      repoRoot,
      from,
      to,
      workspace: envForPath(repoRoot),
    }),
  /** Create a worktree and return the path of the new directory. */
  gitWorktreeAdd: (
    repoRoot: string,
    path: string,
    branch: string,
    createNewBranch: boolean,
    startPoint: string | null,
  ) =>
    invoke<string>("git_worktree_add", {
      repoRoot,
      path,
      branch,
      createNewBranch,
      startPoint,
      workspace: envForPath(repoRoot),
    }),
  /** Remove a worktree. `force` discards uncommitted changes in it. */
  gitWorktreeRemove: (repoRoot: string, path: string, force: boolean) =>
    invoke<void>("git_worktree_remove", {
      repoRoot,
      path,
      force,
      workspace: envForPath(repoRoot),
    }),
  gitCherryPick: (repoRoot: string, sha: string) =>
    invoke<void>("git_cherry_pick", {
      repoRoot,
      sha,
      workspace: envForPath(repoRoot),
    }),
  gitRevertCommit: (repoRoot: string, sha: string) =>
    invoke<void>("git_revert_commit", {
      repoRoot,
      sha,
      workspace: envForPath(repoRoot),
    }),
  /** Soft reset: move the branch pointer back to this commit, keeping the
   * worktree and index. */
  gitResetSoft: (repoRoot: string, sha: string) =>
    invoke<void>("git_reset_soft", {
      repoRoot,
      sha,
      workspace: envForPath(repoRoot),
    }),
  /** Abort a stuck cherry-pick or revert. */
  gitAbortOperation: (repoRoot: string, kind: "cherry-pick" | "revert") =>
    invoke<void>("git_abort_operation", {
      repoRoot,
      kind,
      workspace: envForPath(repoRoot),
    }),
  /** Clone a repo into `dest` and return the resulting directory path. */
  gitCloneRepo: (url: string, dest: string) =>
    invoke<string>("git_clone_repo", {
      url,
      dest,
      workspace: envForPath(dest),
    }),
  screenshotBegin: () => invoke<void>("screenshot_begin"),
  /**
   * Crop to the selection, save into the Pictures\Screenshots folder, and copy
   * it to the clipboard.
   *
   * The backend hides the overlay before grabbing the screen (otherwise the dim
   * layer and the selection box end up in the image), so the rect passed here
   * is relative to the top-left of the whole virtual desktop; `cornerRadius` is
   * the corner radius in physical pixels.
   */
  screenshotFinish: (
    rect: { x: number; y: number; width: number; height: number },
    cornerRadius: number,
  ) => invoke<WireScreenshotSaved>("screenshot_finish", { rect, cornerRadius }),
  /** Cancel this capture (via Esc, or a click without a drag). */
  screenshotCancel: () => invoke<void>("screenshot_cancel"),
  /** Report an overlay-window failure back to the main window instead of vanishing silently. */
  screenshotFailed: (message: string) =>
    invoke<void>("screenshot_failed", { message }),
};
