import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useT } from "@/modules/i18n";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { bringWindowForward } from "@/lib/windowFocus";
import { conflictingNames } from "@/modules/explorer/lib/dropConflict";
import {
  parentDir,
  reportCopyFailures,
  type CopyResult,
} from "@/modules/explorer/lib/clipboardPaste";

type Options = {
  rootPath: string | null;
  /** No webview drag-drop listener while false (explorer not on screen). */
  enabled?: boolean;
  isDir: (path: string) => boolean | undefined;
  onCopied: (destDir: string) => void;
  /**
   * Asked once per drop when the folder already holds some of the names.
   *
   * Resolves with `"replace"`, `"skip"`, or `null` when the question was dismissed - and dismissing
   * means skip, because replacing files the user did not confirm is the one answer that loses data.
   */
  askConflict: (
    names: readonly string[],
  ) => Promise<"replace" | "skip" | null>;
};

// Tauri reports the drop point in physical pixels on some platforms; scale down
// only when it overflows the logical viewport (mirrors the terminal drop).
function dirAt(
  x: number,
  y: number,
  rootPath: string | null,
  isDir: (p: string) => boolean | undefined,
): string | null {
  let lx = x;
  let ly = y;
  if (x > window.innerWidth || y > window.innerHeight) {
    const dpr = window.devicePixelRatio || 1;
    lx = x / dpr;
    ly = y / dpr;
  }
  const el = document.elementFromPoint(lx, ly) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-fs-path]");
  if (row) {
    const p = row.getAttribute("data-fs-path") as string;
    return isDir(p) ? p : parentDir(p, rootPath ?? p);
  }
  if (el.closest("[data-explorer-drop]")) return rootPath;
  return null;
}

// Accepts files dropped from the OS onto an explorer folder (copy, not move),
// via Tauri's native drag-drop. One webview-level listener; ignores drops that
// land outside the explorer (the terminal handles its own).
export function useExplorerFileDrop({
  rootPath,
  enabled = true,
  isDir,
  onCopied,
  askConflict,
}: Options) {
  const t = useT();
  const [targetDir, setTargetDir] = useState<string | null>(null);
  // The drop listener attaches once and must not re-attach on a language
  // change, so the label lookup rides the same ref as the other options.
  const optsRef = useRef({ rootPath, isDir, onCopied, t, askConflict });
  optsRef.current = { rootPath, isDir, onCopied, t, askConflict };

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    /**
     * The drop, with the question asked first when it would replace something.
     *
     * The names that are already there are found before anything is copied, so the user is asked
     * once about the whole gesture and the answer decides what happens to all of it. Skipping needs
     * no work at all: the copy is simply not made.
     */
    const runDrop = async ({
      sources,
      destDir,
      root,
      workspace,
    }: {
      sources: string[];
      destDir: string;
      root: string;
      workspace: ReturnType<typeof currentWorkspaceEnv>;
    }) => {
      const finish = () => {
        if (
          !disposed &&
          optsRef.current.rootPath === root &&
          currentWorkspaceEnv() === workspace
        )
          optsRef.current.onCopied(destDir);
      };
      try {
        const conflicts = await invoke<string[]>("fs_copy_conflicts", {
          sources,
          destDir,
          workspace,
        });
        let replace = false;
        if (conflicts.length > 0) {
          const choice = await optsRef.current.askConflict(
            conflictingNames(conflicts),
          );
          if (choice === null) return; // Dismissed: nothing is replaced.
          if (choice === "skip") {
            // Everything the folder already had stays; the rest is copied without reference to it.
            const keep = new Set(conflicts);
            sources = sources.filter((path) => !keep.has(path));
            if (sources.length === 0) return;
          } else {
            replace = true;
          }
        }
        const result = await invoke<CopyResult>(
          replace ? "fs_copy_replacing" : "fs_copy",
          { sources, destDir, root, workspace },
        );
        reportCopyFailures(result, optsRef.current.t);
      } catch (err) {
        toast.error(
          optsRef.current.t("explorer.copyFailed", { error: String(err) }),
        );
      } finally {
        finish();
      }
    };

    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        const { rootPath, isDir } = optsRef.current;
        if (p.type === "enter" || p.type === "over") {
          setTargetDir(dirAt(p.position.x, p.position.y, rootPath, isDir));
          return;
        }
        if (p.type === "leave") {
          setTargetDir(null);
          return;
        }
        if (p.type === "drop") {
          const dir = dirAt(p.position.x, p.position.y, rootPath, isDir);
          setTargetDir(null);
          if (!rootPath || !dir || p.paths.length === 0) return;
          // The files land on this surface, so the window comes forward - and with it the question
          // about a name that is already there, which a window that is not focused would keep
          // invisible (see `bringWindowForward`).
          bringWindowForward();
          const workspace = currentWorkspaceEnv();
          void runDrop({
            sources: p.paths,
            destDir: dir,
            root: rootPath,
            workspace,
          });
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) =>
        console.error("[verta] explorer drop listen failed:", err),
      );

    return () => {
      disposed = true;
      setTargetDir(null);
      unlisten?.();
    };
  }, [enabled]);

  return { externalTargetDir: targetDir };
}
