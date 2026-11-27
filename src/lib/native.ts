import { invoke } from "@tauri-apps/api/core";
import { envForPath, type WorkspaceEnv } from "@/modules/workspace";

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/** One styled piece of a paragraph's text. */
export type DocxRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Struck through, by a single line: `w:strike` or `w:dstrike`. */
  strike: boolean;
  /** The marker colour Word names (`yellow`, `cyan`, …); absent means not highlighted. */
  highlight?: string | null;
  /** Above or below the line, when the run is raised or lowered. */
  vertical?: "superscript" | "subscript" | null;
  /** `#rrggbb` when the run paints its own background (`w:shd` in its run properties). */
  shade?: string | null;
  /** Point size, when the file names one. */
  size: number | null;
  /** `#rrggbb`, when the run is not the document's own text colour. */
  color: string | null;
  /** The font the run names, Latin or East Asian. */
  font: string | null;
  /** A picture in this run, as a `data:` URL. */
  image: string | null;
  /** The size the document draws it at, in px. */
  imageWidth: number | null;
  imageHeight: number | null;
  /**
   * Which of the paragraph's drawings this is, counted from zero in the order the file writes them.
   *
   * It is the address a deletion names, and it counts drawings rather than pictures that survived the
   * size cap, so a skipped picture does not shift the ones after it.
   */
  imageIndex?: number | null;
};

/** A paragraph's indents, in twips; a negative `firstLine` is a hanging indent. */
export type DocxIndent = { left: number | null; firstLine: number | null };

/** Space around a paragraph, in twips; `line` is 240ths of a line for `auto`, twips otherwise. */
export type DocxSpacing = {
  before: number | null;
  after: number | null;
  line: number | null;
  lineRule: string | null;
};

/** The section's paper, in twips. */
export type DocxPage = {
  width: number | null;
  height: number | null;
  marginTop: number | null;
  marginRight: number | null;
  marginBottom: number | null;
  marginLeft: number | null;
};

/** One cell of a table: its text, and the fill the cell states. */
export type DocxCell = {
  runs: DocxRun[];
  /** `#rrggbb` when the cell paints its own background; absent means the paper shows through. */
  shade?: string | null;
};

export type DocxBlock =
  | {
      kind: "paragraph";
      /**
       * Which `<w:p>` of the document part this is, counted from zero.
       *
       * It is the link between what is drawn and the element the writer has to touch, so it counts
       * every paragraph of the part - the ones inside tables and the empty ones included.
       */
      index: number;
      heading: number | null;
      /** `numId` names the numbering definition: two adjacent lists with different ids are two lists. */
      list: { ordered: boolean; level: number; numId: number } | null;
      runs: DocxRun[];
      /** `left` / `center` / `right` / `both`; absent means left. */
      align: string | null;
      /** The size its text inherits, in points - what an empty line is as tall as. */
      size: number | null;
      indent: DocxIndent | null;
      spacing: DocxSpacing | null;
      /** `#rrggbb` when the paragraph paints its own line. */
      shade?: string | null;
    }
  | { kind: "table"; rows: DocxCell[][] }
  /**
   * The text of a note the block above cites: a footnote, an endnote or a comment.
   *
   * It is drawn after that block and is not typed into: the pane writes one text per paragraph, and
   * a note folded into its paragraph's text would be saved into the body of the document.
   */
  | {
      kind: "note";
      source: "footnote" | "endnote" | "comment";
      text: string;
      /** Who wrote it; only a comment names one, and the pane shows it when it is there. */
      author?: string | null;
    };

/**
 * What the file looked like when it was read.
 *
 * The writer refuses when this no longer matches, so a document saved in Word between the read and
 * the edit is never overwritten.
 */
export type DocxGuard = { size: number; modifiedMs: number };

/** What the Rust side reads out of a `.docx`; `truncated` means the document was longer than the
 * block ceiling and what is here is its beginning. */
export type DocxDocument = {
  blocks: DocxBlock[];
  /** The paper the section declares; absent means the pane draws A4. */
  page: DocxPage | null;
  truncated: boolean;
  /** Whether the pane may edit this document in place; a truncated read may not be written back. */
  editable: boolean;
  /**
   * Pictures the document named that the pane cannot draw - a format the webview does not decode
   * (WMF, EMF, TIFF) or one past the size cap. They are not drawn; the pane says how many so a
   * figure that is missing does not read as a document that lost it.
   */
  undrawnPictures: number;
  /** The file's identity when it was read; the writer refuses if it no longer matches. */
  guard: DocxGuard;
};

/**
 * A `.csv` as a table, read by the Rust side.
 *
 * The pane draws it and edits cells; the parsing (delimiter, quoting, encoding) is not the frontend's
 * business.
 */
export type CsvDocument = {
  delimiter: string;
  rows: string[][];
  columns: number;
  truncated: boolean;
  guard: DocxGuard;
};

/**
 * How a worksheet's cell is drawn. The Rust side deduplicates these, so a sheet carries only the
 * handful its cells actually use and each cell names one by index.
 */
export type XlsxCellStyle = {
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right" | null;
  color: string | null;
  fill: string | null;
  /** The format code the value was written with, when it is not `General`. */
  numberFormat: string | null;
  wrap: boolean;
};

/**
 * One cell of a worksheet.
 *
 * `text` is what to draw: the number format is applied in Rust, where its rules have tests. `raw`
 * is the value under it, present only when the format changed it, so a date can still be read as
 * the serial number it is stored as.
 */
export type XlsxCell = {
  column: number;
  text: string;
  kind: "number" | "text" | "boolean" | "error";
  style: number;
  raw?: string;
  /** Index into the sheet's `styles` of what a conditional rule paints here, when one does. */
  conditional?: number;
};

/** A row that has something in it; a sheet's empty middle is not sent. */
export type XlsxRow = { index: number; height?: number; cells: XlsxCell[] };

/** A merged region, as its corner and how far it reaches. */
export type XlsxMerge = {
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
};

/** A column's width or a row's height, in pixels. */
export type XlsxTrack = { index: number; size: number };

/** One worksheet, ready to draw. */
export type XlsxSheet = {
  name: string;
  rows: XlsxRow[];
  rowCount: number;
  columns: number;
  merges: XlsxMerge[];
  columnSizes: XlsxTrack[];
  rowHeights: XlsxTrack[];
  frozenRows: number;
  frozenColumns: number;
  styles: XlsxCellStyle[];
  truncated: boolean;
};

/** A workbook's sheets, in the order its tabs are drawn in. */
export type XlsxWorkbook = {
  sheets: { name: string; index: number }[];
  truncated: boolean;
};

export type PptxRun = {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Point size. */
  size?: number;
  color?: string;
  font?: string;
};

export type PptxParagraph = {
  align?: "left" | "center" | "right" | "justify";
  level: number;
  bullets: boolean;
  runs: PptxRun[];
};

/**
 * One shape on a slide, placed in the slide's own pixels at 96 dpi.
 *
 * `image` is a `data:` URL, because a picture inside the archive has nothing on disk to fetch it
 * from. A shape whose picture was too large keeps its box and has no image.
 */
export type PptxShape = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise. */
  rotation?: number;
  kind: "text" | "picture" | "other";
  fill?: string;
  image?: string;
  paragraphs: PptxParagraph[];
};

export type PptxSlide = {
  index: number;
  shapes: PptxShape[];
  /** `#rrggbb` the slide is drawn on; absent means white paper. */
  background?: string;
  /**
   * A picture the slide is drawn on, as a `data:` URL, from the slide, its layout or its master.
   */
  backgroundImage?: string;
  /**
   * A CSS `linear-gradient(...)` the slide is drawn on, from the same three levels.
   *
   * A paper states exactly one of a colour, a picture and a gradient, because a level answers as a
   * whole.
   */
  backgroundGradient?: string;
};

/** A deck: the box every slide is placed in, and each slide's shapes. */
export type PptxDocument = {
  width: number;
  height: number;
  slides: PptxSlide[];
  truncated: boolean;
  /** Pictures the deck named that the pane cannot draw; see `DocxDocument.undrawnPictures`. */
  undrawnPictures: number;
};

/** One paragraph's new text, addressed by its ordinal. */
export type DocxEdit = { index: number; text: string };

/** A paragraph to add after another one; the document must have the one it names. */
/** A paragraph to add. `after: null` puts it in front of everything in the body. */
export type DocxInsert = { after: number | null; text: string };



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
  /** Lines added and removed against HEAD; `null` when git cannot say (a binary or untracked file, or a read that failed). */
  added: number | null;
  removed: number | null;
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
  /** A shallow clone: the work tree is the newest commit and nothing behind it. */
  shallow: boolean;
  error: string | null;
  /** Why the fetch this check asked for failed; null when it worked or was not asked for. */
  fetchError: string | null;
};

/** What one "replace with the remote" did, and what it cost. */
export type WireProjectReplaceReport = {
  branch: string;
  upstream: string;
  previousHead: string;
  head: string;
  /** True when the copy is shallow afterwards - one commit and nothing behind it. */
  shallow: boolean;
  discardedCommits: number;
  discardedFiles: number;
};

/** What one pull from the project list did (the row re-reads its status afterwards). */
export type WireProjectPullOutcome = {
  path: string;
  branch: string;
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
 * Whether one repository has anything new to look at: the newest update among its open pull
 * requests and issues.
 *
 * `none` is a confirmed "nothing is open here", not a failure - the difference matters, because a
 * failed read must not be drawn as "nothing new".
 */
export type WireRepoActivityPayload = {
  kind: "ready" | "none" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  /** ISO8601 of the newest open PR / issue update; null when nothing is open. */
  latest: string | null;
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

/** Outcome of editing the stored title and notes of one release. */
export type WireReleaseEditResult = {
  kind: "ready" | "notInstalled" | "notLoggedIn" | "error";
  repo: string;
  id: number;
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

/** One commit of a PR's commit list (a single row). */
export type WirePullRequestCommit = {
  sha: string;
  /** First line of the commit message only. */
  summary: string;
  author: string;
  htmlUrl: string;
};

/** One check of a PR (a single read-only row). */
export type WireCheckItem = {
  /** GitHub's run id; 0 when it sent none (the UI then keys the row by name). */
  id: number;
  name: string;
  /**
   * Same classification as the rollup: `pass` / `skipped` / `neutral` all feed `ok`
   * there (as GitHub rolls them up), so a row cannot contradict the badge above it.
   */
  state: "pass" | "fail" | "pending" | "skipped" | "neutral";
  /** The check's page on GitHub; `null` when GitHub sent no link. */
  url: string | null;
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
  /**
   * The rows actually seen, one per check of the fetched pages (the list costs no
   * extra request). Fewer rows than `total` is the same shortfall `truncated` reports.
   */
  items: WireCheckItem[];
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
  /**
   * PRs only. `null` = unavailable (a PR with no commits is different: that is an
   * empty list). At most one page is fetched, so `ISSUE_COMMITS_PAGE_SIZE` rows back
   * means there are probably more.
   */
  commits: WirePullRequestCommit[] | null;
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

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  /**
   * The Windows spelling of a path a POSIX shell reported, or `null` when there is nothing to say.
   *
   * `null` covers both "this spelling is already usable" and "the shell could not say", so the caller
   * keeps the spelling it had; the shell is the leaf's own, because only the install that spelled a
   * path can translate it.
   */
  translatePath: (path: string, shell?: string | null) =>
    invoke<string | null>("translate_path", { path, shell: shell ?? null }),
  workspaceAuthorize: (path: string, env?: WorkspaceEnv) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: env ?? envForPath(path),
    }),
  notesDir: () => invoke<string>("notes_dir"),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: envForPath(path),
    }),
  // A `.docx` is not a text file and not an image, so it has a reader of its own: the archive is
  // opened in Rust and comes back as blocks. See `src/modules/editor/DocxPreview.tsx`.
  /** A `.csv` as a table. Read-only; a cell is changed through `writeCsvCell`. */
  readCsv: (path: string) =>
    invoke<CsvDocument>("fs_read_csv", {
      path,
      workspace: envForPath(path),
    }),
  /**
   * Change one field of a `.csv`.
   *
   * Only that field's bytes are replaced, so the file's own quoting, line endings and untouched
   * fields come back exactly as they were. `guard` is the identity the pane read; a file that has
   * changed since is refused rather than merged.
   */
  writeCsvCell: (
    path: string,
    row: number,
    column: number,
    text: string,
    guard: DocxGuard,
  ) =>
    invoke<DocxGuard>("fs_write_csv_cell", {
      path,
      row,
      column,
      text,
      guard,
      workspace: envForPath(path),
    }),
  readDocx: (path: string) =>
    invoke<DocxDocument>("fs_read_docx", {
      path,
      workspace: envForPath(path),
    }),
  /**
   * A workbook's sheet list.
   *
   * Read on its own so the pane can draw the tabs without reading a sheet: a workbook of fifty
   * sheets read whole is a payload of tens of megabytes for the one the user is looking at.
   */
  readXlsx: (path: string) =>
    invoke<XlsxWorkbook>("fs_read_xlsx", {
      path,
      workspace: envForPath(path),
    }),
  /** One sheet of a workbook, by the name the workbook gives it. */
  readXlsxSheet: (path: string, name: string) =>
    invoke<XlsxSheet>("fs_read_xlsx_sheet", {
      path,
      name,
      workspace: envForPath(path),
    }),
  /** A presentation, as the slides it holds. Read-only; nothing here writes. */
  readPptx: (path: string) =>
    invoke<PptxDocument>("fs_read_pptx", {
      path,
      workspace: envForPath(path),
    }),
  /**
   * Takes back the last change to a `.docx` and returns its new identity.
   *
   * Undo restores the document part that was there before the last write, which is the only way to
   * bring back a deleted paragraph: its XML is not in the model any more.
   */
  /**
   * Takes one picture out of a `.docx`, named by the number the reader gave it.
   *
   * Only the picture goes: the paragraph, its text and its properties stay, and undo brings it back
   * the same way it brings back a deleted paragraph.
   */
  deleteDocxImage: (path: string, drawing: number, guard: DocxGuard) =>
    invoke<DocxGuard>("fs_delete_docx_image", {
      path,
      drawing,
      guard,
      workspace: envForPath(path),
    }),

  /**
   * Moves one picture to the end of another paragraph.
   *
   * The picture travels with nothing else: the paragraph it left keeps its text, and the one it
   * arrives in keeps everything it had.
   */
  moveDocxImage: (path: string, drawing: number, to: number, guard: DocxGuard) =>
    invoke<DocxGuard>("fs_move_docx_image", {
      path,
      drawing,
      to,
      guard,
      workspace: envForPath(path),
    }),

  undoDocx: (path: string, guard: DocxGuard) =>
    invoke<DocxGuard>("fs_undo_docx", {
      path,
      guard,
      workspace: envForPath(path),
    }),
  /**
   * Writes edits back into a `.docx` and returns its new identity.
   *
   * The whole document is rewritten each time, so the call is idempotent and a lost request cannot
   * leave half an edit behind.
   */
  writeDocx: (
    path: string,
    edits: DocxEdit[],
    deleted: number[],
    inserts: DocxInsert[],
    guard: DocxGuard,
  ) =>
    invoke<DocxGuard>("fs_write_docx", {
      path,
      edits,
      deleted,
      inserts,
      guard,
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
  // explorer preference: keeps .git / .env / .ssh out of agent context.
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

  gitResolveRepo: (cwd: string, env?: WorkspaceEnv) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: env ?? envForPath(cwd),
    }),
  gitContainedRepos: (folder: string) =>
    invoke<{ path: string; committedAtMs: number | null }[]>(
      "git_contained_repos",
      { folder, workspace: envForPath(folder) },
    ),
  /** Find git repos up to `depth` levels below root (default 2). */
  projectsScan: (root: string, depth?: number) =>
    invoke<string[]>("projects_scan", {
      root,
      maxDepth: depth ?? null,
    }),
  /** Batch project status; each row succeeds or fails on its own, with the
   * reason in its `error`. `fetch` also runs `git fetch` per row first, so
   * ahead/behind compares with the remote as it is now (remote-tracking refs
   * only, never a working tree). */
  projectsStatus: (items: WireProjectTarget[], fetch?: boolean) =>
    invoke<WireProjectStatus[]>("projects_status", {
      items,
      fetch: fetch ?? null,
    }),
  /** Pull one project (fetch plus fast-forward only). Refused by the backend when
   * the upstream branch is named differently from the current branch. */
  projectsPull: (path: string, workspace: WorkspaceEnv) =>
    invoke<WireProjectPullOutcome>("projects_pull", { path, workspace }),
  /**
   * Make the project exactly what its remote has, discarding what is local.
   *
   * Not the row's ordinary pull: that one fast-forwards and refuses to merge another branch. This
   * resets to the remote and cleans untracked files, so the interface asks before calling it, and
   * the report it answers with names what was discarded.
   */
  projectsReplaceFromRemote: (
    path: string,
    workspace: WorkspaceEnv,
    shallow?: boolean,
  ) =>
    invoke<WireProjectReplaceReport>("projects_replace_from_remote", {
      path,
      workspace,
      shallow,
    }),
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
  /** Newest open PR / issue update in one repo; also on demand, and only when the
   * row is touched - nothing asks about repositories nobody is looking at. */
  githubRepoActivity: (repo: string) =>
    invoke<WireRepoActivityPayload>("github_repo_activity", { repo }),
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
  /** Rename a repo; the result carries the new slug, since the old one redirects. */
  githubRepoRename: (repo: string, newName: string) =>
    invoke<WireRepoActionResult>("github_repo_rename", {
      repo,
      newName,
    }),
  /** Create a repo under the logged-in account. `gitignore` / `license` are template
   * names gh knows; the result carries the slug GitHub really created. */
  githubRepoCreate: (input: {
    name: string;
    private: boolean;
    description: string;
    gitignore?: string;
    license?: string;
  }) =>
    invoke<WireRepoActionResult>("github_repo_create", {
      name: input.name,
      private: input.private,
      description: input.description,
      gitignore: input.gitignore ?? null,
      license: input.license ?? null,
    }),
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
  /** Edit the stored title and notes of one release. */
  githubReleaseEdit: (repo: string, id: number, name: string, body: string) =>
    invoke<WireReleaseEditResult>("github_release_edit", {
      repo,
      id,
      name,
      body,
    }),
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
  /**
   * Delete an issue. GitHub has no delete for PRs, so the UI only offers this on a
   * plain issue.
   */
  githubIssueDelete: (repo: string, number: number) =>
    invoke<WireIssueActionResult>("github_issue_delete", { repo, number }),
  /** Merge a PR. `method` is `merge` / `squash` / `rebase`. */
  githubPrMerge: (repo: string, number: number, method?: string, headSha?: string) =>
    invoke<WireIssueActionResult>("github_pr_merge", {
      repo,
      number,
      method: method ?? null,
      headSha: headSha ?? null,
    }),
  /** Review a PR. `event` is `approve` / `request_changes`; `body` is optional. */
  githubPrReview: (
    repo: string,
    number: number,
    event: string,
    body?: string,
  ) =>
    invoke<WireIssueActionResult>("github_pr_review", {
      repo,
      number,
      event,
      body: body ?? null,
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
    /** The workspace `repoRoot` lives in, when the caller knows it: a session carries its
     * own, and guessing from the path would put a distro's repository on the host. */
    env?: WorkspaceEnv,
  ) =>
    invoke<string>("git_worktree_add", {
      repoRoot,
      path,
      branch,
      createNewBranch,
      startPoint,
      workspace: env ?? envForPath(repoRoot),
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
  /**
   * Clone into `dest`. `depth: 1` makes a shallow clone that keeps only the newest commit - for a
   * repository kept to be read rather than worked on, where the history is weight nobody asked for.
   */
  gitCloneRepo: (url: string, dest: string, depth?: number) =>
    invoke<string>("git_clone_repo", {
      url,
      dest,
      workspace: envForPath(dest),
      depth,
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
