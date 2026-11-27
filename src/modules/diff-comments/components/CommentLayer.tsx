import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { copyToClipboard } from "@/lib/clipboard";
import { useT } from "@/modules/i18n";
import type { Tab } from "@/modules/tabs";
import { writeToSession } from "@/modules/terminal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type DiffComment, loadComments, saveComments } from "../lib/comments";
import { formatComments, resolveLeafForSession } from "../lib/send";

/**
 * The review notes for one file, and the box that adds another.
 *
 * Notes are stored per session, not per file, so the list is loaded once per session and
 * filtered to this file and this diff here. A note belongs to the line the reader had
 * selected when they wrote it: the layer does not try to guess a line from the caret's
 * position after the fact.
 *
 * Every write is optimistic and rolls back on failure, because the note the reader just
 * typed is the one thing that must not be lost.
 */
export function CommentLayer({
  sessionId,
  filePath,
  scope,
  selectedLine,
  tabs,
}: {
  /** The session the notes are for; null when no session is open. */
  sessionId: string | null;
  filePath: string;
  /** `"unstaged" | "staged" | "branch"`; a note belongs to the diff it was read from. */
  scope: string;
  /** The line the reader has selected, or null when nothing is selected. */
  selectedLine: number | null;
  /** The open tabs, so the send button can find the session's own terminal. */
  tabs: readonly Tab[];
}) {
  const t = useT();
  const [all, setAll] = useState<DiffComment[]>([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Set once this layer has written. The first read can land after a note has already
   * been added (the reader types while the file is still loading); taking that read
   * would overwrite the note in memory and the next write would drop it from disk.
   */
  const wroteRef = useRef(false);

  useEffect(() => {
    wroteRef.current = false;
    if (sessionId === null) {
      setAll([]);
      return;
    }
    let cancelled = false;
    loadComments(sessionId)
      .then((list) => {
        if (!cancelled && !wroteRef.current) setAll(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const mine = useMemo(
    () => all.filter((c) => c.filePath === filePath && c.scope === scope),
    [all, filePath, scope],
  );
  const hasUnsent = mine.some((c) => c.sentAt === null);
  /**
   * Which session the notes go to, by name. The panel is drawn under a diff, and a diff
   * does not carry a session, so the target is the active one; showing its name is what
   * lets the reader notice it is not the agent they meant before sending.
   */
  const targetName = useMemo(() => {
    if (sessionId === null) return null;
    const tab = tabs.find(
      (candidate) =>
        candidate.kind === "terminal" && candidate.sessionId === sessionId,
    );
    return tab?.kind === "terminal" ? tab.title : sessionId.slice(0, 8);
  }, [tabs, sessionId]);

  /**
   * Write `next`, showing it at once and putting `rollback` back if the write fails.
   * Returns whether it was written, so a caller can restore what it cleared.
   */
  const commit = useCallback(
    async (next: DiffComment[], rollback: DiffComment[]): Promise<boolean> => {
      if (sessionId === null) return false;
      setAll(next);
      setBusy(true);
      setError(null);
      try {
        await saveComments(sessionId, next);
        wroteRef.current = true;
        return true;
      } catch (e) {
        setAll(rollback);
        setError(String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  const add = useCallback(() => {
    if (sessionId === null || selectedLine === null) return;
    const text = body.trim();
    if (text === "") return;
    const comment: DiffComment = {
      id: crypto.randomUUID(),
      sessionId,
      filePath,
      startLine: null,
      lineNumber: selectedLine,
      body: text,
      scope,
      sentAt: null,
    };
    const next = [...all, comment];
    setBody("");
    void commit(next, all).then((ok) => {
      if (!ok) setBody(text);
    });
  }, [all, body, commit, filePath, scope, selectedLine, sessionId]);

  const remove = useCallback(
    (id: string) => {
      void commit(
        all.filter((c) => c.id !== id),
        all,
      );
    },
    [all, commit],
  );

  /** The session's own terminal, if Verta opened one; otherwise the notes are copied. */
  const leaf = useMemo(
    () => (sessionId === null ? null : resolveLeafForSession(tabs, sessionId)),
    [tabs, sessionId],
  );

  const send = useCallback(async () => {
    if (sessionId === null) return;
    // Only notes that have not gone yet: pressing Send twice must not write the same
    // notes into the terminal again, and an already-sent note keeps its original time.
    const unsent = mine.filter((c) => c.sentAt === null);
    const text = formatComments(unsent);
    if (text === "") return;
    if (leaf === null) {
      await copyToClipboard(text);
      toast.info(t("diffComments.notInTerminal"));
      return;
    }
    // No trailing newline: the terminal must not submit it, so the reader sees what was
    // written and presses Enter themselves.
    if (!writeToSession(leaf, text)) {
      setError(t("diffComments.writeFailed"));
      return;
    }
    const now = Date.now();
    await commit(
      all.map((c) =>
        c.filePath === filePath && c.scope === scope && c.sentAt === null
          ? { ...c, sentAt: now }
          : c,
      ),
      all,
    );
  }, [all, commit, filePath, leaf, mine, scope, sessionId, t]);

  if (sessionId === null) {
    return (
      <div className="shrink-0 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        {t("diffComments.noSession")}
      </div>
    );
  }

  return (
    <div className="flex max-h-56 shrink-0 flex-col border-t border-border/60">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">
          {t("diffComments.title")}
          {targetName !== null
            ? ` · ${t("diffComments.target", { name: targetName })}`
            : null}
        </span>
        <span className="shrink-0 tabular-nums">{mine.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3">
        {mine.length === 0 ? (
          <p className="py-2 text-[11px] text-muted-foreground">
            {t("diffComments.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5 py-1">
            {mine.map((comment) => (
              <li
                key={comment.id}
                className="flex items-start gap-2 text-[11.5px]"
              >
                <span className="shrink-0 font-mono text-muted-foreground">
                  {comment.lineNumber}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {comment.body}
                </span>
                {comment.sentAt !== null ? (
                  <span className="shrink-0 text-[10px] text-emerald-600 dark:text-emerald-400">
                    {t("diffComments.sent")}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => remove(comment.id)}
                  disabled={busy}
                  className="shrink-0 text-muted-foreground transition-colors duration-[var(--dur-base)] hover:text-destructive disabled:opacity-50"
                  aria-label={t("diffComments.remove")}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <Input
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) add();
          }}
          placeholder={
            selectedLine === null
              ? t("diffComments.pickLine")
              : t("diffComments.placeholder", { line: selectedLine })
          }
          disabled={busy || selectedLine === null}
          spellCheck={false}
          className="h-8 text-[12px]"
        />
        <Button
          size="sm"
          onClick={add}
          disabled={busy || selectedLine === null || body.trim() === ""}
        >
          {t("diffComments.add")}
        </Button>
      </div>
      <div className="flex items-center justify-end px-3 pb-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void send()}
          disabled={busy || !hasUnsent}
        >
          {leaf === null ? t("diffComments.copy") : t("diffComments.send")}
        </Button>
      </div>
      {error !== null ? (
        <p className="px-3 pb-2 text-[11px] text-destructive">{error}</p>
      ) : null}
    </div>
  );
}
