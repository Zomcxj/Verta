import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Mode = "rendered" | "raw";

type Props = {
  mode: Mode;
  onChange: (mode: Mode) => void;
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
  renderedDisabled,
  renderedHint,
  children,
}: Props) {
  return (
    <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-card p-0.5 text-[11px] shadow-sm">
      <button
        type="button"
        onClick={() => onChange("rendered")}
        disabled={renderedDisabled}
        title={renderedDisabled ? renderedHint : undefined}
        className={cn(
          "rounded px-2 py-0.5 transition-colors",
          mode === "rendered"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
          renderedDisabled &&
            "cursor-not-allowed opacity-40 hover:text-muted-foreground",
        )}
      >
        Rendered
      </button>
      <button
        type="button"
        onClick={() => onChange("raw")}
        className={cn(
          "rounded px-2 py-0.5 transition-colors",
          mode === "raw"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Raw
      </button>
      {children}
    </div>
  );
}
