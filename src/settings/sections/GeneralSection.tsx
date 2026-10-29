import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { IS_WINDOWS } from "@/lib/platform";
import { type MessageKey, useLanguage, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ThemePref } from "@/modules/settings/store";
import {
  setLanguage,
  setConfirmCloseRunningTerminal,
  setDefaultWorkspaceEnv,
  setCloseToTray,
  setDesktopNotifications,
  setExplorerGitDecorations,
  setRestoreWindowState,
  setSessionListDensity,
  setShowHidden,
  setTaskbarAttentionFlash,
  setWslEnabled,
  setWslShutdownOnDisable,
  setTerminalCursorBlink,
  setTerminalCursorStyle,
  setTerminalFontFamily,
  setTerminalFontSize,
  setTerminalFontWeight,
  setTerminalLetterSpacing,
  setTerminalScrollback,
  setTerminalShell,
  setTerminalRenderer,
  setTerminalScreenReader,
  setZoomLevel,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
} from "@/modules/settings/store";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { FontPicker } from "../components/FontPicker";
import { SettingRow } from "../components/SettingRow";

const APPEARANCE: {
  id: ThemePref;
  /** Message key, resolved where it is drawn. */
  label: MessageKey;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "settings.mode.system", icon: ComputerIcon },
  { id: "light", label: "settings.mode.light", icon: Sun03Icon },
  { id: "dark", label: "settings.mode.dark", icon: Moon02Icon },
];

const TERMINAL_FONT_WEIGHTS = [
  { value: "normal", label: "settings.fontWeight.normal" },
  { value: "500", label: "settings.fontWeight.medium" },
  { value: "600", label: "settings.fontWeight.semiBold" },
  { value: "bold", label: "settings.fontWeight.bold" },
] as const;
const TERMINAL_CURSOR_STYLES = [
  { value: "bar", label: "settings.cursorStyle.bar" },
  { value: "block", label: "settings.cursorStyle.block" },
  { value: "underline", label: "settings.cursorStyle.underline" },
] as const;
const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;

type ShellInfo = { name: string; path: string; integrated: boolean };
const SHELL_AUTO = "auto";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;
export function GeneralSection() {
  const t = useT();
  const { mode, setMode } = useTheme();

  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const wslEnabled = usePreferencesStore((s) => s.wslEnabled);
  const wslShutdownOnDisable = usePreferencesStore(
    (s) => s.wslShutdownOnDisable,
  );
  const [wslResult, setWslResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  /**
   * Turning the switch off first stops Verta's own queries, then the setting decides
   * whether WSL itself shuts down. Shutting WSL down kills everything inside it
   * (including Docker Desktop's backend), so both outcomes are reported plainly.
   */
  const applyWslEnabled = async (value: boolean) => {
    await setWslEnabled(value);
    setWslResult(null);
    if (value || !wslShutdownOnDisable) return;
    setWslResult({ ok: true, text: t("settings.wslShutdown.running") });
    try {
      await invoke("wsl_shutdown");
      setWslResult({ ok: true, text: t("settings.wslShutdown.done") });
    } catch (error) {
      setWslResult({
        ok: false,
        text: t("settings.wslShutdown.failed", { message: String(error) }),
      });
    }
  };
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const sessionListDensity = usePreferencesStore((s) => s.sessionListDensity);
  const explorerGitDecorations = usePreferencesStore(
    (s) => s.explorerGitDecorations,
  );
  const closeToTray = usePreferencesStore((s) => s.closeToTray);
  const taskbarAttentionFlash = usePreferencesStore(
    (s) => s.taskbarAttentionFlash,
  );
  const desktopNotifications = usePreferencesStore(
    (s) => s.desktopNotifications,
  );
  const terminalRenderer = usePreferencesStore((s) => s.terminalRenderer);
  const terminalScreenReader = usePreferencesStore(
    (s) => s.terminalScreenReader,
  );
  const terminalCursorBlink = usePreferencesStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = usePreferencesStore((s) => s.terminalCursorStyle);
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalFontWeight = usePreferencesStore((s) => s.terminalFontWeight);
  const terminalShell = usePreferencesStore((s) => s.terminalShell);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [wslDistros, setWslDistros] = useState<{ name: string }[]>([]);
  const defaultWorkspaceEnv = usePreferencesStore((s) => s.defaultWorkspaceEnv);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const confirmCloseRunningTerminal = usePreferencesStore(
    (s) => s.confirmCloseRunningTerminal,
  );
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  useEffect(() => {
    void invoke<ShellInfo[]>("pty_list_shells")
      .then(setShells)
      .catch(() => {});
    void invoke<{ name: string }[]>("wsl_list_distros")
      .then(setWslDistros)
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title={t("settings.general.title")}
        description={t("settings.general.description")}
      />

      <LanguageSetting />

      <div className="flex flex-col gap-2">
        <Label>{t("settings.appearance")}</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{t(o.label)}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("settings.appearanceHint")}{" "}
          <strong className="font-medium text-foreground">
            {t("settings.themes")}
          </strong>{" "}
          {t("settings.appearanceHintTail")}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("settings.zoom")}</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              {t("settings.uiZoomLevel")}
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomLevel * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomLevel]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      {/* These switches drive Windows' taskbar and tray only, so they are hidden
          elsewhere. */}
      {IS_WINDOWS ? (
        <div className="flex flex-col gap-2">
          <Label>{t("settings.taskbar")}</Label>
          <SettingRow
            title={t("settings.closeToTray.title")}
            description={t("settings.closeToTray.description")}
          >
            <Switch
              checked={closeToTray}
              onCheckedChange={(v) => void setCloseToTray(v)}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.taskbarFlash.title")}
            description={t("settings.taskbarFlash.description")}
          >
            <Switch
              checked={taskbarAttentionFlash}
              onCheckedChange={(v) => void setTaskbarAttentionFlash(v)}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.desktopNotifications.title")}
            description={t("settings.desktopNotifications.description")}
          >
            <Switch
              checked={desktopNotifications}
              onCheckedChange={(v) => void setDesktopNotifications(v)}
            />
          </SettingRow>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label>{t("settings.explorer")}</Label>
        <SettingRow
          title={t("settings.showHidden.title")}
          description={t("settings.showHidden.description")}
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.gitDecorations.title")}
          description={t("settings.gitDecorations.description")}
        >
          <Switch
            checked={explorerGitDecorations}
            onCheckedChange={(v) => void setExplorerGitDecorations(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("settings.sessionList")}</Label>
        <SettingRow
          title={t("settings.sessionListDensity.title")}
          description={t("settings.sessionListDensity.description")}
        >
          <Select
            value={sessionListDensity}
            onValueChange={(value) => void setSessionListDensity(value)}
          >
            <SelectTrigger className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="standard">
                {t("settings.sessionListDensity.standard")}
              </SelectItem>
              <SelectItem value="compact">
                {t("settings.sessionListDensity.compact")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      {IS_WINDOWS ? (
        <div className="flex flex-col gap-2">
          <Label>{t("settings.wsl")}</Label>
          <SettingRow
            title={t("settings.wslEnabled.title")}
            description={t("settings.wslEnabled.description")}
          >
            <Switch
              checked={wslEnabled}
              onCheckedChange={(value) => void applyWslEnabled(value)}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.wslShutdown.title")}
            description={t("settings.wslShutdown.description")}
          >
            <Switch
              checked={wslShutdownOnDisable}
              onCheckedChange={(value) => void setWslShutdownOnDisable(value)}
            />
          </SettingRow>
          {wslResult ? (
            <p
              className={cn(
                "text-[11px]",
                wslResult.ok ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {wslResult.text}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label>{t("settings.terminal")}</Label>
        <SettingRow
          title={t("settings.terminalRenderer.title")}
          description={t("settings.terminalRenderer.description")}
        >
          <Select
            value={terminalRenderer}
            onValueChange={(value) =>
              void setTerminalRenderer(value === "webgl" ? "webgl" : "auto")
            }
          >
            <SelectTrigger className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">
                {t("settings.terminalRenderer.auto")}
              </SelectItem>
              <SelectItem value="webgl">WebGL</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.screenReader.title")}
          description={t("settings.screenReader.description")}
        >
          <Switch
            checked={terminalScreenReader}
            onCheckedChange={(value) => void setTerminalScreenReader(value)}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.cursorBlink.title")}
          description={t("settings.cursorBlink.description")}
        >
          <Switch
            checked={terminalCursorBlink}
            onCheckedChange={(v) => void setTerminalCursorBlink(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.cursorStyle.title")}
          description={t("settings.cursorStyle.description")}
        >
          <Select
            value={terminalCursorStyle}
            onValueChange={(v) => void setTerminalCursorStyle(v)}
          >
            <SelectTrigger
              value={terminalCursorStyle}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_CURSOR_STYLES.map((style) => (
                <SelectItem
                  key={style.value}
                  value={style.value}
                  className="text-[12px]"
                >
                  {t(style.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.fontFamily.title")}
          description={t("settings.fontFamily.description")}
        >
          <FontPicker
            value={terminalFontFamily}
            onChange={(v) => void setTerminalFontFamily(v)}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.fontWeight.title")}
          description={t("settings.fontWeight.description")}
        >
          <Select
            value={terminalFontWeight}
            onValueChange={(v) => void setTerminalFontWeight(v)}
          >
            <SelectTrigger
              value={terminalFontWeight}
              className="h-8 w-28 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_WEIGHTS.map((w) => (
                <SelectItem
                  key={w.value}
                  value={w.value}
                  className="text-[12px]"
                >
                  {t(w.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.shell.title")}
          description={
            shells.find((s) => s.path === terminalShell)?.integrated === false
              ? t("settings.shell.noBlocks")
              : wslDistros.length > 0
                ? t("settings.shell.wslHint")
                : t("settings.shell.hint")
          }
        >
          <Select
            value={terminalShell || SHELL_AUTO}
            onValueChange={(v) =>
              void setTerminalShell(v === SHELL_AUTO ? "" : v)
            }
          >
            <SelectTrigger
              value={terminalShell || SHELL_AUTO}
              className="h-8 w-40 text-[12px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SHELL_AUTO} className="text-[12px]">
                {t("settings.shell.auto")}
              </SelectItem>
              {shells.map((s) => (
                <SelectItem key={s.path} value={s.path} className="text-[12px]">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {(wslDistros.length > 0 || defaultWorkspaceEnv !== "local") && (
          <SettingRow
            title={t("settings.workspaceEnv.title")}
            description={t("settings.workspaceEnv.description")}
          >
            <Select
              value={defaultWorkspaceEnv}
              onValueChange={(v) => void setDefaultWorkspaceEnv(v)}
            >
              <SelectTrigger
                value={defaultWorkspaceEnv}
                className="h-8 w-40 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local" className="text-[12px]">
                  {t("settings.workspaceEnv.windows")}
                </SelectItem>
                {wslDistros.map((d) => (
                  <SelectItem
                    key={d.name}
                    value={`wsl:${d.name}`}
                    className="text-[12px]"
                  >
                    {t("settings.workspaceEnv.wsl", { distro: d.name })}
                  </SelectItem>
                ))}
                {defaultWorkspaceEnv.startsWith("wsl:") &&
                  !wslDistros.some(
                    (d) => `wsl:${d.name}` === defaultWorkspaceEnv,
                  ) && (
                    <SelectItem
                      value={defaultWorkspaceEnv}
                      className="text-[12px]"
                    >
                      {t("settings.workspaceEnv.unavailable", {
                        name: defaultWorkspaceEnv.slice("wsl:".length),
                      })}
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
        <SettingRow
          title={t("settings.letterSpacing.title")}
          description={t("settings.letterSpacing.description")}
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.fontSize.title")}
          description={t("settings.fontSize.description")}
        >
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem
                  key={size}
                  value={String(size)}
                  className="text-[12px]"
                >
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.scrollback.title")}
          description={t("settings.scrollback.description")}
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {t("settings.scrollback.lines", {
                    count: lines.toLocaleString(),
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={t("settings.confirmKill.title")}
          description={t("settings.confirmKill.description")}
        >
          <Switch
            checked={confirmCloseRunningTerminal}
            onCheckedChange={(v) => void setConfirmCloseRunningTerminal(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("settings.startup")}</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title={t("settings.restoreWindow.title")}
            description={t("settings.restoreWindow.description")}
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * Interface language.
 *
 * "System" is the default and resolves against the OS locale at render time, so
 * switching it back costs nothing; the two explicit options are the override.
 */
function LanguageSetting() {
  const t = useT();
  const language = useLanguage();
  const pref = usePreferencesStore((s) => s.language);
  return (
    <div className="flex flex-col gap-2">
      <Label>{t("settings.language.title")}</Label>
      <SettingRow
        title={t("settings.language.title")}
        description={t("settings.language.description")}
      >
        <Select
          value={pref ?? "system"}
          onValueChange={(v) => void setLanguage(v as "system" | "zh" | "en")}
        >
          <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">
              {t("settings.languageSystem")}
            </SelectItem>
            <SelectItem value="zh">中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
      <p className="text-[11px] text-muted-foreground">
        {t("settings.languageActive", {
          language: language === "zh" ? "中文" : "English",
        })}
      </p>
    </div>
  );
}
