import { useT } from "@/modules/i18n";
import { notifyDocumentSaved } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { envForPath } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { detectEol, type Eol, normalizeToLf, restoreEol } from "./eol";
import {
  dropDraft,
  draftOffersRecovery,
  MAX_DRAFT_BYTES,
  readDraft,
  storeDraft,
  type Draft,
} from "./drafts";

type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type FileStat = { size: number; mtime: number; kind: string };

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
export const FORCE_READ_LIMIT = 50 * 1024 * 1024;

/** Debounce for the draft write: mirror the buffer once typing pauses this long. */
const DRAFT_FLUSH_MS = 1500;

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

export function useDocument({ path, onDirtyChange }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  /** Draft left by an interrupted session; when present the editor shows a restore bar. */
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);

  const t = useT();

  const autoSave = usePreferencesStore((s) => s.editorAutoSave);
  const autoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const eolRef = useRef<Eol>("\n");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const autoSaveRef = useRef({ autoSave, autoSaveDelay });
  autoSaveRef.current = { autoSave, autoSaveDelay };

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Draft-flush timer, kept separate from auto-save because its job is "do not lose
   * things". */
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Mirror the current buffer into a draft.
   *
   * Only write when there are real changes: unchanged content already exists on
   * disk, and a copy would just be garbage.
   */
  const flushDraft = useCallback(() => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const text = bufferRef.current;
    if (text === savedRef.current || text.length === 0) return;
    if (text.length > MAX_DRAFT_BYTES) return;
    void storeDraft(path, text).catch((e) => console.error("[draft]", e));
  }, [path]);

  const flushDraftRef = useRef(flushDraft);
  flushDraftRef.current = flushDraft;

  // Closing a tab unmounts, closing the window fires beforeunload: neither
  // interruption should wait for the debounce.
  useEffect(() => {
    const flush = () => flushDraftRef.current();
    window.addEventListener("beforeunload", flush);
    window.addEventListener("blur", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("blur", flush);
      flushDraftRef.current();
    };
  }, []);

  const clearAutoSaveTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const diskMtimeRef = useRef<number | null>(null);

  const writeToDisk = useCallback(async () => {
    const content = bufferRef.current;
    const mtime = await invoke<number>("fs_write_file", {
      path,
      content: restoreEol(content, eolRef.current),
      workspace: envForPath(path),
      source: "editor",
    });
    diskMtimeRef.current = mtime;
    savedRef.current = content;
    // Edits typed while the write was in flight must stay dirty.
    setDirty(bufferRef.current !== content);
    notifyDocumentSaved(path);
    // The content is in the file now, so a leftover draft would only raise a false
    // alarm next time the file is opened.
    if (bufferRef.current === content) void dropDraft(path).catch(() => {});
  }, [path]);

  // False when the write was withheld because the file changed on disk
  // since load; overwriting is an explicit user action from the toast.
  const saveNow = useCallback(async (): Promise<boolean> => {
    const known = diskMtimeRef.current;
    if (known !== null) {
      const stat = await invoke<FileStat>("fs_stat", {
        path,
        workspace: envForPath(path),
      }).catch(() => null);
      if (stat && stat.mtime !== known) {
        const name = path.split(/[\\/]/).pop() ?? path;
        toast.warning(t("editor.saveConflict.title"), {
          id: `save-conflict:${path}`,
          description: t("editor.saveConflict.body", { name }),
          action: {
            label: t("editor.saveConflict.overwrite"),
            onClick: () => void writeToDisk(),
          },
        });
        return false;
      }
    }
    await writeToDisk();
    return true;
  }, [path, writeToDisk, t]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  const forceRef = useRef(false);

  // Adopts a read result as the new saved baseline. `skipIfUnchanged` avoids
  // the re-render when disk already matches the buffer (self-save / duplicate
  // watcher event); initial loads must always publish a state.
  const adoptRead = useCallback((res: ReadResult, skipIfUnchanged = false) => {
    if (res.kind === "text") {
      eolRef.current = detectEol(res.content);
      diskMtimeRef.current = res.mtime;
      const content = normalizeToLf(res.content);
      if (skipIfUnchanged && content === savedRef.current) return;
      savedRef.current = content;
      bufferRef.current = content;
      setDirty(false);
      setDoc({ status: "ready", content, size: res.size });
    } else if (res.kind === "binary") {
      setDoc({ status: "binary", size: res.size });
    } else if (res.kind === "toolarge") {
      setDoc({ status: "toolarge", size: res.size, limit: res.limit });
    }
  }, []);

  const readFromDisk = useCallback(
    (force: boolean) =>
      invoke<ReadResult>("fs_read_file", {
        path,
        workspace: envForPath(path),
        force,
      }),
    [path],
  );

  // Look for a draft from an interrupted session only after a successful disk read;
  // only text files can offer one.
  const checkDraft = useCallback(
    (res: ReadResult) => {
      if (res.kind !== "text") return;
      void readDraft(path)
        .then((draft) => {
          setPendingDraft(
            draftOffersRecovery(draft, savedRef.current) ? draft : null,
          );
        })
        // An unreadable draft (corrupt store / permissions) must not block opening
        // the file itself.
        .catch(() => setPendingDraft(null));
    },
    [path],
  );

  // Load on path change.
  useEffect(() => {
    let cancelled = false;
    // "Open anyway" is a per-file decision; a new path starts unforced.
    forceRef.current = false;
    setDoc({ status: "loading" });
    setDirty(false);
    setPendingDraft(null);

    readFromDisk(forceRef.current)
      .then((res) => {
        if (cancelled) return;
        adoptRead(res);
        checkDraft(res);
      })
      .catch((e) => {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [readFromDisk, adoptRead, checkDraft]);

  const openAnyway = useCallback(() => {
    forceRef.current = true;
    setDoc({ status: "loading" });
    readFromDisk(true)
      .then((res) => {
        adoptRead(res);
        checkDraft(res);
      })
      .catch((e) => setDoc({ status: "error", message: String(e) }));
  }, [readFromDisk, adoptRead, checkDraft]);

  /** Put the draft back into the buffer: it is simply "unsaved changes", and saving
   * is up to the user. */
  const restoreDraft = useCallback(() => {
    if (!pendingDraft) return;
    const text = pendingDraft.text;
    bufferRef.current = text;
    setDirty(text !== savedRef.current);
    setDoc((prev) =>
      prev.status === "ready" ? { ...prev, content: text } : prev,
    );
    setPendingDraft(null);
  }, [pendingDraft]);

  /** Decline the draft: delete it and leave the on-disk copy alone. */
  const discardDraft = useCallback(() => {
    setPendingDraft(null);
    void dropDraft(path).catch(() => {});
  }, [path]);

  // Skipped while dirty: never clobber unsaved edits. Re-checked when the
  // read resolves, since typing can start while it is in flight.
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    void readFromDisk(forceRef.current)
      .then((res) => {
        if (!dirtyRef.current) adoptRead(res, true);
      })
      // Transient failures (e.g. ENOENT mid atomic-rename) must not replace
      // a healthy buffer with an error screen.
      .catch((e) => console.warn("[editor] reload failed", path, e));
    return true;
  }, [readFromDisk, adoptRead, path]);

  const save = useCallback(async (): Promise<boolean> => {
    clearAutoSaveTimer();
    if (bufferRef.current === savedRef.current) return true;
    return saveNow();
  }, [clearAutoSaveTimer, saveNow]);

  // Adopt externally formatted disk content as the saved baseline before the
  // matching editor dispatch lands, so the buffer never flashes dirty. The
  // formatter's own write must also become the known mtime, or the next save
  // would report it as an external conflict.
  // Returns the LF-normalized text the caller should dispatch.
  const adoptDiskText = useCallback(
    (diskText: string, mtime: number): string => {
      eolRef.current = detectEol(diskText);
      diskMtimeRef.current = mtime;
      const content = normalizeToLf(diskText);
      savedRef.current = content;
      setDirty(bufferRef.current !== content);
      return content;
    },
    [],
  );

  const onChange = useCallback(
    (next: string) => {
      bufferRef.current = next;
      const isDirty = next !== savedRef.current;
      setDirty(isDirty);

      clearAutoSaveTimer();

      const { autoSave: active, autoSaveDelay: delay } = autoSaveRef.current;
      if (active && isDirty) {
        timeoutRef.current = setTimeout(() => {
          saveNow().catch((e) => console.error("[autosave]", e));
        }, delay);
      }

      // Drafts do not depend on auto-save being on: auto-save defaults to off, so this
      // is the safety net. The timer resets while typing and fires once it pauses, so
      // not every keystroke crosses IPC.
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      if (isDirty && next.length > 0 && next.length <= MAX_DRAFT_BYTES) {
        const forPath = path;
        const text = next;
        draftTimerRef.current = setTimeout(() => {
          draftTimerRef.current = null;
          void storeDraft(forPath, text).catch((e) => console.error("[draft]", e));
        }, DRAFT_FLUSH_MS);
      }
    },
    [clearAutoSaveTimer, saveNow, path],
  );

  useEffect(() => clearAutoSaveTimer, [path, clearAutoSaveTimer]);

  return {
    doc,
    dirty,
    onChange,
    save,
    reload,
    adoptDiskText,
    openAnyway,
    pendingDraft,
    restoreDraft,
    discardDraft,
  };
}
