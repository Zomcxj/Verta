import { Button } from "@/components/ui/button";
import { useT } from "@/modules/i18n";
import { useUpdater } from "@/modules/updater";
import { GithubIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch, platform } from "@tauri-apps/plugin-os";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/**
 * 你的仓库地址与站点。留空时 About 页的「源码 / 网站」行与「报告问题」按钮都不显示，
 * 发布时把地址填在这里即可。
 */
const REPO_URL = "";
const WEBSITE = "";

const PLATFORM_LABEL: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
  freebsd: "FreeBSD",
};

export function AboutSection() {
  const t = useT();
  const [version, setVersion] = useState("");
  const [name, setName] = useState("Verta");
  const [build, setBuild] = useState("");
  const { status, check, install } = useUpdater({ autoCheck: false });
  const checking = status.kind === "checking";
  const downloading = status.kind === "downloading";
  const available = status.kind === "available";
  const manualAvailable = status.kind === "manual-available";
  const ready = status.kind === "ready";
  const checkLabel =
    status.kind === "uptodate"
      ? t("settings.about.update.upToDate")
      : status.kind === "error"
        ? t("settings.about.update.failed")
        : checking
          ? t("settings.about.update.checking")
          : downloading
            ? t("settings.about.update.downloading")
            : ready
              ? t("settings.about.update.restart")
              : available
                ? t("settings.about.update.install", {
                    version: status.update.version,
                  })
                : manualAvailable
                  ? t("settings.about.update.manual", {
                      version: status.info.version,
                    })
                  : t("settings.about.update.check");
  const onUpdateClick = () => {
    if (available) void install();
    else void check({ manual: true });
  };

  useEffect(() => {
    void getVersion().then(setVersion);
    void getName().then(setName);
    try {
      const p = platform();
      const a = arch();
      const platformLabel = PLATFORM_LABEL[p] ?? p;
      setBuild(`${platformLabel} · ${a}`);
    } catch {
      setBuild("");
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title={t("settings.about.title")} description="" />

      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/60 p-5">
        <img src="/logo.png" alt="" className="size-12" draggable={false} />
        <div className="flex min-w-0 flex-col">
          <span className="text-[15px] font-semibold tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {t("settings.about.tagline")}
          </span>
          <span className="mt-1 font-mono text-[11px] text-muted-foreground">
            v{version || "—"}
          </span>
        </div>
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-2.5 text-[12px]">
        <dt className="text-muted-foreground">{t("settings.about.build")}</dt>
        <dd className="font-mono text-[11.5px]">
          {build ? `${build} · v${version}` : `v${version}`}
        </dd>

        <dt className="text-muted-foreground">
          {t("settings.about.bundleId")}
        </dt>
        <dd className="font-mono text-[11.5px]">app.verta</dd>

        <dt className="text-muted-foreground">{t("settings.about.license")}</dt>
        <dd>Apache 2.0</dd>

        {REPO_URL ? (
          <>
            <dt className="text-muted-foreground">
              {t("settings.about.source")}
            </dt>
            <dd>
              <button
                type="button"
                onClick={() => void openUrl(REPO_URL)}
                className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
              >
                <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
                {REPO_URL}
              </button>
            </dd>
          </>
        ) : null}
        {WEBSITE ? (
          <>
            <dt className="text-muted-foreground">
              {t("settings.about.website")}
            </dt>
            <dd>
              <button
                type="button"
                onClick={() => void openUrl(WEBSITE)}
                className="inline-flex items-center gap-1.5 rounded-md text-[12px] underline-offset-2 hover:text-foreground hover:underline"
              >
                <HugeiconsIcon
                  icon={Globe02Icon}
                  size={12}
                  strokeWidth={1.75}
                />
                {WEBSITE}
              </button>
            </dd>
          </>
        ) : null}
      </dl>

      <div className="flex flex-col gap-1.5">
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={onUpdateClick}
            disabled={checking || downloading || ready}
          >
            {checkLabel}
          </Button>
          {REPO_URL ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openUrl(REPO_URL)}
                className="gap-1.5"
              >
                <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.75} />
                {t("settings.about.github")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void openUrl(`${REPO_URL}/issues/new`)}
              >
                {t("settings.about.issue")}
              </Button>
            </>
          ) : null}
        </div>
        {status.kind === "error" && (
          <p className="font-mono text-[10.5px] break-all text-destructive/80">
            {status.message}
          </p>
        )}
        {downloading && status.contentLength ? (
          <p className="text-[11px] text-muted-foreground">
            {Math.min(
              100,
              Math.round((status.downloaded / status.contentLength) * 100),
            )}
            %
          </p>
        ) : null}
      </div>
    </div>
  );
}
