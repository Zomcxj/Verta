import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WireIssueDetail } from "@/lib/native";
import { cn } from "@/lib/utils";
import { useT, type MessageKey } from "@/modules/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { lazy, Suspense, useState } from "react";
import {
  changeLabel,
  ISSUE_COMMITS_PAGE_SIZE,
  mergeBlocked,
} from "./lib/issues";

/**
 * The Markdown renderer (including Streamdown) loads on demand: a static import
 * would drag the whole layout engine into the startup graph and the bundle-budget
 * test would fail on the spot. The Releases side does the same.
 */
const Markdown = lazy(() =>
  import("@/modules/markdown/MarkdownRender").then((module) => ({
    default: module.MarkdownRender,
  })),
);

type Props = {
  detail: WireIssueDetail;
  /** Whether this repo is writable: on a read-only repo neither the comment box nor
   * the write buttons render. */
  writable: boolean;
  /** An action is in flight: buttons are disabled to stop double clicks. */
  busy: boolean;
  comment: string;
  onCommentChange: (value: string) => void;
  onSendComment: () => void;
  onToggleState: () => void;
  onMerge: (method: string) => void;
  onBack: () => void;
};

const MERGE_METHODS = [
  { value: "merge", labelKey: "remotes.issues.merge.merge" },
  { value: "squash", labelKey: "remotes.issues.merge.squash" },
  { value: "rebase", labelKey: "remotes.issues.merge.rebase" },
] as const;

/**
 * Detail of one issue / PR.
 *
 * The body renders as Markdown; a PR gets an extra block (head → base branch, check
 * status, diff size, its commit list). Whether the merge button is clickable is **the
 * backend's call** (`mergeBlocked`, which yields a reason code); the UI only follows
 * it rather than judging again, so the two cannot disagree.
 */
export function IssueDetail({
  detail,
  writable,
  busy,
  comment,
  onCommentChange,
  onSendComment,
  onToggleState,
  onMerge,
  onBack,
}: Props) {
  const t = useT();
  const pull = detail.pullRequest;
  const blocked = mergeBlocked(pull);
  const isOpen = detail.state === "open";
  const canComment = writable && !detail.locked;
  // Merge method: squash by default (GitHub's default for new repos), changeable in
  // the dropdown.
  const [mergeMethod, setMergeMethod] = useState("squash");
  const checksKey = (
    detail.checks ? `remotes.issues.checks.${detail.checks.state}` : ""
  ) as MessageKey;
  // The count depends on the state: how many failed, or how many are still running.
  const checkCount = !detail.checks
    ? 0
    : detail.checks.state === "fail"
      ? detail.checks.failed
      : detail.checks.state === "pending"
        ? detail.checks.pending
        : detail.checks.total;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={onBack}
        >
          ← {t("remotes.issues.back")}
        </Button>
        <span className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-nowrap text-muted-foreground">
          #{detail.number}
        </span>
        {detail.isPullRequest ? (
          <span className="rounded border border-sky-500/40 px-1 text-[10px] leading-4 whitespace-nowrap text-sky-600 dark:text-sky-400">
            {t("remotes.issues.badge.pr")}
          </span>
        ) : (
          <span className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-nowrap text-muted-foreground">
            {t("remotes.issues.badge.issue")}
          </span>
        )}
        {detail.isDraft ? (
          <span className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-foreground/70 text-muted-foreground">
            {t("remotes.issues.badge.draft")}
          </span>
        ) : null}
        {detail.merged ? (
          <span className="rounded border border-emerald-500/40 px-1 text-[10px] leading-4 whitespace-nowrap text-emerald-600 dark:text-emerald-400">
            {t("remotes.issues.badge.merged")}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-sm">{detail.title}</span>
        <span className="grow" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => void openUrl(detail.htmlUrl).catch(console.error)}
        >
          {t("remotes.issues.inGithub")}
        </Button>
      </div>

      {/* Metadata: author · time · state · labels · assignees */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{detail.author || t("remotes.issues.unknown")}</span>
        {detail.createdAt ? (
          <span>{new Date(detail.createdAt).toLocaleString()}</span>
        ) : null}
        <span
          className={cn(
            "rounded border px-1 leading-4 whitespace-nowrap",
            isOpen
              ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
              : "border-border/60",
          )}
        >
          {isOpen
            ? t("remotes.issues.state.open")
            : t("remotes.issues.state.closed")}
        </span>
        {detail.labels.map((label) => (
          <span
            key={label}
            className="rounded border border-border/60 px-1 leading-4 whitespace-nowrap"
          >
            {label}
          </span>
        ))}
        {detail.assignees.length > 0 ? (
          <span>
            {t("remotes.issues.assignees")}: {detail.assignees.join(", ")}
          </span>
        ) : null}
      </div>

      {/* PR-only: head → base, check status, diff size */}
      {pull ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-border/60 bg-card/40 px-2 py-1.5 text-[11px]">
          <span className="font-mono">
            {pull.head} → {pull.base}
          </span>
          {changeLabel(pull) ? (
            <span className="text-muted-foreground">{changeLabel(pull)}</span>
          ) : null}
          <span className="text-muted-foreground">
            {t("remotes.issues.files", { count: pull.changedFiles })}
          </span>
          {detail.checks ? (
            <span
              className={cn(
                "rounded border px-1 leading-4 whitespace-nowrap",
                detail.checks.state === "pass"
                  ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                  : detail.checks.state === "fail"
                    ? "border-destructive/50 text-destructive"
                    : "border-border/60 text-muted-foreground",
              )}
            >
              {t(checksKey, { count: checkCount })}
            </span>
          ) : null}
        </div>
      ) : null}
      {detail.pullRequestError ? (
        <p className="whitespace-pre-wrap text-[11px] text-destructive">
          {detail.pullRequestError}
        </p>
      ) : null}

      {/* PR-only, read-only: one row per commit. An empty list renders nothing
          (a PR has at least one commit, and there is no copy for an empty list);
          `null` is already "not fetched". */}
      {detail.commits && detail.commits.length > 0 ? (
        <div className="space-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-medium">
              {t("remotes.issues.commits.title")}
            </span>
            {/* Only one page is fetched: a full page back means there may be more. */}
            {detail.commits.length >= ISSUE_COMMITS_PAGE_SIZE ? (
              <span className="text-[11px] text-muted-foreground">
                {t("remotes.issues.commits.truncated", {
                  count: detail.commits.length,
                })}
              </span>
            ) : null}
          </div>
          <ul className="max-h-[20vh] space-y-1 overflow-auto">
            {detail.commits.map((commit) => (
              <li
                key={commit.sha}
                className="flex items-baseline gap-2 rounded border border-border/60 px-2 py-1 text-[11px]"
              >
                <span className="font-mono text-muted-foreground">
                  {commit.sha.slice(0, 7)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {commit.summary}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {commit.author || t("remotes.issues.unknown")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Body */}
      {detail.body.trim() ? (
        <div className="max-h-[35vh] overflow-auto rounded border border-border/60 px-2 py-1.5 text-xs">
          <Suspense
            fallback={
              <p className="text-[11px] text-muted-foreground">
                {t("remotes.issues.loadingBody")}
              </p>
            }
          >
            <Markdown
              content={detail.body}
              path=""
              className="markdown-rendered select-text text-xs"
            />
          </Suspense>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {t("remotes.issues.noBody")}
        </p>
      )}

      {/* Comments */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium">
          {t("remotes.issues.comments", { count: detail.comments.length })}
        </div>
        {detail.commentsError ? (
          <p className="whitespace-pre-wrap text-[11px] text-destructive">
            {detail.commentsError}
          </p>
        ) : null}
        {detail.comments.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t("remotes.issues.noComments")}
          </p>
        ) : (
          <ul className="max-h-[25vh] space-y-1.5 overflow-auto">
            {detail.comments.map((item) => (
              <li
                key={item.id}
                className="rounded border border-border/60 px-2 py-1.5 text-xs"
              >
                <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {item.author || t("remotes.issues.unknown")}
                  </span>
                  {item.createdAt ? (
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  ) : null}
                </div>
                <div className="mt-1 whitespace-pre-wrap">{item.body}</div>
              </li>
            ))}
          </ul>
        )}
        {canComment ? (
          <div className="space-y-1.5">
            <Textarea
              value={comment}
              placeholder={t("remotes.issues.commentPlaceholder")}
              className="min-h-16 text-xs"
              onChange={(event) => onCommentChange(event.target.value)}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                className="h-6 text-[11px]"
                disabled={busy || !comment.trim()}
                onClick={onSendComment}
              >
                {t("remotes.issues.send")}
              </Button>
            </div>
          </div>
        ) : detail.locked ? (
          <p className="text-[11px] text-muted-foreground">
            {t("remotes.issues.locked")}
          </p>
        ) : null}
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-2">
        {writable ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              disabled={busy}
              onClick={onToggleState}
            >
              {isOpen ? t("remotes.issues.close") : t("remotes.issues.reopen")}
            </Button>
            {pull ? (
              <>
                <Select
                  value={mergeMethod}
                  onValueChange={setMergeMethod}
                  disabled={busy || blocked !== null}
                >
                  <SelectTrigger
                    className="h-6 w-28 text-[11px]"
                    aria-label={t("remotes.issues.merge.label")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MERGE_METHODS.map((method) => (
                      <SelectItem
                        key={method.value}
                        value={method.value}
                        className="text-xs"
                      >
                        {t(method.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-6 text-[11px]"
                  disabled={busy || blocked !== null}
                  onClick={() => onMerge(mergeMethod)}
                >
                  {t("remotes.issues.merge.action")}
                </Button>
                {blocked ? (
                  <span className="text-[11px] text-muted-foreground">
                    {t(`remotes.issues.mergeBlocked.${blocked}` as MessageKey)}
                  </span>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {t("remotes.issues.readOnly")}
          </span>
        )}
      </div>
    </div>
  );
}
