import { useT } from "@/modules/i18n";
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { Tab } from "@/modules/tabs";
import { TabBar, type TerminalChoice } from "@/modules/tabs";
import {
  CommandIcon,
  CropIcon,
  GithubIcon,
  Settings01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  /** 明确选一个终端（本机某个 shell，或某个发行版的终端）。 */
  onNewTerminal: (choice: TerminalChoice) => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onNewProjects: () => void;
  onClose: (id: number) => void;
  /** Chrome-style: close every tab to the right of the given tab. */
  onCloseTabsToRight: (id: number) => void;
  /** Chrome-style: close every tab except the given tab. */
  onCloseOtherTabs: (id: number) => void;
  /** Promote a preview (transient) tab to persistent. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  /** Move a dragged tab to a new position (insertion gap index). */
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  onToggleSidebar: () => void;
  /** 右侧 Git 面板：与左上角那个按钮同款，位置上对称。 */
  onToggleGitPanel: () => void;
  /** 打开远程仓库列表标签页（本机 gh 读到的账号级仓库）。 */
  onOpenRemotes: () => void;
  /** 区域截图：抓整屏，在覆盖窗口上拖一块出来。 */
  onScreenshot: () => void;
  /** 未提交改动数，显示在右上角按钮上（原先在左栏的 Git 项上）。 */
  changedCount: number;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
};

const COMPACT_WIDTH = 720;

export function Header({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewTerminal,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onNewProjects,
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  onToggleSidebar,
  onToggleGitPanel,
  onOpenRemotes,
  onScreenshot,
  changedCount,
  onOpenCommandPalette,
  onOpenSettings,
  searchTarget,
  searchRef,
}: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenSettings}
      title={t("header.settings")}
    >
      <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
    </Button>
  );

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className={`flex h-10 shrink-0 items-center gap-2 select-none ${
        IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
      }`}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          onClick={onToggleSidebar}
          title={t("header.toggleSidebar")}
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onOpenCommandPalette}
          title={t("header.commandPalette")}
          className="shrink-0 gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={CommandIcon} size={14} strokeWidth={1.75} />
        </Button>
      </div>

      {!IS_MAC && (
        <span className="mx-1.5 h-4 w-px shrink-0 rounded-full bg-border" />
      )}

      {IS_MAC && (
        <span className="mr-1.5 h-4 w-px shrink-0 rounded-full bg-border" />
      )}

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
        onContextMenu={(e) => {
          // Empty chrome falls through to WebKit Reload, which reloads the
          // webview and pty_close_all's every shell (#1242). Per-tab menus
          // still open: Radix handles the trigger before this bubbles.
          e.preventDefault();
        }}
      >
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onNewTerminal={onNewTerminal}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
          onNewProjects={onNewProjects}
          onClose={onClose}
          onCloseTabsToRight={onCloseTabsToRight}
          onCloseOtherTabs={onCloseOtherTabs}
          onPin={onPin}
          onRename={onRename}
          onReorder={onReorder}
          onOverrideLanguage={onOverrideLanguage}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onOpenRemotes}
        title={t("header.remotes")}
        className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={GithubIcon} size={18} strokeWidth={1.75} />
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onScreenshot}
        title={t("header.screenshot")}
        className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={CropIcon} size={18} strokeWidth={1.75} />
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggleGitPanel}
        title={t("header.toggleGitPanel")}
        className="relative shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={SidebarRightIcon} size={18} strokeWidth={1.75} />
        {changedCount > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none text-primary-foreground tabular-nums">
            {changedCount > 99 ? "99+" : changedCount}
          </span>
        ) : null}
      </Button>

      {IS_MAC && settingsButton}

      {!IS_MAC && settingsButton}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
