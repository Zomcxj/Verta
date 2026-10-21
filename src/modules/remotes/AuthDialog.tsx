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
import {
  native,
  type WireAuthLoginProgress,
  type WireAuthStatusPayload,
} from "@/lib/native";
import { useT, type MessageKey } from "@/modules/i18n";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { authView, needsDeleteScope, tokenProblem } from "./lib/auth";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const AUTH_EVENT = "verta://gh-auth";
/** 补 delete_repo 授权的命令：删仓库那一步要靠它。 */
const DELETE_SCOPE_COMMAND = "gh auth refresh -s delete_repo";

/**
 * GitHub 账号面板：看当前登录态、浏览器授权、粘 PAT、登出。
 *
 * **token 不落进应用**：粘贴的那串只经过内存写进 gh 的 stdin，界面提交完就把输入框清掉；
 * 登录态里的 token 来源（keyring 等）照实显示，但 token 本身从不读出来。
 */
export function AuthDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const [payload, setPayload] = useState<WireAuthStatusPayload | null>(null);
  const [reading, setReading] = useState(false);
  /** 命令本身失败（连 kind 都拿不到）时的原文。 */
  const [fatal, setFatal] = useState<string | null>(null);
  /** 浏览器授权中的实时输出。 */
  const [stream, setStream] = useState("");
  /** 浏览器授权是不是正跑着（决定挂不挂事件监听）。 */
  const [streaming, setStreaming] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "token" | "web" | "logout">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);

  const view = authView(payload);
  const problem = tokenProblem(token);

  /**
   * 读一次登录态。
   *
   * 依赖是空的：这个回调只在打开弹窗时用一次，`load` 的身份必须稳定 ——
   * 它要是每次渲染都变，effect 会跟着重跑，读一次 → 重渲染 → 再读一次，弹窗会一直跳。
   */
  const load = useCallback(async () => {
    setReading(true);
    setFatal(null);
    try {
      const result = await native.githubAuthStatus();
      setPayload(result);
    } catch (e) {
      setPayload(null);
      setFatal(String(e));
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      // 关掉时清干净：token 不留、流不留、错误不留。
      setPayload(null);
      setFatal(null);
      setStream("");
      setStreaming(false);
      setToken("");
      setActionError(null);
      setLogoutOpen(false);
      setBusy(null);
      return;
    }
    void load();
  }, [open, load]);

  // 浏览器授权那一轮的输出。监听只在跑的时候挂着。
  useEffect(() => {
    if (!streaming) return;
    let alive = true;
    const stop = listen<WireAuthLoginProgress>(AUTH_EVENT, (event) => {
      if (!alive) return;
      setStream((prev) => prev + event.payload.text);
    });
    return () => {
      alive = false;
      void stop.then((off) => off()).catch(() => {});
    };
  }, [streaming]);

  const loginWithWeb = async () => {
    if (busy) return;
    setBusy("web");
    setActionError(null);
    setStream("");
    setStreaming(true);
    try {
      const result = await native.githubAuthLoginWeb();
      if (result.kind === "cancelled") {
        toast.message(t("remotes.auth.web.cancelled"));
        return;
      }
      if (result.kind !== "ready") {
        setActionError(result.error ?? t("remotes.auth.error"));
        return;
      }
      // gh 退出码是 0 不等于「真登上了」：读完状态再决定说什么。
      const status = await native.githubAuthStatus();
      setPayload(status);
      if (status.kind !== "ready") {
        // gh 报成功但登录态没变：多半是浏览器那步没走完（它退 0 只说明命令跑完了）。
        setActionError(t("remotes.auth.web.unfinished"));
        return;
      }
      toast.success(t("remotes.auth.web.done"));
    } catch (e) {
      setActionError(String(e));
    } finally {
      setStreaming(false);
      setBusy(null);
    }
  };

  const loginWithToken = async () => {
    if (busy || problem) return;
    setBusy("token");
    setActionError(null);
    try {
      const result = await native.githubAuthLoginToken(token.trim());
      if (result.kind !== "ready") {
        setActionError(result.error ?? t("remotes.auth.error"));
        return;
      }
      toast.success(t("remotes.auth.token.done"));
      await load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      // 提交完就把输入框清掉：应用里不留这串东西。
      setToken("");
      setBusy(null);
    }
  };

  const logout = async () => {
    if (busy) return;
    setBusy("logout");
    setActionError(null);
    try {
      const result = await native.githubAuthLogout(view.account ?? undefined);
      if (result.kind !== "ready") {
        setActionError(result.error ?? t("remotes.auth.error"));
        return;
      }
      setLogoutOpen(false);
      toast.success(t("remotes.auth.logout.done"));
      await load();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const close = (next: boolean) => {
    if (busy === "web") return;
    onOpenChange(next);
  };

  const tokenHintKey: MessageKey | null =
    problem === "empty"
      ? "remotes.auth.token.empty"
      : problem === "space"
        ? "remotes.auth.token.space"
        : problem === "short"
          ? "remotes.auth.token.short"
          : null;

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("remotes.auth.title")}</DialogTitle>
            <DialogDescription>{t("remotes.auth.hint")}</DialogDescription>
          </DialogHeader>

          {fatal ? (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap text-xs text-destructive">{fatal}</p>
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                {t("remotes.auth.retry")}
              </Button>
            </div>
          ) : reading && !payload ? (
            <p className="text-xs text-muted-foreground">{t("remotes.auth.loading")}</p>
          ) : (
            <div className="space-y-4">
              <section className="space-y-1.5">
                {view.hintKey ? (
                  <p className="text-xs text-muted-foreground">{t(view.hintKey)}</p>
                ) : null}
                {view.detail ? (
                  <p className="font-mono text-[11px] whitespace-pre-wrap text-destructive">
                    {view.detail}
                  </p>
                ) : null}
                {view.loggedIn ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    <dt className="text-muted-foreground">
                      {t("remotes.auth.account")}
                    </dt>
                    <dd className="text-foreground">
                      {view.account ?? t("remotes.unknown")}
                    </dd>
                    <dt className="text-muted-foreground">{t("remotes.auth.host")}</dt>
                    <dd className="text-foreground">{view.host ?? ""}</dd>
                    <dt className="text-muted-foreground">{t("remotes.auth.state")}</dt>
                    <dd className="text-foreground">{view.state ?? ""}</dd>
                    <dt className="text-muted-foreground">
                      {t("remotes.auth.tokenSource")}
                    </dt>
                    <dd className="text-foreground">{view.tokenSource ?? ""}</dd>
                    <dt className="text-muted-foreground">
                      {t("remotes.auth.gitProtocol")}
                    </dt>
                    <dd className="text-foreground">{view.gitProtocol ?? ""}</dd>
                    <dt className="text-muted-foreground">
                      {t("remotes.auth.scopes")}
                    </dt>
                    <dd className="flex flex-wrap gap-1">
                      {view.scopes.map((scope) => (
                        <span
                          key={scope}
                          className="rounded border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground"
                        >
                          {scope}
                        </span>
                      ))}
                    </dd>
                  </dl>
                ) : null}
                {view.loggedIn && needsDeleteScope(view.scopes) ? (
                  <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 px-2 py-1">
                    <span className="text-[11px] text-muted-foreground">
                      {t("remotes.auth.scope.deleteHint")}
                    </span>
                    <code className="font-mono text-[11px] text-foreground">
                      {DELETE_SCOPE_COMMAND}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px]"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(DELETE_SCOPE_COMMAND)
                          .then(() => toast.message(t("remotes.action.copied")))
                          .catch(() => {});
                      }}
                    >
                      {t("remotes.auth.scope.copyCommand")}
                    </Button>
                  </div>
                ) : null}
                {!reading ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => void load()}
                  >
                    {t("remotes.auth.retry")}
                  </Button>
                ) : null}
              </section>

              <section className="space-y-1.5 border-t border-border/40 pt-3">
                <span className="text-xs font-medium text-foreground">
                  {t("remotes.auth.web.title")}
                </span>
                <p className="text-[11px] text-muted-foreground">
                  {t("remotes.auth.web.hint")}
                </p>
                {streaming ? (
                  <>
                    {/* 固定高度：一次性码一行行流进来时别再撑高弹窗（居中弹窗会跟着跳）。 */}
                    <pre className="h-24 overflow-auto rounded border border-border/60 bg-card px-2 py-1 font-mono text-[11px] whitespace-pre-wrap">
                      {stream || t("remotes.auth.web.running")}
                    </pre>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive"
                      onClick={() => void native.githubAuthLoginWebCancel()}
                    >
                      {t("remotes.auth.web.cancel")}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy !== null}
                    onClick={() => void loginWithWeb()}
                  >
                    {t("remotes.auth.web.start")}
                  </Button>
                )}
              </section>

              <section className="space-y-1.5 border-t border-border/40 pt-3">
                <span className="text-xs font-medium text-foreground">
                  {t("remotes.auth.token.title")}
                </span>
                <p className="text-[11px] text-muted-foreground">
                  {t("remotes.auth.token.hint")}
                </p>
                <Input
                  type="password"
                  value={token}
                  autoComplete="off"
                  disabled={busy !== null}
                  placeholder={t("remotes.auth.token.placeholder")}
                  className="h-7 text-xs"
                  onChange={(event) => setToken(event.target.value)}
                />
                {tokenHintKey ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t(tokenHintKey)}
                  </p>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={Boolean(problem) || busy !== null}
                  onClick={() => void loginWithToken()}
                >
                  {busy === "token"
                    ? t("remotes.auth.token.working")
                    : t("remotes.auth.token.submit")}
                </Button>
              </section>

              {view.loggedIn ? (
                <section className="space-y-1.5 border-t border-border/40 pt-3">
                  <span className="text-xs font-medium text-foreground">
                    {t("remotes.auth.logout.title")}
                  </span>
                  <p className="text-[11px] text-muted-foreground">
                    {t("remotes.auth.logout.hint", { account: view.account ?? "" })}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive"
                    disabled={busy !== null}
                    onClick={() => {
                      setActionError(null);
                      setLogoutOpen(true);
                    }}
                  >
                    {t("remotes.auth.logout.button")}
                  </Button>
                </section>
              ) : null}

              {actionError ? (
                <p className="whitespace-pre-wrap text-xs text-destructive">
                  {actionError}
                </p>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("remotes.auth.logout.confirm.title", {
                account: view.account ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("remotes.auth.logout.confirm.hint")}
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
              disabled={busy !== null}
              onClick={() => setLogoutOpen(false)}
            >
              {t("scm.common.cancel")}
            </Button>
            <Button disabled={busy !== null} onClick={() => void logout()}>
              {busy === "logout"
                ? t("remotes.auth.logout.running")
                : t("remotes.runs.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
