import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  native,
  type WireIssueDetailPayload,
  type WireIssueListPayload,
  type WireRepoPermissionPayload,
} from "@/lib/native";
import { cn } from "@/lib/utils";
import { useLanguage, useT } from "@/modules/i18n";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { IssueDetail } from "./IssueDetail";
import {
  type IssueFilters,
  type IssueKindFilter,
  type IssueStateFilter,
  filterRows,
  issueNotice,
  toRows,
} from "./lib/issues";
import {
  LIST_SNAPSHOT_TTL_MS,
  PERMISSION_SNAPSHOT_TTL_MS,
  readListSnapshot,
  writeListSnapshot,
} from "./lib/listSnapshot";
import { canWrite, readOnlyHintKey } from "./lib/permission";

type Props = {
  /** Full name of the repo whose issues / PRs are shown; null when the dialog is closed. */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
};

type Pending = {
  what:
    | "close"
    | "reopen"
    | "merge"
    | "review-approve"
    | "review-request-changes"
    | "delete";
  method?: string;
  /** Head sha at the moment the confirm dialog opened: passed along on merge so a
   * commit pushed in between cannot be merged unnoticed. */
  headSha?: string;
};

/**
 * Issues / PRs for one repo.
 *
 * Two-stage: the list first, then clicking an entry swaps the whole dialog for
 * its detail (same pattern as the Releases dialog).
 *
 * The state filter (open / closed / all) maps to an API parameter and refetches
 * each time. The kind filter (issues only, PRs only) and the keyword are done in
 * the frontend, since the `issues` endpoint returns both kinds in one call and
 * filtering locally has zero latency.
 *
 * Writes really happen on your account (comment, close, merge, delete), so closing,
 * merging and deleting confirm first; on a read-only repo the comment box is not
 * rendered at all.
 */
export function IssuesDialog({ repo, onOpenChange }: Props) {
  const t = useT();
  const language = useLanguage();
  const [payload, setPayload] = useState<WireIssueListPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** Raw message when the command itself failed (no `kind` at all). */
  const [fatal, setFatal] = useState<string | null>(null);
  const [kind, setKind] = useState<IssueKindFilter>("all");
  const [state, setState] = useState<IssueStateFilter>("open");
  const [keyword, setKeyword] = useState("");
  /** Entry opened in detail view; null while still on the list. */
  const [detail, setDetail] = useState<WireIssueDetailPayload | null>(null);
  /** Number of the entry in detail view, so a failed detail read can be retried. */
  const [detailNumber, setDetailNumber] = useState<number | null>(null);
  const [detailReading, setDetailReading] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  /** Optional comment for the review currently being confirmed; used once, then cleared. */
  const [reviewBody, setReviewBody] = useState("");
  /** gh's own words when an action failed; kept in the confirm dialog. */
  const [actionError, setActionError] = useState<string | null>(null);
  /** New-issue form; null when not creating one. */
  const [creating, setCreating] = useState<null | {
    title: string;
    body: string;
    labels: string;
  }>(null);
  /** Permission on this repo: only affects whether write buttons show; reads still work. */
  const [permission, setPermission] = useState<WireRepoPermissionPayload | null>(
    null,
  );
  const writable = canWrite(permission);
  const readOnlyHint = readOnlyHintKey(permission);

  useEffect(() => {
    if (!repo) {
      setPermission(null);
      return;
    }
    const key = `permission:${repo}`;
    const cached = readListSnapshot<WireRepoPermissionPayload>(
      key,
      PERMISSION_SNAPSHOT_TTL_MS,
    );
    if (cached) {
      setPermission(cached);
      return;
    }
    setPermission(null);
    let alive = true;
    native
      .githubRepoPermission(repo)
      .then((result) => {
        writeListSnapshot(key, result);
        if (alive) setPermission(result);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo]);

  /**
   * Each list request bumps a sequence number, and a slow response whose number
   * is stale gets dropped. Users flip open / closed quickly, and without this an
   * earlier slow response would overwrite the newer, correct one.
   */
  const listRequest = useRef(0);
  const load = useCallback(async () => {
    if (!repo) return;
    const request = ++listRequest.current;
    setReading(true);
    setFatal(null);
    try {
      const result = await native.githubIssues(repo, state);
      if (request !== listRequest.current) return;
      writeListSnapshot(`issues:${repo}:${state}`, result);
      setPayload(result);
    } catch (e) {
      if (request !== listRequest.current) return;
      setPayload(null);
      setFatal(String(e));
    } finally {
      if (request === listRequest.current) setReading(false);
    }
  }, [repo, state]);

  useEffect(() => {
    if (!repo) {
      // Clear the previous state on close so reopening does not flash stale data.
      setPayload(null);
      setFatal(null);
      setPending(null);
      setActionError(null);
      setDetail(null);
      setComment("");
      setCreating(null);
      setKind("all");
      setState("open");
      setKeyword("");
      return;
    }
    // Served from the last read while it is fresh: the same repo, the same
    // filter, so the answer can only differ if something changed it outside.
    const cached = readListSnapshot<WireIssueListPayload>(
      `issues:${repo}:${state}`,
      LIST_SNAPSHOT_TTL_MS,
    );
    if (cached) {
      setPayload(cached);
      return;
    }
    void load();
  }, [repo, state, load]);

  const openDetail = useCallback(async (number: number) => {
    if (!repo) return;
    setDetailReading(true);
    setDetail(null);
    setDetailNumber(number);
    try {
      setDetail(await native.githubIssueDetail(repo, number));
    } catch (e) {
      setDetail({
        kind: "error",
        repo,
        detail: null,
        error: String(e),
      });
    } finally {
      setDetailReading(false);
    }
  }, [repo]);

  const rows = useMemo(
    () =>
      toRows(
        payload ?? {
          kind: "none",
          repo: repo ?? "",
          issues: [],
          truncated: false,
          error: null,
        },
        Date.now(),
        language,
      ),
    [payload, repo, language],
  );
  const filters = useMemo<IssueFilters>(
    () => ({ kind, state, keyword }),
    [kind, state, keyword],
  );
  const visible = useMemo(
    () => filterRows(rows, filters),
    [rows, filters],
  );
  const notice = issueNotice(payload, reading);
  // Nothing left after filtering means "no match", not "this repo has no issues".
  const emptyByFilter = notice === null && visible.length === 0;
  // When showing "nothing here", spell out the active filter, otherwise the user
  // assumes the repo is genuinely empty.
  const emptyReason = !emptyByFilter
    ? null
    : keyword.trim()
      ? t("remotes.issues.noMatch.title")
      : state === "all"
        ? t("remotes.issues.empty.title")
        : t(
            state === "open"
              ? "remotes.issues.empty.open"
              : "remotes.issues.empty.closed",
          );

  const close = (next: boolean) => {
    if (busy) return;
    onOpenChange(next);
  };

  const sendComment = async () => {
    if (!repo || !detail?.detail) return;
    const body = comment.trim();
    if (!body) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await native.githubIssueComment(
        repo,
        detail.detail.number,
        body,
      );
      if (result.kind !== "ready") {
        setActionError(result.error ?? t("remotes.issues.actionFailed"));
        return;
      }
      setComment("");
      toast.success(t("remotes.issues.commentSent"));
      await openDetail(detail.detail.number);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const runPending = async () => {
    if (!repo || !pending || !detail?.detail) return;
    const number = detail.detail.number;
    setBusy(true);
    setActionError(null);
    try {
      // A review verb maps to the wire `event`; null means this is not a review.
      const reviewEvent =
        pending.what === "review-approve"
          ? "approve"
          : pending.what === "review-request-changes"
            ? "request_changes"
            : null;
      const result =
        pending.what === "delete"
          ? await native.githubIssueDelete(repo, number)
          : pending.what === "merge"
            ? await native.githubPrMerge(
                repo,
                number,
                pending.method,
                pending.headSha,
              )
            : reviewEvent !== null
              ? await native.githubPrReview(repo, number, reviewEvent, reviewBody)
              : await native.githubIssueSetState(
                  repo,
                  number,
                  pending.what === "close" ? "closed" : "open",
                );
      if (result.kind !== "ready") {
        setActionError(result.error ?? t("remotes.issues.actionFailed"));
        return;
      }
      setPending(null);
      setReviewBody("");
      // The item no longer exists, so refetching its detail would fail: fall back to
      // the list instead (the same clearing `onBack` does).
      if (pending.what === "delete") {
        toast.success(t("remotes.issues.deleted"));
        setDetail(null);
        setDetailNumber(null);
        setActionError(null);
        await load();
        return;
      }
      toast.success(
        pending.what === "merge"
          ? t("remotes.issues.merged")
          : pending.what === "review-approve"
            ? t("remotes.issues.review.approved")
            : pending.what === "review-request-changes"
              ? t("remotes.issues.review.requestedChanges")
              : pending.what === "close"
                ? t("remotes.issues.closed")
                : t("remotes.issues.reopened"),
      );
      await openDetail(number);
      await load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const createIssue = async () => {
    if (!repo || !creating) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await native.githubIssueCreate(
        repo,
        creating.title,
        creating.body,
        creating.labels,
      );
      if (result.kind !== "ready") {
        setActionError(result.error ?? t("remotes.issues.actionFailed"));
        return;
      }
      setCreating(null);
      toast.success(t("remotes.issues.created", { number: result.number }));
      await load();
      if (result.number > 0) await openDetail(result.number);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const detailBody = detail?.detail ?? null;

  return (
    <>
      <Dialog open={repo !== null} onOpenChange={close}>
        <DialogContent
          className={detail ? "sm:max-w-4xl" : "sm:max-w-3xl"}
          // The confirm dialog (AlertDialog) is another Radix layer portalled
          // outside body, so clicking it counts as "outside the panel" and closes the
          // panel too.
          onInteractOutside={(event) => {
            if (pending !== null) event.preventDefault();
          }}
        >
          {detailBody ? (
            <IssueDetail
              detail={detailBody}
              writable={writable}
              busy={busy}
              comment={comment}
              onCommentChange={setComment}
              onSendComment={() => void sendComment()}
              onToggleState={() =>
                setPending({
                  what: detailBody.state === "open" ? "close" : "reopen",
                })
              }
              onMerge={(method) =>
                setPending({
                  what: "merge",
                  method,
                  headSha: detail?.detail?.pullRequest?.headSha,
                })
              }
              onReview={(event) =>
                setPending({
                  what:
                    event === "approve"
                      ? "review-approve"
                      : "review-request-changes",
                })
              }
              onDelete={() => setPending({ what: "delete" })}
              onBack={() => {
                setDetail(null);
                setDetailNumber(null);
                setActionError(null);
              }}
            />
          ) : detail !== null ? (
            // The detail read failed: explain why instead of silently falling back to
            // the list and letting the click look lost.
            <div className="space-y-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => {
                  setDetail(null);
                  setDetailNumber(null);
                  setActionError(null);
                }}
              >
                ← {t("remotes.issues.back")}
              </Button>
              <p className="text-sm text-foreground">
                {t("remotes.issues.error.title")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("remotes.issues.error.hint")}
              </p>
              {detail.error ? (
                <p className="rounded border border-border/60 bg-card px-2 py-1 font-mono text-xs whitespace-pre-wrap">
                  {detail.error}
                </p>
              ) : null}
              {detailNumber !== null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => void openDetail(detailNumber)}
                >
                  {t("remotes.issues.retry")}
                </Button>
              ) : null}
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t("remotes.issues.title", { repo: repo ?? "" })}
                </DialogTitle>
                <DialogDescription>
                  {t("remotes.issues.hint")}
                </DialogDescription>
                {readOnlyHint ? (
                  <p className="text-xs text-muted-foreground">
                    {t(readOnlyHint)}
                  </p>
                ) : null}
              </DialogHeader>

              {/* Filter bar */}
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={keyword}
                  placeholder={t("remotes.issues.search")}
                  className="h-7 w-48 text-xs"
                  onChange={(event) => setKeyword(event.target.value)}
                />
                <FilterGroup
                  value={kind}
                  options={[
                    { value: "all", label: t("remotes.issues.filter.all") },
                    {
                      value: "issue",
                      label: t("remotes.issues.filter.issue"),
                    },
                    { value: "pr", label: t("remotes.issues.filter.pr") },
                  ]}
                  onChange={(value) => setKind(value as IssueKindFilter)}
                />
                <FilterGroup
                  value={state}
                  options={[
                    {
                      value: "open",
                      label: t("remotes.issues.filter.open"),
                    },
                    {
                      value: "closed",
                      label: t("remotes.issues.filter.closed"),
                    },
                    {
                      value: "all",
                      label: t("remotes.issues.filter.allStates"),
                    },
                  ]}
                  onChange={(value) => {
                    setState(value as IssueStateFilter);
                  }}
                />
                <span className="grow" />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={!writable}
                  onClick={() =>
                    setCreating({ title: "", body: "", labels: "" })
                  }
                >
                  {t("remotes.issues.newIssue")}
                </Button>
              </div>

              {creating ? (
                <div className="space-y-2 rounded border border-border/60 p-2">
                  <Input
                    value={creating.title}
                    placeholder={t("remotes.issues.create.title")}
                    className="h-7 text-xs"
                    onChange={(event) =>
                      setCreating({ ...creating, title: event.target.value })
                    }
                  />
                  <Textarea
                    value={creating.body}
                    placeholder={t("remotes.issues.create.body")}
                    className="min-h-20 text-xs"
                    onChange={(event) =>
                      setCreating({ ...creating, body: event.target.value })
                    }
                  />
                  <Input
                    value={creating.labels}
                    placeholder={t("remotes.issues.create.labels")}
                    className="h-7 text-xs"
                    onChange={(event) =>
                      setCreating({ ...creating, labels: event.target.value })
                    }
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px]"
                      onClick={() => setCreating(null)}
                    >
                      {t("remotes.issues.create.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      className="h-6 text-[11px]"
                      disabled={busy || !creating.title.trim()}
                      onClick={() => void createIssue()}
                    >
                      {t("remotes.issues.create.submit")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {actionError ? (
                <p className="whitespace-pre-wrap text-xs text-destructive">
                  {actionError}
                </p>
              ) : null}

              {fatal ? (
                <div className="space-y-2">
                  <p className="whitespace-pre-wrap text-xs text-destructive">
                    {fatal}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void load()}
                  >
                    {t("remotes.issues.retry")}
                  </Button>
                </div>
              ) : reading && !payload ? (
                <p className="text-xs text-muted-foreground">
                  {t("remotes.issues.loading")}
                </p>
              ) : detailReading ? (
                <p className="text-xs text-muted-foreground">
                  {t("remotes.issues.loadingDetail")}
                </p>
              ) : notice ? (
                <div className="space-y-1">
                  <p className="text-sm text-foreground">
                    {t(notice.titleKey)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(notice.hintKey)}
                  </p>
                  {notice.detail ? (
                    <p className="mt-1 rounded border border-border/60 bg-card px-2 py-1 font-mono text-xs whitespace-pre-wrap">
                      {notice.detail}
                    </p>
                  ) : null}
                </div>
              ) : emptyByFilter ? (
                <p className="text-xs text-muted-foreground">{emptyReason}</p>
              ) : (
                <div className="max-h-[55vh] overflow-auto">
                  {payload?.truncated ? (
                    <p className="mb-1 text-[11px] text-muted-foreground">
                      {t("remotes.issues.truncated", {
                        count: payload.issues.length,
                      })}
                    </p>
                  ) : null}
                  <ul className="space-y-1">
                    {visible.map((row) => (
                      <li key={row.number}>
                        <button
                          type="button"
                          className="w-full rounded border border-border/40 px-2 py-1.5 text-left hover:bg-accent/40"
                          onClick={() => void openDetail(row.number)}
                        >
                          <span className="flex flex-wrap items-baseline gap-2">
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              #{row.number}
                            </span>
                            {row.isPullRequest ? (
                              <span className="rounded border border-sky-500/40 px-1 text-[10px] leading-4 whitespace-nowrap text-sky-600 dark:text-sky-400">
                                {t("remotes.issues.badge.pr")}
                              </span>
                            ) : (
                              <span className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-nowrap text-muted-foreground">
                                {t("remotes.issues.badge.issue")}
                              </span>
                            )}
                            {row.merged ? (
                              <span className="rounded border border-emerald-500/40 px-1 text-[10px] leading-4 whitespace-nowrap text-emerald-600 dark:text-emerald-400">
                                {t("remotes.issues.badge.merged")}
                              </span>
                            ) : null}
                            <span className="min-w-0 truncate text-xs">
                              {row.title}
                            </span>
                            {row.labels.map((label) => (
                              <span
                                key={label}
                                className="rounded border border-border/60 px-1 text-[10px] leading-4 whitespace-nowrap text-muted-foreground"
                              >
                                {label}
                              </span>
                            ))}
                            <span className="grow" />
                            {row.comments > 0 ? (
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {t("remotes.issues.commentCount", {
                                  count: row.comments,
                                })}
                              </span>
                            ) : null}
                            {row.when ? (
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {row.when}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirm dialog: closing an issue or merging a PR really does something, so
          ask first. */}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setActionError(null);
            setReviewBody("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.what === "merge"
                ? t("remotes.issues.merge.confirmTitle")
                : pending?.what === "delete"
                  ? t("remotes.issues.delete.confirmTitle")
                  : pending?.what === "review-approve"
                    ? t("remotes.issues.review.approve.confirmTitle")
                    : pending?.what === "review-request-changes"
                      ? t("remotes.issues.review.requestChanges.confirmTitle")
                      : pending?.what === "close"
                        ? t("remotes.issues.close.confirmTitle")
                        : t("remotes.issues.reopen.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.what === "merge"
                ? t("remotes.issues.merge.confirmHint")
                : pending?.what === "delete"
                  ? t("remotes.issues.delete.confirmHint")
                  : pending?.what === "review-approve"
                    ? t("remotes.issues.review.approve.confirmHint")
                    : pending?.what === "review-request-changes"
                      ? t("remotes.issues.review.requestChanges.confirmHint")
                      : pending?.what === "close"
                        ? t("remotes.issues.close.confirmHint")
                        : t("remotes.issues.reopen.confirmHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pending?.what === "review-approve" ||
          pending?.what === "review-request-changes" ? (
            <Textarea
              value={reviewBody}
              placeholder={t("remotes.issues.review.bodyPlaceholder")}
              className="min-h-16 text-xs"
              disabled={busy}
              onChange={(event) => setReviewBody(event.target.value)}
            />
          ) : null}
          {actionError ? (
            <p className="whitespace-pre-wrap text-xs text-destructive">
              {actionError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setActionError(null);
                setReviewBody("");
              }}
            >
              {t("remotes.issues.create.cancel")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={busy}
              onClick={() => void runPending()}
            >
              {t("remotes.issues.create.submit")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A set of mutually exclusive small buttons (kind filter, state filter). */
function FilterGroup({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="flex items-center gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded border px-1.5 py-0.5 text-[11px] whitespace-nowrap",
            option.value === value
              ? "border-primary/60 bg-primary/10 text-foreground"
              : "border-border/60 text-muted-foreground hover:bg-accent/40",
          )}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}
