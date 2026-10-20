import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 克隆完成后落地目录的路径（可能已被后端登记为已授权）。 */
  onCloned: (path: string) => void;
};

/**
 * 克隆一个新仓库。
 *
 * 目标目录上一级不存在时后端会直接拒绝，并把缺的是哪一级写清楚 —— 这比让 git 报
 * "could not create work tree dir" 好懂。克隆中途可能要几十秒，这里如实显示忙状态。
 */
export function CloneRepoDialog({ open, onOpenChange, onCloned }: Props) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const trimmedUrl = url.trim();
    const trimmedDest = dest.trim();
    if (!trimmedUrl || !trimmedDest || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await native.gitCloneRepo(trimmedUrl, trimmedDest);
      // 克隆出来的目录要能直接被打开：先授权，再交给项目页。
      await native.workspaceAuthorize(path).catch(() => null);
      setUrl("");
      setDest("");
      onOpenChange(false);
      onCloned(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("projects.clone.title")}</DialogTitle>
          <DialogDescription>{t("projects.clone.hint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={t("projects.clone.urlPlaceholder")}
          />
          <Input
            value={dest}
            onChange={(event) => setDest(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={t("projects.clone.destPlaceholder")}
          />
        </div>
        {error ? (
          <p className="whitespace-pre-wrap text-xs text-destructive">{error}</p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy}>
            {t("scm.common.cancel")}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !url.trim() || !dest.trim()}
          >
            {busy ? t("projects.clone.running") : t("projects.clone.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}