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

/** 草稿写盘的防抖时间：打字停下来这么久才镜像一次。 */
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
  /** 中断前留下的草稿；有它在编辑器顶上出一条恢复条。 */
  const [pendingDraft, setPendingDraft] = useState<Draft | null>(null);

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

  /** 草稿的写盘计时器；与自动保存各自独立，因为它的作用是「别丢东西」。 */
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 把当前缓冲区镜像成草稿。
   *
   * 只在真有改动时写：没改动的内容磁盘上本来就有，写一份只会多留垃圾。
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

  // 关标签就是卸载、关窗口会走 beforeunload：这两种「中断」都别再等防抖。
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
    // 内容已经进文件了，草稿再留着只会在下次打开时误报。
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
        toast.warning("File changed on disk", {
          id: `save-conflict:${path}`,
          description: `${name} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
          action: { label: "Overwrite", onClick: () => void writeToDisk() },
        });
        return false;
      }
    }
    await writeToDisk();
    return true;
  }, [path, writeToDisk]);

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

  // 读磁盘成功之后再看有没有中断前的草稿：只有文本文件才有草稿可提。
  const checkDraft = useCallback(
    (res: ReadResult) => {
      if (res.kind !== "text") return;
      void readDraft(path)
        .then((draft) => {
          setPendingDraft(
            draftOffersRecovery(draft, savedRef.current) ? draft : null,
          );
        })
        // 草稿读不到（存档坏了/权限）不该拖累打开文件本身。
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

  /** 把草稿放回缓冲区：它就是「未保存的改动」，保存与否由用户决定。 */
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

  /** 不要这份草稿：删掉它，磁盘那份不动。 */
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

      // 草稿与自动保存是否打开无关：自动保存默认是关的，这里才是那份安全网。
      // 打字时不断重置，停下来才写一次，免得每敲一下就过一次 IPC。
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
