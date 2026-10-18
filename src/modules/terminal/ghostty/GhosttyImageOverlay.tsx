import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "@/modules/i18n";
import {
  findImageReferences,
  nameRanks,
  type ImageReference,
  type ScreenRow,
} from "@/modules/terminal/ghostty/terminalImages";
import {
  ghosttyCellSize,
  ghosttyCwdForLeaf,
  ghosttyModelForLeaf,
  subscribeGhosttyFrame,
} from "@/modules/terminal/ghostty/useGhosttyTerminalSession";

/**
 * Draws the pictures a message attached, in the space the agent reserved for
 * them.
 *
 * The agent cannot hand over pixels itself, so it prints a filename and leaves
 * a mosaic above it. This replaces that stand-in with the real image, read back
 * out of the session database where the attachment was stored. Positions come
 * from the terminal grid, so the picture scrolls and resizes with the text
 * around it.
 */

interface Placed {
  readonly key: string;
  readonly url: string;
  readonly left: number;
  readonly top: number;
  /** Height of the reserved area; the width follows the picture's own shape. */
  readonly height: number;
  /** Room to the right of the reserved area, which the picture may use. */
  readonly available: number;
}

/**
 * Resolved lookups, and the ones already in flight, keyed by filename. A name is
 * stable and its bytes do not change once stored, so a hit is worth keeping for
 * the life of the window; the same attachment is drawn again on every scroll
 * back to it.
 */
const resolved = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();
/** When each name last came back empty, and how often it has been asked. */
const misses = new Map<string, { at: number; attempts: number }>();

/**
 * A name that is not in the database yet may still be about to arrive: the
 * terminal can draw the filename from a message that has not been written out.
 * Treating the first empty answer as final would leave the agent's own stand-in
 * on screen for good, so a miss is re-asked a couple of times before it is
 * believed.
 */
const MISS_TTL_MS = 2500;
const MAX_ATTEMPTS = 3;

function lookupImage(
  name: string,
  directory: string | null,
  skip: number,
): Promise<string | null> {
  const key = `${skip}|${name}`;
  const cached = resolved.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const missed = misses.get(key);
  if (missed) {
    if (missed.attempts >= MAX_ATTEMPTS || Date.now() - missed.at < MISS_TTL_MS) {
      return Promise.resolve(null);
    }
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = invoke<string | null>("agent_sessions_image", { name, directory, skip })
    .then((url) => {
      if (url) {
        resolved.set(key, url);
        misses.delete(key);
      } else {
        misses.set(key, { at: Date.now(), attempts: (missed?.attempts ?? 0) + 1 });
      }
      return url;
    })
    .catch(() => {
      misses.set(key, { at: Date.now(), attempts: (missed?.attempts ?? 0) + 1 });
      return null;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

export default function GhosttyImageOverlay({ leafId }: { leafId: number }) {
  const t = useT();
  const [placed, setPlaced] = useState<readonly Placed[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  /** What the last scan saw, so an idle repaint costs nothing. */
  const scanKey = useRef("");
  const signature = useRef("");
  const retry = useRef<number | null>(null);

  const update = useCallback(() => {
    if (retry.current !== null) {
      window.clearTimeout(retry.current);
      retry.current = null;
    }
    const model = ghosttyModelForLeaf(leafId);
    const cell = ghosttyCellSize(leafId);
    if (!model || !cell) return;
    const origin = model.viewportOriginLine();
    // Reading every row costs too much to redo on each repaint, and a repaint
    // that changed neither contents nor scroll cannot have moved a picture.
    const gate = `${model.revision()}|${origin}|${model.rows}|${model.cols}|${cell.width}x${cell.height}`;
    if (gate === scanKey.current) return;
    scanKey.current = gate;

    const rows: ScreenRow[] = [];
    for (let offset = 0; offset < model.rows; offset += 1) {
      const line = model.bufferLineAtViewportRow(offset);
      const cells = model.readCellLine?.(line);
      if (cells) rows.push({ line, cells });
    }
    const references = findImageReferences(rows);
    const key = [
      origin,
      cell.width,
      cell.height,
      ...references.map(
        (reference) =>
          `${reference.name}@${reference.topLine}-${reference.bottomLine}:${reference.leftColumn}-${reference.rightColumn}`,
      ),
    ].join("|");
    if (key === signature.current) return;
    signature.current = key;
    if (references.length === 0) {
      setPlaced((current) => (current.length > 0 ? [] : current));
      return;
    }

    const directory = ghosttyCwdForLeaf(leafId);
    // The newest attachment of a repeated name is the one lowest on the screen:
    // images pasted from the clipboard are all called `clipboard`, so the name
    // alone does not say which one a row is showing.
    const ranks = nameRanks(references);
    void Promise.all(
      references.map((reference, index) =>
        lookupImage(reference.name, directory, ranks[index]),
      ),
    ).then((urls) => {
      // The screen moved on while the reads were in flight; a later scan owns
      // the result now.
      if (signature.current !== key) return;
      setPlaced(
        references
          .map((reference, index) => place(reference, urls[index], origin, cell, model.cols))
          .filter((entry): entry is Placed => entry !== null),
      );
      if (urls.some((url) => !url)) {
        // A name may still be on its way into the database. Look again once
        // another ask is allowed, clearing both gates so the work really runs.
        retry.current = window.setTimeout(() => {
          scanKey.current = "";
          signature.current = "";
          retry.current = null;
          update();
        }, MISS_TTL_MS);
      }
    });
  }, [leafId]);

  useEffect(() => {
    update();
    const unsubscribe = subscribeGhosttyFrame(leafId, update);
    return () => {
      unsubscribe();
      if (retry.current !== null) window.clearTimeout(retry.current);
      retry.current = null;
    };
  }, [leafId, update]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      {placed.map((entry) => (
        <button
          key={entry.key}
          type="button"
          aria-label={t("term.openImage")}
          title={t("term.openImage")}
          className="pointer-events-auto absolute cursor-zoom-in border-0 bg-transparent p-0"
          style={{
            left: entry.left,
            top: entry.top,
            height: entry.height,
          }}
          onClick={() => setPreview(entry.url)}
        >
          <img
            src={entry.url}
            alt=""
            draggable={false}
            className="block h-full object-contain object-left"
            style={{ maxWidth: entry.available, width: "auto" }}
          />
        </button>
      ))}
      {preview && (
        <button
          type="button"
          aria-label={t("term.closeImage")}
          className="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center border-0 bg-black/75 p-4"
          onClick={() => setPreview(null)}
        >
          <img
            src={preview}
            alt={t("term.imagePreview")}
            draggable={false}
            className="max-h-full max-w-full object-contain"
          />
        </button>
      )}
    </div>
  );
}

function place(
  reference: ImageReference,
  url: string | null | undefined,
  origin: number,
  cell: { width: number; height: number },
  columns: number,
): Placed | null {
  if (!url) return null;
  return {
    key: `${reference.name}:${reference.topLine}`,
    url,
    left: reference.leftColumn * cell.width,
    top: (reference.topLine - origin) * cell.height,
    height: (reference.bottomLine - reference.topLine + 1) * cell.height,
    available: Math.max(
      (reference.rightColumn - reference.leftColumn + 1) * cell.width,
      (columns - reference.leftColumn) * cell.width,
    ),
  };
}