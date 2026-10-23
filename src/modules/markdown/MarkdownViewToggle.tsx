import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import type { ReactNode } from "react";

/**
 * 源码 / 渲染 两档，编辑器那一侧再加一档「预览」（源码 + 右边并排那一栏）。
 *
 * 三档都是单选：选了「预览」就不是纯源码。并排预览属于编辑器，整页渲染时它
 * 不在场，所以只有编辑器侧传 `preview` 进来 —— 不传就只画两档。
 */
export type MarkdownViewMode = "rendered" | "raw" | "preview";

type Props = {
  /** 当前档位；`preview` 只在编辑器那一侧出现。 */
  mode: MarkdownViewMode;
  onChange: (mode: "rendered" | "raw") => void;
  /** 画不画「预览」这一档，以及点了它做什么。缺省就不画。 */
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