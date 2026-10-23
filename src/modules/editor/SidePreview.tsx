import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import { MarkdownRender } from "@/modules/markdown/MarkdownRender";
import { useCallback, useEffect, useRef, useState } from "react";

export type SidePreviewKind = "markdown" | "image" | "none";

/**
 * What the side preview can show for a path. Markdown renders, pictures show a
 * thumbnail; everything else has no meaningful side view and gets no panel,
 * rather than an empty box that implies something is missing.
 */
export function sidePreviewKind(path: string): SidePreviewKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].includes(ext)
  ) {
    return "image";
  }
  return "none";
}

/** A span of a document, expressed as fractions so it survives resizing. */
export type ViewportMark = { top: number; height: number };

export type SidePreviewProps = {
  kind: SidePreviewKind;
  /** Current editor text, so the preview follows typing. */
  content: string;
  path: string;
  imageSrc: string | null;
  /** Which part of the editor is on screen, top-down. */
  viewport: ViewportMark | null;
  onToggle: () => void;
  visible: boolean;
};

/**
 * A column beside the editor showing the same document another way.
 *
 * It follows the editor: the markdown is rendered from the live buffer, and the
 * bar on the right shows which part of the document is on screen. Clicking the
 * preview scrolls the editor to that place, which is the one thing a rendered
 * view cannot do by itself.
 */
export function SidePreview({
  kind,
  content,
  path,
  imageSrc,
  viewport,
  onToggle,
  visible,
}: SidePreviewProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ViewportMark | null>(null);

  // Scroll the preview along with the editor, so both show the same place.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || !visible || !viewport) return;
    const target = viewport.top * (box.scrollHeight - box.clientHeight);
    if (Math.abs(box.scrollTop - target) > 4) box.scrollTop = target;
  }, [viewport, visible]);

  const seekWithin = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const box = scrollRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const fraction =
      (event.clientY - rect.top + box.scrollTop) /
      Math.max(1, box.scrollHeight);
    setHover({ top: fraction, height: 0 });
  }, []);

  if (kind === "none") return null;

  return (
    <aside
      aria-hidden={!visible}
      data-side-preview
      data-state={visible ? "open" : "closed"}
      className={cn(
        // No base color of its own: this column sits inside the tab's pane, which
        // provides it. There used to be a hard-coded `bg-background/60` here, invisible
        // on opaque themes but a good deal heavier than the editor next to it on glass
        // themes (the pane tints 0.28 while this added 0.6), making the side preview
        // look like a different app. The left border draws the boundary with the editor.
        "relative flex h-full min-h-0 flex-col overflow-hidden border-l border-border/60",
        // Width, not display: the transition still has something to animate.
        visible ? "w-[min(42%,520px)]" : "w-0",
        !visible && "pointer-events-none border-l-0",
      )}
      style={{ transition: "width var(--dur-base) ease-out" }}
    >
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border/50 pr-1 pl-2">
        <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {t("editor.preview.title")}
        </span>
        <button
          type="button"
          onClick={onToggle}
          title={t("editor.preview.hide")}
          aria-label={t("editor.preview.hide")}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
            <path
              d="M6 3.5 10.5 8 6 12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div
        ref={scrollRef}
        onMouseMove={seekWithin}
        onMouseLeave={() => setHover(null)}
        className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {kind === "image" && imageSrc ? (
          <div className="flex min-h-full items-center justify-center p-2">
            <img
              src={imageSrc}
              alt=""
              className="max-w-full rounded-sm border border-border object-contain"
            />
          </div>
        ) : (
          <div className="px-3 py-2 text-[12px] leading-relaxed">
            <MarkdownRender
              content={content}
              path={path}
              // The buffer is mid-edit by definition, so half-written tables and
              // lists have to be repaired or the preview flickers while typing.
              incomplete
              // Smaller than the full preview: this column is a glance, not a read.
              className="markdown-rendered select-text text-[12px] [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-[13px] [&_img]:max-w-full [&_p]:my-1 [&_table]:text-[11px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        )}
      </div>

      {/* Where the editor is looking, drawn on the preview's own scrollbar. */}
      {viewport && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 w-1 bg-foreground/20"
          style={{
            top: `${viewport.top * 100}%`,
            height: `${Math.max(viewport.height * 100, 1.5)}%`,
          }}
        />
      )}
      {hover && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 w-1 bg-foreground/40"
          style={{ top: `${hover.top * 100}%`, height: "2px" }}
        />
      )}
    </aside>
  );
}
