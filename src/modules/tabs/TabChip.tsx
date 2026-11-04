import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  ALL_LANGUAGES,
  EXPOSED_LANGUAGES,
} from "@/modules/editor/lib/languageDefinitions";
import { resolveDisplayName } from "@/modules/editor/lib/languageResolver";
import { FileIcon } from "@/modules/explorer/FileIcon";
import { useT } from "@/modules/i18n";
import { AgentIcon } from "@/modules/launcher";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  Clock01Icon,
  ComputerTerminal02Icon,
  Folder01Icon,
  GitCompareIcon,
  Globe02Icon,
  IncognitoIcon,
  NoteIcon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Fragment,
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { leafIds, useAgentActivityStore } from "@/modules/terminal";
import { AgentStateDot } from "@/modules/terminal/AgentStateDot";
import { labelFor } from "./lib/tabLabel";
import { tabAgentIcon } from "./lib/tabAgentIcon";
import {
  selectTabAgentStatusFromLeaves,
  selectTabAgentUnseen,
} from "./lib/tabAgentStatus";
import type { Tab, TerminalTab } from "./lib/useTabs";

/** A pointer event from a chip's own element. */
export type TabChipDragEvent = ReactPointerEvent<HTMLElement>;

/** Pointer plumbing for dragging a chip along the strip. One shared object, stable for the life of the
 *  strip, because it is a prop of every chip and a fresh object would re-render all of them. */
export type ChipDrag = {
  begin: (tabId: number, event: TabChipDragEvent) => void;
  move: (event: TabChipDragEvent) => void;
  end: (tabId: number, event: TabChipDragEvent) => void;
};

type Props = {
  tab: Tab;
  /** This is the active tab. */
  active: boolean;
  /** Renaming this tab in place. */
  renaming: boolean;
  /** Play the enter animation: opened after the first paint, never a restored tab. */
  animateIn: boolean;
  /** This chip is the one being dragged, so it reads as lifted. */
  dragging: boolean;
  /** Draw the drop indicator before / after this chip. */
  gapBefore: boolean;
  gapAfter: boolean;
  /** More than one tab is open: the close chip and its menu items exist. */
  closable: boolean;
  /** Another tab sits to the right: "close to the right" is enabled. */
  hasTabsToRight: boolean;
  /** This is the only tab, which changes the trigger's padding. */
  onlyTab: boolean;
  compact?: boolean;
  onClose: (id: number) => void;
  onCloseTabsToRight: (id: number) => void;
  onCloseOtherTabs: (id: number) => void;
  onPin: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  /** Open / close in-place rename. */
  onRenameStart: (id: number) => void;
  onRenameEnd: () => void;
  drag: ChipDrag;
};

/**
 * One tab in the strip.
 *
 * Memoised, and that is the point: the strip re-renders for its own reasons (the sliding pill is
 * measured and set as state, a drag updates the gap) and for the window's, and a chip carries a
 * dropdown menu, a context menu and their popper layers, which is a few dozen Radix components. Inline
 * it in the strip's map, every one of those re-rendered on every strip render. Only the two chips a
 * switch touches need to render now.
 *
 * Everything that changes it is a primitive or a stable callback, so the memo holds. `showAllLanguages`
 * lives here rather than in the strip for the same reason: only the open menu cares, and as a strip
 * state it re-rendered every chip every time the language list was expanded.
 */
export const TabChip = memo(function TabChip({
  tab,
  active,
  renaming,
  animateIn,
  dragging,
  gapBefore,
  gapAfter,
  closable,
  hasTabsToRight,
  onlyTab,
  compact = false,
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onPin,
  onRename,
  onOverrideLanguage,
  onRenameStart,
  onRenameEnd,
  drag,
}: Props) {
  const tr = useT();
  const [showAllLanguages, setShowAllLanguages] = useState(false);

  // A terminal tab's state comes from the live activity store: the leaves are this
  // tab's own, and their ptys are looked up through the store's leaf map, so a dot
  // appears the moment the judge reports the agent.
  const leaves = useMemo(
    () => (tab.kind === "terminal" ? leafIds(tab.paneTree) : []),
    [tab],
  );
  const agentStatus = useAgentActivityStore(
    useShallow((state) => selectTabAgentStatusFromLeaves(state, leaves)),
  );
  // The latch, not the state: a session waiting since the user was last on this tab.
  const unseenAttention = useAgentActivityStore(
    useShallow((state) => selectTabAgentUnseen(state, leaves)),
  );

  const isPreview =
    (tab.kind === "editor" || tab.kind === "git-diff") && tab.preview;

  // While renaming, render a non-button cell so the <input> is not nested inside
  // the trigger <button> (invalid HTML, and WebKit blocks focus/selection on
  // inputs inside buttons).
  if (renaming && tab.kind === "terminal") {
    return (
      <Fragment>
        {gapBefore && <DropIndicator />}
        <div
          data-tab-id={tab.id}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent text-xs text-foreground",
            compact ? "px-1.5" : "px-2",
          )}
        >
          <TabIcon tab={tab} />
          <TabRenameInput
            initial={labelFor(tab)}
            onCommit={(value) => {
              onRename(tab.id, value);
              onRenameEnd();
            }}
            onCancel={onRenameEnd}
          />
        </div>
        {gapAfter && <DropIndicator />}
      </Fragment>
    );
  }

  const trigger = (
    <TabsTrigger
      value={String(tab.id)}
      data-tab-id={tab.id}
      data-tab-active={active ? "true" : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
        drag.begin(tab.id, e);
      }}
      onPointerMove={(e) => drag.move(e)}
      onPointerUp={(e) => drag.end(tab.id, e)}
      onPointerCancel={(e) => drag.end(tab.id, e)}
      onDoubleClick={() => isPreview && onPin(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1 && closable) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
      // Suppress Radix's switch-on-mousedown so a tab grabbed to drag (or a plain
      // click) only activates on release.
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          return;
        }
        if (
          e.button === 0 &&
          !(e.target as HTMLElement).closest("[data-no-drag]")
        ) {
          e.preventDefault();
        }
      }}
      className={cn(
        "group relative z-[1] h-7 shrink-0 justify-between gap-1.5 rounded-md bg-transparent text-xs transition-colors data-active:bg-transparent dark:data-active:bg-transparent",
        animateIn && "verta-tab-in",
        active
          ? "text-foreground dark:text-foreground"
          : "text-muted-foreground hover:text-foreground/80 dark:text-muted-foreground",
        dragging && "opacity-50",
        compact ? "px-1.5!" : onlyTab ? "px-2!" : "ps-2! pe-1!",
      )}
    >
      {unseenAttention ? (
        <span
          aria-hidden
          data-agent-unseen
          className="pointer-events-none absolute inset-y-1 start-0 w-0.5 rounded-full bg-sky-500"
        />
      ) : null}
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          compact ? "max-w-48" : "max-w-80",
        )}
      >
        {tab.kind === "editor" ? (
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) setShowAllLanguages(false);
            }}
          >
            <DropdownMenuTrigger asChild>
              {/* span, not button: a button nested in the TabsTrigger button is invalid DOM and breaks WebKit focus. */}
              {/* biome-ignore lint/a11y/useSemanticElements: a real button here would nest a button inside the tab trigger button and break WebKit focus */}
              <span
                role="button"
                tabIndex={-1}
                data-no-drag
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-1 -m-1 transition-all hover:bg-accent hover:text-accent-foreground hover:ring-1 hover:ring-primary/30 hover:shadow-[0_0_4px_var(--color-popover-foreground)]"
              >
                <TabIcon tab={tab} />
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              sideOffset={6}
              alignOffset={-4}
              className="max-h-75 w-48 overflow-y-auto rounded-xl border border-border/40 bg-popover p-1 shadow-lg"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
            >
              <DropdownMenuItem
                onSelect={() => {
                  onOverrideLanguage?.(tab.id, null);
                }}
                className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
              >
                <FileIcon
                  name={tab.title}
                  className="size-3.5 shrink-0 object-contain"
                />
                <div className="flex flex-1 flex-col">
                  <span>{tr("tabs.language.auto")}</span>
                  <span className="text-[10px] text-muted-foreground italic">
                    Mode: {resolveDisplayName(tab.title)}
                  </span>
                </div>
                {!tab.overrideLanguage && (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    className="size-3.5 text-primary"
                  />
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setShowAllLanguages((v) => !v);
                }}
                className="w-full px-2.5 py-1.5 text-left text-xs text-primary/60 hover:text-primary rounded-lg transition-colors hover:bg-accent"
              >
                {showAllLanguages ? "↑ Fewer languages" : "↓ All languages"}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="my-1 border-t border-border/30" />
              {(showAllLanguages ? ALL_LANGUAGES : EXPOSED_LANGUAGES).map(
                (lang) => {
                  const isSelected = tab.overrideLanguage === lang.ext;
                  return (
                    <DropdownMenuItem
                      key={lang.ext}
                      onSelect={() => onOverrideLanguage?.(tab.id, lang.ext)}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
                    >
                      <FileIcon
                        name={`dummy.${lang.ext}`}
                        className="size-3.5 shrink-0 object-contain"
                      />
                      <span className="flex-1">{lang.name}</span>
                      {isSelected && (
                        <HugeiconsIcon
                          icon={Tick02Icon}
                          className="size-3.5 text-primary"
                        />
                      )}
                    </DropdownMenuItem>
                  );
                },
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <TabIcon tab={tab} />
        )}
        {/* Preview tabs use italic to signal the transient state,
            matching the visual convention from VSCode. */}
        <span className={cn("truncate", isPreview && "italic")}>
          {labelFor(tab)}
        </span>
        {/* The state marker rides the icon's kind, not the store: only a tab whose icon is an
            agent's says "an agent is on this session", and only that tab is marked. */}
        {agentStatus.state !== null && tabAgentIcon(tab) !== null ? (
          <AgentStateDot state={agentStatus.state} />
        ) : null}
        {tab.kind === "editor" && tab.dirty ? (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the dot is decorative and the label is a hint on the tab; an image role would add a second announcement
          <span
            aria-label={tr("tabs.unsaved")}
            className="size-1.5 shrink-0 rounded-full bg-foreground/70"
          />
        ) : null}
      </span>
      {closable && (
        // biome-ignore lint/a11y/useFocusableInteractive: a tabindex here would take DOM focus off the tab trigger and onto the close chip
        // biome-ignore lint/a11y/useKeyWithClickEvents: this chip is mouse only by design and sits inside the tab button, which owns keyboard activation
        // biome-ignore lint/a11y/useSemanticElements: a real button here would nest a button inside the tab trigger button
        <span
          role="button"
          aria-label={tr("tabs.close")}
          data-no-drag
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </span>
      )}
    </TabsTrigger>
  );

  return (
    <Fragment>
      {gapBefore && <DropIndicator />}
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent
          className="min-w-32 p-1"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {tab.kind === "terminal" && (
            <>
              <ContextMenuItem
                className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                onSelect={() => onRenameStart(tab.id)}
              >
                <HugeiconsIcon
                  icon={PencilEdit02Icon}
                  size={13}
                  strokeWidth={1.75}
                />
                <span className="flex-1">{tr("tabs.rename")}</span>
              </ContextMenuItem>
              {closable && (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                    onSelect={() => onClose(tab.id)}
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={13}
                      strokeWidth={1.75}
                    />
                    <span className="flex-1">{tr("tabs.close")}</span>
                  </ContextMenuItem>
                </>
              )}
            </>
          )}
          <ContextMenuItem
            className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
            disabled={!hasTabsToRight}
            onSelect={() => onCloseTabsToRight(tab.id)}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={13}
              strokeWidth={1.75}
            />
            <span className="flex-1">{tr("tabs.closeRight")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
            disabled={!closable}
            onSelect={() => onCloseOtherTabs(tab.id)}
          >
            <HugeiconsIcon
              icon={CancelCircleIcon}
              size={13}
              strokeWidth={1.75}
            />
            <span className="flex-1">{tr("tabs.closeOthers")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {gapAfter && <DropIndicator />}
    </Fragment>
  );
});

export function DropIndicator() {
  return (
    <span
      aria-hidden
      className="my-0.5 w-0.5 shrink-0 self-stretch rounded-full bg-primary"
    />
  );
}

function TerminalTabIcon({ tab }: { tab: TerminalTab }) {
  // A tab opened for an agent (a resumed session, or a project row's "open
  // with") keeps that agent's mark instead of the plain terminal one. The
  // state marker asks the same question through the same predicate, so the
  // icon and the marker cannot come apart again: see `lib/tabAgentIcon.ts`.
  const agent = tabAgentIcon(tab);
  if (agent) {
    return <AgentIcon agent={agent} size={14} className="shrink-0" />;
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

export function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor" || tab.kind === "markdown") {
    return (
      <FileIcon
        name={
          tab.kind === "editor" && tab.overrideLanguage
            ? `dummy.${tab.overrideLanguage}`
            : tab.title
        }
        className="size-3.5 shrink-0 object-contain"
      />
    );
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "projects") {
    return (
      <HugeiconsIcon
        icon={Folder01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "notes") {
    return (
      <HugeiconsIcon
        icon={NoteIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return <TerminalTabIcon tab={tab} />;
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const ref = useRef<HTMLInputElement>(null);
  // Guards against a trailing blur re-resolving an edit that Enter/Escape
  // already finished (Escape must never commit).
  const done = useRef(false);

  useEffect(() => {
    // Focus on the next frame so it runs after the context menu restores focus
    // to its trigger when closing; a synchronous focus would be stolen.
    const raf = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  // explicit = the user pressed Enter, which pins even the unchanged label. A
  // plain blur with no change must not freeze the cwd-derived default into a
  // custom title.
  const commit = (value: string, explicit: boolean) => {
    if (!explicit && value.trim() === initial.trim()) finish(onCancel);
    else finish(() => onCommit(value));
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={tr("tabs.rename")}
      className={cn(
        "w-28 min-w-0 rounded-sm bg-background px-1 text-xs text-foreground",
        "outline-none ring-1 ring-border focus:ring-ring",
      )}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value, true);
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={(e) => {
        // Switching windows/apps blurs the input; keep the edit open instead
        // of resolving it on the way out.
        if (!document.hasFocus()) return;
        commit(e.currentTarget.value, false);
      }}
    />
  );
}
