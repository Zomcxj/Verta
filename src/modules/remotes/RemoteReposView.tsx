import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { native, type WireRemoteReposPayload, type WireRepoCiPayload } from "@/lib/native";
import { cn } from "@/lib/utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useT, type MessageKey } from "@/modules/i18n";
import { RunListDialog } from "./RunListDialog";
import { TONE_CLASS, ciView, type CiView } from "./lib/ci";
import { copyTextOf, filterRows, noticeOf, toRows } from "./lib/rows";
import type { RemoteRepoRow } from "./lib/types";

type Props = {
  /** 非活动标签页只是留在后台，不该反复去拉网络。 */
  active: boolean;
};

/**
 * 远程仓库列表（本机 gh 读到的账号级仓库）。中间区域的标签页，和「项目」同一套路：
 * 没有项目清单那样的本机状态，全部来自一次查询。
 */
export function RemoteReposView({ active }: Props) {
  const t = useT();

  const [payload, setPayload] = useState<WireRemoteReposPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文，与 gh 报错分开记。 */
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  /** 已经查过的 CI 结果，按 `owner/name` 存放；查过不再自动重查。 */
  const [ci, setCi] = useState<Record<string, WireRepoCiPayload>>({});
  /** 正在看运行记录的仓库；null 表示弹窗关着。 */
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [ciBusy, setCiBusy] = useState<Record<string, boolean>>({});

  /**
   * 查一个仓库的 CI。
   *
   * 一次一个仓库：整份列表逐个去查会烧掉 API 配额，所以只查用户真正碰到的行（悬停或
   * 菜单里点「检查 CI」）。`force` 用于菜单里的重新检查。
   */
  const checkCi = useCallback(
    async (fullName: string, force = false) => {
      if (!fullName) return;
      if (ciBusy[fullName]) return;
      if (!force && ci[fullName]) return;
      setCiBusy((prev) => ({ ...prev, [fullName]: true }));
      try {
        const result = await native.githubRepoCi(fullName);
        setCi((prev) => ({ ...prev, [fullName]: result }));
      } catch (e) {
        // 命令本身失败（不是 gh 报的错）：也放进结果里，让那一行自己说清楚。
        setCi((prev) => ({
          ...prev,
          [fullName]: {
            kind: "error",
            repo: fullName,
            run: null,
            error: String(e),
          },
        }));
      } finally {
        setCiBusy((prev) => {
          const next = { ...prev };
          delete next[fullName];
          return next;
        });
      }
    },
    [ci, ciBusy],
  );

  const read = useCallback(async () => {
    setReading(true);
    setFailure(null);
    try {
      setPayload(await native.githubRepos());
    } catch (e) {
      setFailure(String(e));
    } finally {
      setReading(false);
    }
  }, []);

  // 第一次露脸时读一次；之后由刷新按钮说了算，切标签页不会重复拉网络。
  useEffect(() => {
    if (!active || payload !== null) return;
    void read();
  }, [active, payload, read]);

  const rows = useMemo(
    () => (payload ? toRows(payload, Date.now()) : []),
    [payload],
  );
  const visible = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const notice = payload ? noticeOf(payload, visible.length, filter) : null;

  const copy = useCallback((value: string) => {
    // 剪贴板尽力而为：没有权限时静默，别把一次复制失败说成列表出错。
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.message(t("remotes.action.copied")))
      .catch(() => {});
  }, [t]);

  if (!payload) {
    if (failure) {
      return (
        <div className="h-full min-h-0 px-3 py-2">
          <p className="text-sm text-foreground">{t("remotes.error.title")}</p>
          <p className="mt-1 font-mono text-xs whitespace-pre-wrap text-destructive">
            {failure}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 text-xs"
            onClick={() => void read()}
            disabled={reading}
          >
            {t("remotes.reload")}
          </Button>
        </div>
      );
    }
    return (
      <div className="h-full min-h-0 px-3 py-2 text-sm text-muted-foreground">
        {active ? t("remotes.loading") : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pt-2 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("remotes.filter")}
          className="h-7 w-44 text-xs"
        />
        <span className="text-xs text-muted-foreground">
          {t("remotes.count", { shown: visible.length, total: rows.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => void read()}
          disabled={reading}
        >
          {reading ? t("remotes.reading") : t("remotes.refresh")}
        </Button>
        <span className="grow" />
        <span className="text-xs text-muted-foreground">
          {payload.login
            ? t("remotes.account", { login: payload.login })
            : t("remotes.account.unnamed")}
        </span>
      </div>

      {failure ? (
        <p className="mt-2 font-mono text-xs whitespace-pre-wrap text-destructive">
          {failure}
        </p>
      ) : null}

      {payload.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("remotes.truncated", { count: rows.length })}
        </p>
      ) : null}

      {notice ? (
        <div className="mt-6 max-w-xl text-sm text-muted-foreground">
          <p className="text-foreground">
            {t(notice.titleKey as MessageKey, notice.params)}
          </p>
          <p className="mt-1 text-xs">{t(notice.hintKey as MessageKey)}</p>
          {notice.detail ? (
            <p className="mt-2 rounded border border-border/60 bg-card px-2 py-1 font-mono text-xs whitespace-pre-wrap">
              {notice.detail}
            </p>
          ) : null}
          {notice.tone === "empty" ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 text-xs"
              onClick={() => void read()}
              disabled={reading}
            >
              {t("remotes.reload")}
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-2 min-h-0 flex-1 overflow-auto">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="text-left text-muted-foreground">
                <th className="w-[32%] py-1 font-medium">
                  {t("remotes.col.repo")}
                </th>
                <th className="w-[10%] py-1 font-medium">
                  {t("remotes.col.visibility")}
                </th>
                <th className="w-[12%] py-1 font-medium">
                  {t("remotes.col.language")}
                </th>
                <th className="w-[14%] py-1 font-medium">
                  {t("remotes.col.pushed")}
                </th>
                <th className="w-[10%] py-1 font-medium">
                  {t("remotes.col.ci")}
                </th>
                <th className="py-1 font-medium">
                  {t("remotes.col.description")}
                </th>
                <th className="w-[4%] py-1" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <RepoRow
                  key={row.fullName}
                  row={row}
                  onCopy={copy}
                  ci={ci[row.fullName] ?? null}
                  ciBusy={Boolean(ciBusy[row.fullName])}
                  onCheckCi={checkCi}
                  onOpenRuns={setRunsFor}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RunListDialog
        repo={runsFor}
        onOpenChange={(open) => {
          if (!open) setRunsFor(null);
        }}
      />
    </div>
  );
}

function RepoRow({
  row,
  onCopy,
  ci,
  ciBusy,
  onCheckCi,
  onOpenRuns,
}: {
  row: RemoteRepoRow;
  onCopy: (value: string) => void;
  ci: WireRepoCiPayload | null;
  ciBusy: boolean;
  onCheckCi: (fullName: string, force?: boolean) => void;
  onOpenRuns: (fullName: string) => void;
}) {
  const t = useT();
  const open = useCallback(() => {
    void openUrl(row.webUrl).catch(console.error);
  }, [row.webUrl]);
  const view = ciView(ci);
  // 鼠标停到这一行就去查一次：整份列表不批量查，用户碰到哪行就查哪行。
  const onHover = useCallback(() => {
    void onCheckCi(row.fullName);
  }, [onCheckCi, row.fullName]);

  return (
    <tr
      className="cursor-pointer border-t border-border/40 align-top hover:bg-accent/40"
      onClick={() => onOpenRuns(row.fullName)}
      onMouseEnter={onHover}
    >
      <td className="py-1.5 pr-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">
            {row.fullName}
          </span>
          {row.isFork ? <Flag label={t("remotes.flag.fork")} /> : null}
          {row.isArchived ? <Flag label={t("remotes.flag.archived")} /> : null}
        </span>
      </td>
      <td className="py-1.5 pr-2 text-muted-foreground">
        {row.isPrivate
          ? t("remotes.visibility.private")
          : t("remotes.visibility.public")}
      </td>
      <td className="truncate py-1.5 pr-2 text-muted-foreground">
        {row.language ?? t("remotes.unknown")}
      </td>
      <td className="truncate py-1.5 pr-2 text-muted-foreground">
        {row.pushed ?? t("remotes.unknown")}
      </td>
      <td className="truncate py-1.5 pr-2">
        <CiCell
          view={view}
          busy={ciBusy}
          checkLabel={t("remotes.ci.check")}
          onCheck={() => onCheckCi(row.fullName, true)}
          onOpenDetail={() => onOpenRuns(row.fullName)}
        />
      </td>
      <td className="truncate py-1.5 pr-2 text-muted-foreground">
        {row.description ?? ""}
      </td>
      <td className="py-1.5 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={t("remotes.action.more")}
              className="rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              ⋯
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onSelect={open}>
              {t("remotes.action.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                onCheckCi(row.fullName, true);
              }}
            >
              {t("remotes.ci.check")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenRuns(row.fullName)}>
              {t("remotes.runs.open")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onCopy(copyTextOf(row, "name"))}>
              {t("remotes.action.copyName")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopy(copyTextOf(row, "clone"))}>
              {t("remotes.action.copyClone")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

/**
 * 一行的 CI 徽标。
 *
 * 有结果时可点开去看这次运行；没有结果（或正在查）时是个「检查 CI」按钮，点一下现查。
 * 不管哪种状态，点击都不该冒泡到行上——那会把浏览器转到仓库首页去。
 */
function CiCell({
  view,
  busy,
  checkLabel,
  onCheck,
  onOpenDetail,
}: {
  view: CiView;
  busy: boolean;
  checkLabel: string;
  onCheck: () => void;
  /** 已有结果时点它是「在软件里看运行」，不是跳浏览器。 */
  onOpenDetail: () => void;
}) {
  const t = useT();
  const label = busy ? t("remotes.ci.checking") : t(view.key);
  const className = cn(
    "rounded border px-1 text-[10px] leading-4",
    TONE_CLASS[view.tone],
  );

  return (
    <button
      type="button"
      title={view.detail ?? checkLabel}
      disabled={busy}
      className={cn(className, "hover:bg-accent disabled:opacity-60")}
      // 点击都不该冒泡到行上（行点击是打开运行面板）。
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (view.url) onOpenDetail();
        else onCheck();
      }}
    >
      {label}
    </button>
  );
}

function Flag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground">
      {label}
    </span>
  );
}