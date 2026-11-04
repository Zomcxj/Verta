import { useCallback, useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  NoteAddIcon,
  NoteIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor/EditorPane";
import { MarkdownPreviewPane } from "@/modules/markdown/MarkdownPreviewPane";
import { MarkdownViewToggle } from "@/modules/markdown";
import { envForPath } from "@/modules/workspace";
import type { NotesTab, TabPatch } from "@/modules/tabs";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { registerNotesSaver, unregisterNotesSaver } from "./notesSave";

type NoteRow = { path: string; name: string; mtime: number };

type Props = {
  tab: NotesTab;
  /** The tab is the active one; hidden layers keep their editor mounted but skip work. */
  visible: boolean;
  onChange: (patch: TabPatch) => void;
};

const joinPath = (dir: string, name: string) =>
  `${dir.replace(/[\\/]+$/, "")}/${name}`;

const parentPath = (path: string) =>
  path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));

/** `note-261104-154307.md` - a new note is named for the second it is made. */
function defaultNoteName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `note-${String(now.getFullYear()).slice(2)}${day}-${time}.md`;
}

/**
 * One notes tab: the list of markdown files in the app's own `notes\` folder on the
 * left, one of them on the right.
 *
 * The notes are ordinary files, so the right side is the ordinary editor and the folder
 * is read with the ordinary fs commands - what this view adds is the folder itself (the
 * executable's side, which the webview cannot see), the list, and the writes a notes tab
 * owes: switching notes, leaving the tab and closing it all save first, because auto-save
 * stays off for editors and a notes tab has no dirty prompt of its own.
 *
 * The right side behaves exactly as a markdown file does in an editor tab: the same three
 * stops at the top right - rendered (the full-page render), source (the editor) and
 * preview (source with the rendered column beside it) - because that is the switch people
 * already know from `.md` files.
 */
export function NotesView({ tab, visible, onChange }: Props) {
  const t = useT();
  const listId = useId();
  const [rows, setRows] = useState<NoteRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"raw" | "rendered">("raw");
  /** The path a renamed note had, so its editor keeps the buffer instead of reloading. */
  const [renamedFrom, setRenamedFrom] = useState<string | null>(null);
  const editorRef = useRef<EditorPaneHandle | null>(null);
  /** The row's name field, focused as it appears (the row was clicked on purpose). */
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const activePathRef = useRef(tab.activePath);
  activePathRef.current = tab.activePath;

  useEffect(() => {
    if (renaming === null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  const refresh = useCallback(async (): Promise<NoteRow[]> => {
    // `notes_dir` creates the folder when it is missing and authorizes it, which is
    // the grant every other fs call here needs.
    const dir = await native.notesDir();
    const entries = await native.readDir(dir);
    const list = entries
      .filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name))
      .map((entry) => ({
        path: joinPath(dir, entry.name),
        name: entry.name,
        mtime: entry.mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    setRows(list);
    setError(null);
    // The folder moves with the executable: a tab restored from another install
    // adopts this one rather than reading a directory that is no longer there.
    if (dir !== tab.root) onChange({ root: dir });
    return list;
  }, [onChange, tab.root]);

  useEffect(() => {
    if (!visible) return;
    void refresh().catch(() => {});
  }, [visible, refresh]);

  // Closing the tab writes the note first; the app asks this view through the registry
  // because the editor's handle lives here.
  useEffect(() => {
    registerNotesSaver(tab.id, () =>
      editorRef.current?.save() ?? Promise.resolve(),
    );
    return () => unregisterNotesSaver(tab.id);
  }, [tab.id]);

  // Leaving the tab writes the note the same way.
  useEffect(() => {
    if (visible) return;
    void (editorRef.current?.save() ?? Promise.resolve()).catch(() => {});
  }, [visible]);

  const pick = useCallback(
    async (path: string) => {
      if (path === activePathRef.current) return;
      try {
        await editorRef.current?.save();
      } catch {
        return; // stay on the note that would not write
      }
      onChange({ activePath: path });
    },
    [onChange],
  );

  const create = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const dir = await native.notesDir();
      const taken = new Set(rows.map((row) => row.name.toLowerCase()));
      const base = defaultNoteName();
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i += 1) {
        name = base.replace(/\.md$/i, `-${i}.md`);
      }
      const path = joinPath(dir, name);
      await native.createFile(path);
      await refresh();
      onChange({ activePath: path });
    } catch (error) {
      toast.error(t("notes.createFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }, [busy, rows, refresh, onChange, t]);

  const remove = useCallback(
    async (path: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await invoke("fs_delete", { path, workspace: envForPath(path) });
        const list = await refresh();
        // The deleted note's slot goes to the newest one left, or to the placeholder.
        if (activePathRef.current === path) {
          onChange({ activePath: list[0]?.path ?? null });
        }
        setConfirmPath(null);
      } catch (error) {
        toast.error(t("notes.deleteFailed", { error: String(error) }));
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, onChange, t],
  );

  const commitRename = useCallback(
    async (row: NoteRow, value: string) => {
      setRenaming(null);
      const trimmed = value.trim();
      if (trimmed === "" || trimmed === row.name) return;
      const name = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
      if (name === row.name) return;
      const to = `${parentPath(row.path)}/${name}`;
      setBusy(true);
      try {
        await invoke("fs_rename", {
          from: row.path,
          to,
          workspace: envForPath(row.path),
        });
        if (activePathRef.current === row.path) {
          // Same document at a new name: the editor carries its buffer over rather than
          // reloading, which is what the explorer's rename does for an editor tab.
          setRenamedFrom(row.path);
          onChange({ activePath: to });
        }
        await refresh();
      } catch (error) {
        toast.error(t("notes.renameFailed", { error: String(error) }));
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChange, t],
  );

  /**
   * "Rendered" leaves source, so the note is written first: the full-page render reads the
   * file from disk, and the editor unmounts. Dirty is what the switch's "rendered" stop is
   * disabled by, exactly as it is for a markdown file in an editor tab.
   */
  const showRendered = useCallback(async () => {
    try {
      await editorRef.current?.save();
    } catch {
      return;
    }
    onChange({ dirty: false });
    setView("rendered");
  }, [onChange]);

  const rowActions = (row: NoteRow) => (
    <>
      <button
        type="button"
        aria-label={t("notes.rename")}
        title={t("notes.rename")}
        className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
        onClick={() => setRenaming(row.path)}
      >
        <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={t("notes.delete")}
        title={t("notes.delete")}
        className="rounded-sm p-1 text-muted-foreground hover:text-foreground"
        onClick={() => setConfirmPath(row.path)}
      >
        <HugeiconsIcon icon={Delete02Icon} size={13} strokeWidth={1.75} />
      </button>
    </>
  );

  return (
    <div className="flex h-full min-h-0">
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel
          defaultSize="26%"
          minSize="16%"
          className="flex h-full min-h-0 flex-col border-r border-border/60"
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("notes.list")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[11px]"
              disabled={busy}
              onClick={() => void create()}
            >
              <HugeiconsIcon icon={NoteAddIcon} size={13} strokeWidth={1.75} />
              {t("notes.new")}
            </Button>
          </div>
          <div
            id={`${listId}-list`}
            className="min-h-0 flex-1 overflow-y-auto px-1 pb-1"
          >
            {error !== null ? (
              <p className="px-2 py-3 text-[11px] leading-relaxed text-destructive">
                {t("notes.listFailed", { error })}
              </p>
            ) : rows.length === 0 ? (
              <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
                {t("notes.empty")}
              </p>
            ) : (
              rows.map((row) => (
                <div key={row.path} className="group relative">
                  {renaming === row.path ? (
                    <input
                      ref={renameInputRef}
                      defaultValue={row.name}
                      aria-label={t("notes.rename")}
                      className="h-7 w-full rounded-sm border border-border/60 bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitRename(row, event.currentTarget.value);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setRenaming(null);
                        }
                      }}
                      onBlur={() => setRenaming(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void pick(row.path)}
                      onDoubleClick={() => setRenaming(row.path)}
                      className={cn(
                        "flex h-7 w-full items-center gap-1.5 rounded-sm px-2 text-left text-[12px]",
                        row.path === tab.activePath
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <HugeiconsIcon
                        icon={NoteIcon}
                        size={13}
                        strokeWidth={1.75}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    </button>
                  )}
                  {renaming !== row.path && confirmPath !== row.path ? (
                    <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center rounded-sm bg-background/90 opacity-0 transition-opacity group-hover:opacity-100">
                      {rowActions(row)}
                    </div>
                  ) : null}
                  {confirmPath === row.path ? (
                    <div className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 rounded-md border border-border/60 bg-popover px-1.5 py-1 shadow-md">
                      <span className="text-[10.5px] text-muted-foreground">
                        {t("notes.confirmDelete")}
                      </span>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-5 rounded px-1.5 text-[10.5px]"
                        disabled={busy}
                        onClick={() => void remove(row.path)}
                      >
                        {t("notes.delete")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 rounded px-1.5 text-[10.5px]"
                        disabled={busy}
                        onClick={() => setConfirmPath(null)}
                      >
                        {t("notes.cancel")}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel className="flex h-full min-h-0 flex-col">
          {tab.activePath === null ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
              {t("notes.emptyRight")}
            </div>
          ) : view === "rendered" ? (
            <MarkdownPreviewPane
              path={tab.activePath}
              visible={visible}
              onSetView={(mode) => setView(mode)}
            />
          ) : (
            <EditorPane
              ref={editorRef}
              path={tab.activePath}
              renamedFrom={renamedFrom}
              onDirtyChange={(dirty) => onChange({ dirty })}
              onSaved={() => onChange({ dirty: false })}
              // The same three stops a markdown file gets in an editor tab: rendered leaves
              // source (see `showRendered`), preview is the side column the pane draws, and
              // source is what this is.
              renderToggle={(side) => (
                <MarkdownViewToggle
                  mode={side.open ? "preview" : "raw"}
                  preview={{
                    onSelect: () => {
                      side.setOpen(true);
                    },
                  }}
                  onChange={(mode) => {
                    side.setOpen(false);
                    if (mode === "rendered") {
                      void showRendered();
                      return;
                    }
                    setView("raw");
                  }}
                  renderedDisabled={tab.dirty === true}
                  renderedHint={t("markdown.saveToPreview")}
                />
              )}
            />
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
