import { cn } from "@/lib/utils";
import { useMemo } from "react";

export type SidePreviewKind = "markdown" | "image" | "none";

/**
 * What the side preview can show for a path. Markdown renders, pictures show a
 * thumbnail; everything else has no meaningful side view and gets no panel,
 * rather than an empty box that implies something is missing.
 */
export function sidePreviewKind(path: string): SidePreviewKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].includes(ext)) {
    return "image";
  }
  return "none";
}

/** Line numbers worth marking in the scrollbar: the visible viewport. */
export type ViewportMark = { top: number; height: number };

export type SidePreviewProps = {
  kind: SidePreviewKind;
  /** Rendered markdown, already resolved against the document. */
  rendered: React.ReactNode;
  imageSrc: string | null;
  viewport: ViewportMark | null;
  onSeek: (fraction: number) => void;
  visible: boolean;
};

/**
 * A narrow column beside the editor showing the same document another way,
 * following the cursor through `viewport` and letting a click jump there.
 */
export function SidePreview({
  kind,
  rendered,
  imageSrc,
  viewport,
  onSeek,
  visible,
}: SidePreviewProps) {
  const style = useMemo(
    () => ({ width: visible ? "min(42%, 520px)" : "0px" }),
    [visible],
  );

  if (kind === "none") return null;

  return (
    <aside
      aria-hidden={!visible}
      data-side-preview
      className={cn(
        "relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background/60",
        "transition-[width] duration-[var(--dur-base)]",
        !visible && "pointer-events-none",
      )}
      style={style}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/50 px-2 text-[10px] tracking-wide text-muted-foreground uppercase">
        Preview
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {kind === "image" && imageSrc ? (
          <div className="flex h-full items-center justify-center overflow-auto p-2">
            <img
              src={imageSrc}
              alt=""
              className="max-h-full max-w-full rounded-sm border border-border object-contain"
            />
          </div>
        ) : (
          <div className="h-full overflow-y-auto px-3 py-2 text-[12px] leading-relaxed [&_img]:max-w-full [&_table]:text-[11px]">
            {rendered}
          </div>
        )}

        {viewport && (
          <button
            type="button"
            aria-label="Scroll to the visible part"
            onClick={() => onSeek(viewport.top)}
            className="absolute right-0 w-1.5 cursor-pointer rounded-full bg-foreground/25 transition-colors hover:bg-foreground/45"
            style={{
              top: `${viewport.top * 100}%`,
              height: `${Math.max(viewport.height * 100, 2)}%`,
            }}
          />
        )}
      </div>
    </aside>
  );
}