import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import type { ReactNode } from "react";

/**
 * Two modes, source / rendered, plus a third "preview" on the editor side (source with
 * the side-by-side column on the right).
 *
 * All three are mutually exclusive: picking "preview" is not plain source. The
 * side-by-side preview belongs to the editor and is absent in full-page rendering, so
 * only the editor side passes `preview` in; without it just two modes are drawn.
 */
export type MarkdownViewMode = "rendered" | "raw" | "preview";

type Props = {
  /** Current mode; `preview` only appears on the editor side. */
  mode: MarkdownViewMode;
  onChange: (mode: "rendered" | "raw") => void;
  /** Whether to draw the "preview" mode and what selecting it does. Omitted means not drawn. */
  preview?: { onSelect: () => void };
  renderedDisabled?: boolean;
  renderedHint?: string;
  /**
   * Extra controls that belong beside the view switch. A second absolutely
   * positioned group in the same corner would overlap this one, which is what
   * put a button on top of the side preview.
   */
  children?: ReactNode;
};

export function MarkdownViewToggle({
  mode,
  onChange,
  preview,
  renderedDisabled,
  renderedHint,
  children,
}: Props) {
  const t = useT();
  const stopClass = (active: boolean, disabled?: boolean) =>
    cn(
      "rounded px-2 py-0.5 transition-colors",
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
    );
  return (
    <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-card p-0.5 text-[11px] shadow-sm">
      <button
        type="button"
        onClick={() => onChange("rendered")}
        disabled={renderedDisabled}
        title={renderedDisabled ? renderedHint : undefined}
        aria-pressed={mode === "rendered"}
        className={stopClass(mode === "rendered", renderedDisabled)}
      >
        {t("markdown.rendered")}
      </button>
      <button
        type="button"
        onClick={() => onChange("raw")}
        aria-pressed={mode === "raw"}
        className={stopClass(mode === "raw")}
      >
        {t("markdown.raw")}
      </button>
      {preview ? (
        <button
          type="button"
          onClick={preview.onSelect}
          aria-pressed={mode === "preview"}
          className={stopClass(mode === "preview")}
        >
          {t("editor.preview.title")}
        </button>
      ) : null}
      {children}
    </div>
  );
}