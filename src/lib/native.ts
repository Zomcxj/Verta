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

/** 项目列表：扫描与状态查询的线格式。 */
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

/** 远程仓库：一个仓库的线格式。 */
export type WireRemoteRepo = {
  fullName: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  language: string | null;
  /** GitHub 原样给的 ISO8601，界面自己折成相对时间。 */
  pushedAt: string | null;
  description: string | null;
  webUrl: string;
};

/**
 * 远程仓库列表的返回。`kind` 说明这次读到了什么，`ready` 才是真的读到了（哪怕
 * 列表是空的）；读不到时 `error` 里是 gh 的原话，不伪装成空列表。
 */
export type WireRemoteReposPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  login: string | null;
  accountName: string | null;
  repos: WireRemoteRepo[];
  /** 取到翻页上限，后面的仓库没要。 */
  truncated: boolean;
  error: string | null;
};

/** 一个仓库最近一次 workflow 运行。 */
export type WireRepoCiRun = {
  /** workflow 名字。 */
  name: string;
  /** `queued` / `in_progress` / `completed` 等，GitHub 原样给的值。 */
  status: string;
  /** `success` / `failure` / `cancelled` 等；还没跑完时是 null。 */
  conclusion: string | null;
  runNumber: number;
  headBranch: string | null;
  /** ISO8601，界面自己折成相对时间。 */
  updatedAt: string | null;
  url: string;
};

/**
 * 单个仓库的 CI 查询结果。
 * `none` 是查清楚了的「没有运行记录」，不是失败。
 */
export type WireRepoCiPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  run: WireRepoCiRun | null;
  error: string | null;
};

/**
 * 一个仓库的当前账号权限。
 *
 * `canWrite` 为 false 时界面不渲染写操作按钮；查不动（`notInstalled` / `notLoggedIn` / `error`）
 * 时后端给的也是 true，按钮照常渲染，点了让 GitHub 去拒绝。
 */
export type WireRepoPermissionPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  /** `ADMIN` / `MAINTAIN` / `WRITE` / `TRIAGE` / `READ`；查不到时是 null。 */
  permission: string | null;
  canWrite: boolean;
  error: string | null;
};

/**
 * 一个仓库的管理信息（描述、可见性、能不能改）。
 *
 * `canAdmin` 为 false 时界面不渲染改描述 / 切可见性 / 删除；查不动时后端给的也是 true。
 */
export type WireRepoSettingsPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  description: string | null;
  /** `PUBLIC` / `PRIVATE` / `INTERNAL`；拿不到时是 null。 */
  visibility: string | null;
  canAdmin: boolean;
  error: string | null;
};

/** 一次仓库管理动作（改描述 / 切可见性 / 删仓库）的结果。 */
export type WireRepoActionResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  error: string | null;
};

/**
 * 本机 gh 的登录态。
 *
 * `none` 是查清楚了的「一个 host 都没登」，不是错误。**token 本身永远不在这里。**
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

/** 一次登录 / 登出动作的结果；`cancelled` 是用户自己中止的浏览器授权。 */
export type WireAuthActionPayload = {
  kind: "ready" | "cancelled" | "notInstalled" | "error";
  /** 浏览器授权时 gh 打出来的那些话（一次性码、失败原因）。 */
  output: string | null;
  error: string | null;
};

/** 浏览器授权过程中 gh 打出来的一段话。 */
export type WireAuthLoginProgress = { text: string };

/** 运行列表里的一条（重跑/取消要用 `id`）。 */
export type WireRepoActionRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  runNumber: number;
  headBranch: string | null;
  /** `push` / `pull_request` / `workflow_dispatch` 等，GitHub 原样给的值。 */
  event: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
};

/** 某个仓库的运行列表；`none` 是查清楚了的「没有运行记录」，不是失败。 */
export type WireRepoActionRunsPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runs: WireRepoActionRun[];
  error: string | null;
};

/** 重跑 / 取消的结果：成功不带数据，失败时 `error` 是 gh 的原话。 */
export type WireRepoRunActionResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runId: number;
  error: string | null;
};

/** 运行详情里的一个步骤。 */
export type WireRepoRunStep = {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
};

/** 运行详情里的一个 job（含它的步骤树）。 */
export type WireRepoRunJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string | null;
  /** 跑在哪个 runner 上；GitHub 没给就用第一个 label 兜底。 */
  runner: string | null;
  steps: WireRepoRunStep[];
};

/** 一次运行的 job 列表；`none` 是「这个运行里一个 job 都没有」。 */
export type WireRepoRunJobsPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  runId: number;
  jobs: WireRepoRunJob[];
  error: string | null;
};

/** 日志的一行：前缀拆成了 job / step / 时间。 */
export type WireRepoRunLogLine = {
  job: string;
  step: string;
  /** ISO8601，认不出来时是空串。 */
  time: string;
  text: string;
};

/**
 * 一次运行的日志。
 * `clipped` 是我们只留了尾部；`capped` 是一次能取的上限就被撑满了（拿到的是开头）。
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

/** 一个 Release 里的附件。`id` 是下载时要带回去的那个。 */
export type WireReleaseAsset = {
  id: number;
  name: string;
  /** 字节数；GitHub 没给时是 0。 */
  size: number;
  downloadCount: number;
  contentType: string | null;
  updatedAt: string | null;
};

/** 一个 Release：正文与附件都在列表响应里，详情不再另发一次请求。 */
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

/** 某个仓库的 Release 列表；空列表是查清楚了的「没有 Release」。 */
export type WireReleasesPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  releases: WireRelease[];
  error: string | null;
};

/** 下载进度：后端按 64 KiB / 100 ms 合并后推过来。 */
export type WireReleaseDownloadProgress = {
  id: string;
  written: number;
  total: number;
};

/** 一次下载的结局；取消不是错误。 */
export type WireReleaseDownloadResult = {
  kind: "ok" | "cancelled" | "error";
  path: string | null;
  error: string | null;
};

/**
 * 一条 issue 或 PR（列表用）。
 *
 * GitHub 的 `issues` 端点两者都返回，PR 多带一个 `pull_request` 对象 ——
 * `isPullRequest` 就是照那个字段判的。
 */
export type WireIssueSummary = {
  number: number;
  title: string;
  /** 正文。列表不显示，但筛关键字要用，所以一并带上。 */
  body: string;
  /** `open` / `closed`。 */
  state: string;
  isPullRequest: boolean;
  /** 草稿只有 PR 详情里有；列表端点给不出。 */
  isDraft: boolean;
  /** 已经合进基线（PR 专有）。 */
  merged: boolean;
  author: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** 评论条数。 */
  comments: number;
  labels: string[];
  assignees: string[];
  htmlUrl: string;
  /** 锁了的不能评论。 */
  locked: boolean;
};

/** 某个仓库的 issue / PR 列表。 */
export type WireIssueListPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  issues: WireIssueSummary[];
  /** 到了条数上限且最后一页仍是满页：后面多半还有没取。 */
  truncated: boolean;
  error: string | null;
};

/** 一条评论。 */
export type WireIssueComment = {
  id: number;
  author: string;
  body: string;
  createdAt: string | null;
};

/** PR 专属信息（普通 issue 没有这一块）。 */
export type WirePullRequestInfo = {
  head: string;
  headSha: string;
  base: string;
  draft: boolean;
  merged: boolean;
  /** `null` = GitHub 还在算（异步），不是「不能合」。 */
  mergeable: boolean | null;
  mergeableState: string;
  /** 现在为什么合不了；能合时是 null。后端算好送出来，界面只照着禁按钮。 */
  mergeBlockedReason: string | null;
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

/** 检查状态汇总。 */
export type WireCheckSummary = {
  total: number;
  ok: number;
  failed: number;
  pending: number;
  state: "pass" | "fail" | "pending" | "none";
};

/** 一条 issue / PR 的详情。 */
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
  /** 评论取不到时的说明；正文照样给。 */
  commentsError: string | null;
  pullRequest: WirePullRequestInfo | null;
  /** PR 信息取不到时的说明。 */
  pullRequestError: string | null;
  /** `null` = 取不到（与「这个 PR 没有检查」不同，那种是 state === "none"）。 */
  checks: WireCheckSummary | null;
};

/** 一条 issue / PR 的详情查询结果。 */
export type WireIssueDetailPayload = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  detail: WireIssueDetail | null;
  error: string | null;
};

/** 一次写操作（评论 / 开 / 关 / 合并 / 新建）的结果。 */
export type WireIssueActionResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  /** 新建 issue 时是新条目的编号；其它操作是被操作的条目编号。 */
  number: number;
  error: string | null;
};

/** 抓下来的一整屏（所有显示器拼起来那块），给覆盖窗口显示用。 */
export type WireScreenshotShot = {
  /** 覆盖窗口显示用的预览图，`convertFileSrc` 直接能读。 */
  previewPath: string;
  /** 整屏的物理像素尺寸。 */
  width: number;
  height: number;
};

/** 截图收尾的交代：存哪了、多大、剪贴板有没有写进去。 */
export type WireScreenshotSaved = {
  path: string;
  width: number;
  height: number;
  /** 图存好了、但剪贴板没写成功时的原因；成了就是 null。 */
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

/** 一条储藏。`reference` 形如 `stash@{0}`，操作命令原样带回去。 */
export type GitStashEntry = {
  reference: string;
  /** 列表里的顺序，0 是最新的一条。 */
  index: number;
  message: string;
  /** 这条储藏建在哪个分支上；解析不出时为 null。 */
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
  runCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
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
  /** 扫描 root 之下 depth 层以内的 git 仓库（默认 2）。 */
  projectsScan: (root: string, depth?: number) =>
    invoke<string[]>("projects_scan", {
      root,
      maxDepth: depth ?? null,
    }),
  /** 批量取项目状态；每条独立成败，失败原因在该行的 error 里。 */
  projectsStatus: (items: WireProjectTarget[]) =>
    invoke<WireProjectStatus[]>("projects_status", { items }),
  /**
   * 本机 gh 读到的远程仓库（自己的 + 协作的 + 组织的），账号级查询，与当前空间无关。
   * 没装 gh、没登录等状态由返回的 kind 说明，不抛异常。
   */
  githubRepos: (limit?: number) =>
    invoke<WireRemoteReposPayload>("github_repos", { limit: limit ?? null }),
  /** 单个仓库最近一次 CI 运行；由界面按需调用，别对整份列表批量查。 */
  githubRepoCi: (repo: string) =>
    invoke<WireRepoCiPayload>("github_repo_ci", { repo }),
  /** 单个仓库的当前账号权限；同样按需调用，界面据此决定写操作按钮在不在。 */
  githubRepoPermission: (repo: string) =>
    invoke<WireRepoPermissionPayload>("github_repo_permission", { repo }),
  /** 单个仓库的管理信息（描述 / 可见性 / 能不能改）；打开设置弹窗时调一次。 */
  githubRepoSettings: (repo: string) =>
    invoke<WireRepoSettingsPayload>("github_repo_settings", { repo }),
  /** 改仓库描述；空串即清空。 */
  githubRepoSetDescription: (repo: string, description: string) =>
    invoke<WireRepoActionResult>("github_repo_set_description", {
      repo,
      description,
    }),
  /** 切可见性；`private` 为 true 是私有。 */
  githubRepoSetVisibility: (repo: string, isPrivate: boolean) =>
    invoke<WireRepoActionResult>("github_repo_set_visibility", {
      repo,
      private: isPrivate,
    }),
  /** 删仓库（不可撤销）；后端发完请求会回查确认真的没了才报成功。 */
  githubRepoDelete: (repo: string) =>
    invoke<WireRepoActionResult>("github_repo_delete", { repo }),
  /** 本机 gh 的登录态。 */
  githubAuthStatus: () => invoke<WireAuthStatusPayload>("github_auth_status", {}),
  /** 用粘贴的 PAT 登录；token 只经过内存，写进 gh 的 stdin。 */
  githubAuthLoginToken: (token: string) =>
    invoke<WireAuthActionPayload>("github_auth_login_token", { token }),
  /** 浏览器授权；gh 打出来的话通过 `verta://gh-auth` 事件流出来。 */
  githubAuthLoginWeb: () =>
    invoke<WireAuthActionPayload>("github_auth_login_web", {}),
  /** 中止浏览器授权（杀掉那个 gh 进程）。 */
  githubAuthLoginWebCancel: () =>
    invoke<void>("github_auth_login_web_cancel", {}),
  /** 登出；界面上要求确认过才发这条。 */
  githubAuthLogout: (login?: string) =>
    invoke<WireAuthActionPayload>("github_auth_logout", { login: login ?? null }),
  /** 本机已安装的字体族（给设置里的字体下拉用）；读不到时抛错，界面退回手输框。 */
  fontsList: () => invoke<string[]>("fonts_list", {}),
  /** 某个仓库的运行列表（默认 20 条）。 */
  githubRepoRuns: (repo: string, limit?: number) =>
    invoke<WireRepoActionRunsPayload>("github_repo_runs", {
      repo,
      limit: limit ?? null,
    }),
  /** 重跑一次运行。 */
  githubRunRerun: (repo: string, runId: number) =>
    invoke<WireRepoRunActionResult>("github_run_rerun", { repo, runId }),
  /** 取消一次正在进行的运行。 */
  githubRunCancel: (repo: string, runId: number) =>
    invoke<WireRepoRunActionResult>("github_run_cancel", { repo, runId }),
  /** 删掉一次运行的记录（不可恢复）。 */
  githubRunDelete: (repo: string, runId: number) =>
    invoke<WireRepoRunActionResult>("github_run_delete", { repo, runId }),
  /** 一次运行的 job 与步骤树。 */
  githubRunJobs: (repo: string, runId: number) =>
    invoke<WireRepoRunJobsPayload>("github_run_jobs", { repo, runId }),
  /** 一次运行的日志；`failedOnly` 为真时只看失败步骤的日志。 */
  githubRunLog: (repo: string, runId: number, failedOnly?: boolean) =>
    invoke<WireRepoRunLogPayload>("github_run_log", {
      repo,
      runId,
      failedOnly: failedOnly ?? false,
    }),
  /** 某个仓库的 Release 列表（默认 30 条，正文与附件都在里面）。 */
  githubReleases: (repo: string, limit?: number) =>
    invoke<WireReleasesPayload>("github_releases", {
      repo,
      limit: limit ?? null,
    }),  /**
   * 把一个附件下载到 `dir`。`id` 由前端生成，进度事件带着它；
   * `total` 是列表里那份附件大小，用来算百分比与校验完整性。
   */
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
  /** 取消一次正在进行的下载（按前端生成的 id 找）。 */
  githubReleaseDownloadCancel: (id: string) =>
    invoke<void>("github_release_download_cancel", { id }),
  /**
   * 某个仓库的 issue / PR 列表。`state` 是 `open` / `closed` / `all`。
   * 类型筛选（只看 issue 或只看 PR）在前端做 —— 一次请求两类都回来了。
   */
  githubIssues: (repo: string, state: string, limit?: number) =>
    invoke<WireIssueListPayload>("github_issues", {
      repo,
      state,
      limit: limit ?? null,
    }),
  /** 一条 issue / PR 的详情：正文、评论、PR 专属信息、检查状态。 */
  githubIssueDetail: (repo: string, number: number) =>
    invoke<WireIssueDetailPayload>("github_issue_detail", { repo, number }),
  /** 给 issue / PR 加一条评论。 */
  githubIssueComment: (repo: string, number: number, body: string) =>
    invoke<WireIssueActionResult>("github_issue_comment", { repo, number, body }),
  /** 打开或关闭一条 issue（PR 也一样）。 */
  githubIssueSetState: (repo: string, number: number, state: string) =>
    invoke<WireIssueActionResult>("github_issue_set_state", {
      repo,
      number,
      state,
    }),
  /** 新建一个 issue。`labels` 是逗号 / 空格分隔的标签名。 */
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
  /** 合并一个 PR。`method` 是 `merge` / `squash` / `rebase`。 */
  githubPrMerge: (repo: string, number: number, method?: string) =>
    invoke<WireIssueActionResult>("github_pr_merge", {
      repo,
      number,
      method: method ?? null,
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
  gitLog: (repoRoot: string, options?: { limit?: number; beforeSha?: string }) =>
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
  /** 丢弃储藏。调用前必须让用户确认过。 */
  gitStashDrop: (repoRoot: string, reference: string) =>
    invoke<void>("git_stash_drop", {
      repoRoot,
      reference,
      workspace: envForPath(repoRoot),
    }),
  /** 新建分支；`switchTo` 为真时建完直接切过去。 */
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
  /** 删除分支。`force` 走 `-D`，会丢掉未合并的提交。 */
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
  /** 新建 worktree，返回新目录路径。 */
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
  /** 移除 worktree。`force` 会丢掉那里的未提交改动。 */
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
  /** 软撤回：分支指针退到该提交，工作区与暂存区保留。 */
  gitResetSoft: (repoRoot: string, sha: string) =>
    invoke<void>("git_reset_soft", {
      repoRoot,
      sha,
      workspace: envForPath(repoRoot),
    }),
  /** 中止卡住的拣选或还原。 */
  gitAbortOperation: (repoRoot: string, kind: "cherry-pick" | "revert") =>
    invoke<void>("git_abort_operation", {
      repoRoot,
      kind,
      workspace: envForPath(repoRoot),
    }),
  /** 克隆仓库到 `dest`，返回落地的目录路径。 */
  gitCloneRepo: (url: string, dest: string) =>
    invoke<string>("git_clone_repo", {
      url,
      dest,
      workspace: envForPath(dest),
    }),
  /** 抓整屏并摆好覆盖窗口（主窗口里点「截图」时调）。 */
  screenshotBegin: () => invoke<WireScreenshotShot>("screenshot_begin"),
  /** 覆盖窗口挂载后问一次：这次显示哪张图；没有正在选的就是 null。 */
  screenshotPending: () => invoke<WireScreenshotShot | null>("screenshot_pending"),
  /** 按选区裁剪、存进「图片\屏幕截图」、送进剪贴板。 */
  screenshotFinish: (rect: { x: number; y: number; width: number; height: number }) =>
    invoke<WireScreenshotSaved>("screenshot_finish", { rect }),
  /** 取消这次截图（Esc，或者点一下没拖）。 */
  screenshotCancel: () => invoke<void>("screenshot_cancel"),
  /** 覆盖窗口自己出岔子时的交代：把原文报回主窗口，别不吭声地消失。 */
  screenshotFailed: (message: string) => invoke<void>("screenshot_failed", { message }),
};
