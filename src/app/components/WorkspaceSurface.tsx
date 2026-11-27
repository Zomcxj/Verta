import { cn } from "@/lib/utils";
import { EditorStack, GitDiffStack } from "@/modules/editor";
import { GitHistoryStack } from "@/modules/git-history";
import { ProjectsView } from "@/modules/projects";
import type { ProjectEntry } from "@/modules/projects";
import { RemoteReposView } from "@/modules/remotes";
import type { AgentTool } from "@/modules/launcher";
import { MarkdownStack } from "@/modules/markdown";
import { NotesStack } from "@/modules/notes";
import { PreviewStack } from "@/modules/preview";
import type { Tab, TabPatch } from "@/modules/tabs";
import { TerminalStack } from "@/modules/terminal";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useT } from "@/modules/i18n";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  SessionOpeningOverlay,
  sessionTransitionEnabled,
} from "./SessionOpeningOverlay";

type TerminalStackProps = ComponentProps<typeof TerminalStack>;
type EditorStackProps = ComponentProps<typeof EditorStack>;
type PreviewStackProps = ComponentProps<typeof PreviewStack>;
type GitHistoryStackProps = ComponentProps<typeof GitHistoryStack>;

type Props = {
  tabs: Tab[];
  activeId: number;
  activeTab: Tab | undefined;
  registerTerminalHandle: TerminalStackProps["registerHandle"];
  onSearchReady: TerminalStackProps["onSearchReady"];
  onCwd: TerminalStackProps["onCwd"];
  onExit: TerminalStackProps["onExit"];
  onFocusLeaf: TerminalStackProps["onFocusLeaf"];
  registerEditorHandle: EditorStackProps["registerHandle"];
  onEditorDirtyChange: EditorStackProps["onDirtyChange"];
  onEditorCloseTab: EditorStackProps["onCloseTab"];
  registerPreviewHandle: PreviewStackProps["registerHandle"];
  onPreviewUrlChange: PreviewStackProps["onUrlChange"];
  onOpenCommitFile: GitHistoryStackProps["onOpenCommitFile"];
  onGitHistorySearchHandle: GitHistoryStackProps["onSearchHandle"];
  onSetMarkdownView: EditorStackProps["onSetMarkdownView"];
  onOpenProject: (entry: ProjectEntry) => void;
  onOpenProjectTerminal: (entry: ProjectEntry) => void;
  onOpenProjectGitGraph: (entry: ProjectEntry) => void;
  onNewProjectSession: (entry: ProjectEntry, tool: AgentTool) => void;
  /** Which list the projects panel is showing; the app renames the tab to match, since
   * the tab chip and the window title should name what is on screen. */
  onProjectsSubChange: (sub: ProjectsSub) => void;
  /** Patch a notes tab (its selected note, its dirty flag, its folder). */
  onNotesUpdate: (id: number, patch: TabPatch) => void;
  /** The session-start transition, drawn over the terminal layer only (see
   * `SessionOpeningOverlay`). */
  sessionOpening: boolean;
  /** Which agent the transition is covering for; `null` when nothing named it. */
  sessionOpeningTool: string | null;
  /**
   * Every leaf whose session is starting, whether or not its tab is the one on screen.
   *
   * Separate from `sessionOpening` because the two answer different questions. `sessionOpening`
   * says whether to draw the layer right now (it belongs to one tab and must not hang over someone
   * else's terminal); this says which panes still have to stay hidden while their sessions start.
   * A tab switch must lift the layer without uncovering those panes: their command lines are already
   * on their screens, so revealing them for the frames before the reader comes back is exactly the
   * flicker the layer exists to prevent.
   *
   * A list rather than one leaf: several sessions can be opened one after another, and each covers
   * its own pane until its own UI is painted.
   */
  sessionOpeningLeaves: readonly number[];
  /**
   * The session on screen, if one is open. Review notes on a diff are written for it:
   * the diff does not carry a session of its own, and the agent a reader is looking at
   * is the one they mean.
   */
  activeSessionId?: string | null;
};

/** The two lists behind the projects panel. */
export type ProjectsSub = "projects" | "remotes";

const LAYER = "absolute inset-0";

/**
 * The inset both sub-tab panes of the projects tab sit inside.
 *
 * It is shared rather than written twice because the two panes are read as one surface: each of
 * their views already insets its own content, so the row of controls at the top of one has to
 * start at the same height as the row at the top of the other. Written twice, one of them had an
 * extra `pt-1` and its filter row sat four pixels lower than the other's - measured, `筛选路径`
 * at 87 and `筛选仓库` at 83, with the two inputs themselves identical.
 */
const PANE_INSET = "px-1 pt-1 pb-2";

/**
 * Stacks every tab-kind surface absolutely on top of each other and toggles
 * visibility off the active tab, so panes keep their mounted state (terminal
 * buffers, editor scroll, ...) when switching tabs.
 *
 * Layers sit flush inside the workspace pane; only the terminal layer is inset,
 * because the terminal draws glyphs right up to its container edge.
 */
export function WorkspaceSurface({
  tabs,
  activeId,
  activeTab,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
  onFocusLeaf,
  registerEditorHandle,
  onEditorDirtyChange,
  onEditorCloseTab,
  registerPreviewHandle,
  onPreviewUrlChange,
  onOpenCommitFile,
  onGitHistorySearchHandle,
  onSetMarkdownView,
  onOpenProject,
  onOpenProjectTerminal,
  onOpenProjectGitGraph,
  onNewProjectSession,
  onProjectsSubChange,
  onNotesUpdate,
  sessionOpening,
  sessionOpeningTool,
  sessionOpeningLeaves,
  activeSessionId = null,
}: Props) {
  const t = useT();
  const kind = activeTab?.kind;
  const isTerminalTab = kind === "terminal";
  const isEditorTab = kind === "editor";
  const isPreviewTab = kind === "preview";
  const isMarkdownTab = kind === "markdown";
  const isGitDiffTab = kind === "git-diff" || kind === "git-commit-file";
  const isGitHistoryTab = kind === "git-history";
  const isProjectsTab = kind === "projects";
  const isNotesTab = kind === "notes";
  const transitionVariant = usePreferencesStore((s) => s.sessionTransition);
  /**
   * Whether the transition is covering the pane right now. Only then are the panes hidden:
   * with the animation set to `none` the terminal has to stay visible while the session
   * starts, or the middle of the window would just be blank.
   */
  const sessionCovered =
    sessionOpening && sessionTransitionEnabled(transitionVariant);
  /**
   * The leaf whose pane has to stay hidden while its session starts, whatever tab is on screen.
   *
   * This is not `sessionCovered`: that one is "draw the layer", which is false as soon as the reader
   * switches away. The pane it covers is still starting, and its own screen already holds the resume
   * command, so uncovering it on the way out is what made switching tabs and coming back show a bare
   * terminal with the command on it.
   */
  const coveredLeaves = sessionTransitionEnabled(transitionVariant)
    ? sessionOpeningLeaves
    : [];
  const [projectsSub, setProjectsSub] = useState<ProjectsSub>("projects");
  const hasProjectsTab = tabs.some((tab) => tab.kind === "projects");
  const subStripRef = useRef<HTMLDivElement | null>(null);
  const [subPill, setSubPill] = useState<{
    left: number;
    width: number;
  } | null>(null);
  /** The first measurement must not animate, or the pill flies in from the left. */
  const subPillReady = useRef(false);

  // Closing the panel and opening it again starts on the local list, which is what the
  // header icon is for. Switching lists inside an open panel is left alone.
  useEffect(() => {
    if (hasProjectsTab) setProjectsSub("projects");
  }, [hasProjectsTab]);

  useEffect(() => {
    onProjectsSubChange(projectsSub);
  }, [projectsSub, onProjectsSubChange]);

  // The highlight follows the selected stop, so it is measured rather than assumed: the
  // two labels are very different lengths in English.
  const measureSubPill = useCallback(() => {
    const strip = subStripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>(
      `[data-sub-value="${projectsSub}"]`,
    );
    if (!active) return;
    const next = { left: active.offsetLeft, width: active.offsetWidth };
    setSubPill((previous) =>
      previous && previous.left === next.left && previous.width === next.width
        ? previous
        : next,
    );
    subPillReady.current = true;
  }, [projectsSub]);

  useLayoutEffect(() => {
    measureSubPill();
  }, [measureSubPill]);

  // The labels change width with the language, which changes the group's size without
  // changing the selection, so the highlight is measured again then too.
  useEffect(() => {
    const strip = subStripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(() => measureSubPill());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [measureSubPill]);

  return (
    <div className="relative h-full min-h-0">
      <div
        className={cn(
          LAYER,
          "px-3 pt-2 pb-2",
          !isTerminalTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        {/* Covers the terminal area only, not the full screen: the only moment to hide
            is the command landing in the terminal. The layer carries no colour of its own
            and the panes below hide themselves while it is up, so the middle of the window
            shows the same pane surface as everywhere else (the acrylic, on a glass theme). */}
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          covered={sessionCovered}
          coveredLeaves={coveredLeaves}
          registerHandle={registerTerminalHandle}
          onSearchReady={onSearchReady}
          onCwd={onCwd}
          onExit={onExit}
          onFocusLeaf={onFocusLeaf}
        />
        <SessionOpeningOverlay open={sessionOpening} tool={sessionOpeningTool} />
      </div>
      <div
        className={cn(LAYER, !isEditorTab && "invisible pointer-events-none")}
        aria-hidden={!isEditorTab}
      >
        <EditorStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={onEditorDirtyChange}
          onCloseTab={onEditorCloseTab}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(LAYER, !isPreviewTab && "invisible pointer-events-none")}
        aria-hidden={!isPreviewTab}
      >
        <PreviewStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerPreviewHandle}
          onUrlChange={onPreviewUrlChange}
        />
      </div>
      <div
        className={cn(LAYER, !isMarkdownTab && "invisible pointer-events-none")}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack
          tabs={tabs}
          activeId={activeId}
          onSetMarkdownView={onSetMarkdownView}
        />
      </div>
      <div
        className={cn(LAYER, !isNotesTab && "invisible pointer-events-none")}
        aria-hidden={!isNotesTab}
      >
        <NotesStack tabs={tabs} activeId={activeId} onUpdate={onNotesUpdate} />
      </div>
      <div
        className={cn(
          LAYER,
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} sessionId={activeSessionId} />
      </div>
      <div
        className={cn(
          LAYER,
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={onOpenCommitFile}
          onSearchHandle={onGitHistorySearchHandle}
        />
      </div>
      <div
        className={cn(
          LAYER,
          "flex min-h-0 flex-col",
          !isProjectsTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isProjectsTab}
      >
        <div
          ref={subStripRef}
          className="relative mx-3 mt-1.5 inline-flex w-fit shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-card p-0.5 text-[11px] shadow-sm"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded bg-accent"
            style={
              subPill
                ? {
                    width: subPill.width,
                    transform: `translateX(${subPill.left}px)`,
                    transitionProperty: subPillReady.current
                      ? "transform, width"
                      : "none",
                    transitionDuration: "var(--dur-base)",
                    transitionTimingFunction: "var(--ease-premium)",
                  }
                : { opacity: 0 }
            }
          />
          <SubStop
            value="projects"
            active={projectsSub === "projects"}
            label={t("tabs.new.projects")}
            onSelect={() => setProjectsSub("projects")}
          />
          <SubStop
            value="remotes"
            active={projectsSub === "remotes"}
            label={t("remotes.tabTitle")}
            onSelect={() => setProjectsSub("remotes")}
          />
        </div>
        {/* Both lists stay mounted: the remote list is the one that polls, and its
            badges and any running download must survive a switch. Only the selected one
            is told it is active, so the other stops hitting the network, and only the
            selected one is reachable: the faded one is inert rather than merely dim. */}
        <div className="relative min-h-0 flex-1">
          <div
            className={cn(
              LAYER,
              PANE_INSET,
              "transition-opacity duration-[var(--dur-base)] ease-[var(--ease-premium)]",
              projectsSub !== "projects" && "pointer-events-none opacity-0",
            )}
            aria-hidden={projectsSub !== "projects"}
            inert={projectsSub !== "projects"}
          >
            <ProjectsView
              active={isProjectsTab && projectsSub === "projects"}
              onOpenWorkspace={onOpenProject}
              onOpenTerminal={onOpenProjectTerminal}
              onNewSession={onNewProjectSession}
              onOpenGitGraph={onOpenProjectGitGraph}
            />
          </div>
          <div
            className={cn(
              LAYER,
              PANE_INSET,
              "transition-opacity duration-[var(--dur-base)] ease-[var(--ease-premium)]",
              projectsSub !== "remotes" && "pointer-events-none opacity-0",
            )}
            aria-hidden={projectsSub !== "remotes"}
            inert={projectsSub !== "remotes"}
          >
            <RemoteReposView
              active={isProjectsTab && projectsSub === "remotes"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One stop of the projects panel switch. The look follows the markdown view toggle: a
 * small framed group with the selected stop on an accent fill. The fill is drawn by the
 * sliding pill behind it, so the stop itself only carries the text colour.
 */
function SubStop({
  value,
  active,
  label,
  onSelect,
}: {
  value: ProjectsSub;
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-sub-value={value}
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "relative z-10 rounded px-2 py-0.5 transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
