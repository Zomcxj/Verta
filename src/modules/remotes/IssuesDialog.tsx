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
import { useT } from "@/modules/i18n";
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
import { canWrite, readOnlyHintKey } from "./lib/permission";

type Props = {
  /** 要看 issue / PR 的仓库全名；null 表示弹窗关着。 */
  repo: string | null;
  onOpenChange: (open: boolean) => void;
};

type Pending = {
  what: "close" | "reopen" | "merge";
  method?: string;
  /** 点开确认框那一刻的 head sha：合并时带上它，防止期间有人又推了新提交。 */
  headSha?: string;
};

/**
 * 某个仓库的 issue / PR。
 *
 * 两段式：先是列表，点某一条整个弹窗内容换成详情（跟 Releases 弹窗一个路子）。
 *
 * 状态筛选（打开 / 已关闭 / 全部）走 API 原生参数，换一次要重新发一次请求；
 * 类型筛选（只看 issue 或只看 PR）和关键字在前端做 —— `issues` 端点一次就把
 * 两类都带回来了，前端筛是零延迟。
 *
 * 写操作会真的发生在你账号上（评论、关 issue、合 PR），所以关和合都要先确认；
 * 只读仓库连评论框都不渲染。
 */
export function IssuesDialog({ repo, onOpenChange }: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireIssueListPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文。 */
  const [fatal, setFatal] = useState<string | null>(null);
  const [kind, setKind] = useState<IssueKindFilter>("all");
  const [state, setState] = useState<IssueStateFilter>("open");
  const [keyword, setKeyword] = useState("");
  /** 展开看详情的那一条；null 表示还停在列表上。 */
  const [detail, setDetail] = useState<WireIssueDetailPayload | null>(null);
  /** 正在看详情的那一条的编号：详情读失败时好重试。 */
  const [detailNumber, setDetailNumber] = useState<number | null>(null);
  const [detailReading, setDetailReading] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  /** 动作失败时 gh 的原话，留在确认框里。 */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 新建 issue 的表单；null 表示没在新建。 */
  const [creating, setCreating] = useState<null | {
    title: string;
    body: string;
    labels: string;
  }>(null);
  /** 这个仓库的权限：只影响写操作按钮在不在，读的部分照常给。 */
  const [permission, setPermission] = useState<WireRepoPermissionPayload | null>(
    null,
  );
  const writable = canWrite(permission);
  const readOnlyHint = readOnlyHintKey(permission);

  useEffect(() => {
    setPermission(null);
    if (!repo) return;
    let alive = true;
    native
      .githubRepoPermission(repo)
      .then((result) => {
        if (alive) setPermission(result);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [repo]);

  /**
   * 每发一次列表请求就换一个序号：慢的那次回来时如果序号已经变了，就丢掉它。
   * 切「打开 / 已关闭」很快，不这样的话先发的慢响应会把后发的正确结果盖掉。
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
      // 关掉时把上一次的状态清干净，下次打开不会先闪一眼旧数据。
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
    void load();
  }, [repo, load]);

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
      ),
    [payload, repo],
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
  // 筛选后一条都不剩：那是「没匹配上」，不是「这个仓库没有 issue」。
  const emptyByFilter = notice === null && visible.length === 0;
  // 看到「一条都没有」时，把当前筛选条件翻译成一句人话 —— 不然用户会以为仓库真的是空的。
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
      const result =
        pending.what === "merge"
          ? await native.githubPrMerge(
              repo,
              number,
              pending.method,
              pending.headSha,
            )
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
      toast.success(
        pending.what === "merge"
          ? t("remotes.issues.merged")
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
          // 确认框（AlertDialog）是另一个 Radix 层、被传送到 body 外面，点它会被当成
          // 「点到面板外面」而把面板一起关掉。
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
              onBack={() => {
                setDetail(null);
                setDetailNumber(null);
                setActionError(null);
              }}
            />
          ) : detail !== null ? (
            // 详情读失败了：说清楚为什么，不能默默掉回列表让人以为没点上。
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

              {/* 筛选条 */}
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

      {/* 确认框：关 issue 与合 PR 都会真的发生点什么，先问一句。 */}
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPending(null);
            setActionError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.what === "merge"
                ? t("remotes.issues.merge.confirmTitle")
                : pending?.what === "close"
                  ? t("remotes.issues.close.confirmTitle")
                  : t("remotes.issues.reopen.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.what === "merge"
                ? t("remotes.issues.merge.confirmHint")
                : pending?.what === "close"
                  ? t("remotes.issues.close.confirmHint")
                  : t("remotes.issues.reopen.confirmHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
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

/** 一组互斥的小按钮（类型筛选、状态筛选）。 */
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
