import { useT } from "@/modules/i18n";
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import type { Tab } from "@/modules/tabs";
import { TabBar, type TerminalChoice } from "@/modules/tabs";
import { NotificationBell } from "@/modules/notifications/NotificationBell";
import {
  Analytics01Icon,
  CommandIcon,
  CropIcon,
  GithubIcon,
  NoteIcon,
  Settings01Icon,
  SidebarLeftIcon,
  SidebarRightIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  /** Open a specific terminal (a local shell, or a terminal in a given distro). */
  onNewTerminal: (choice: TerminalChoice) => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
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
  /** Right-side Git panel: the same button as the top-left one, mirrored in position. */
  onToggleGitPanel: () => void;
  /** Open the projects panel: the local project list and the remote repositories read
   * by the local gh, behind one tab. */
  onOpenProjectsPanel: () => void;
  /** Open the notes tab: the list and the editor over the markdown beside the exe. */
  onOpenNotes: () => void;
  /** Region capture: grab the whole screen and drag out a region on the overlay. */
  onScreenshot: () => void;
  /** Uncommitted change count, shown on the top-right button (it used to sit on the Git
   * item in the left rail). */
  changedCount: number;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  /** The usage window: what the three tools spent, per day and per model. */
  onOpenUsage: () => void;
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
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  onToggleSidebar,
  onToggleGitPanel,
  onOpenProjectsPanel,
  onOpenNotes,
  onScreenshot,
  changedCount,
  onOpenCommandPalette,
  onOpenSettings,
  onOpenUsage,
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

  const usageButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenUsage}
      title={t("header.usage")}
    >
      <HugeiconsIcon icon={Analytics01Icon} size={15} strokeWidth={1.75} />
    </Button>
  );

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

      {/* biome-ignore lint/a11y/noStaticElementInteractions: this is the window drag strip, and its context menu handler only suppresses WebKit's reload */}
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

      {usageButton}

      <NotificationBell tabs={tabs} onJump={onSelect} />

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onOpenProjectsPanel}
        title={t("header.projectsPanel")}
        className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={GithubIcon} size={18} strokeWidth={1.75} />
      </Button>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onOpenNotes}
        title={t("header.notes")}
        className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HugeiconsIcon icon={NoteIcon} size={18} strokeWidth={1.75} />
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
