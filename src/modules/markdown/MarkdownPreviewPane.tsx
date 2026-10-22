import { cn } from "@/lib/utils";
import { useT } from "@/modules/i18n";
import { envForPath } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { MarkdownRender } from "./MarkdownRender";
import { MarkdownViewToggle } from "./MarkdownViewToggle";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
};

export function MarkdownPreviewPane({ path, visible, onSetView }: Props) {
  const t = useT();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: envForPath(path),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          setStatus({ kind: "ready", content: res.content });
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        // Hidden, not just inert: a pane left visible keeps painting its view
        // toggle over whatever is actually on screen.
        !visible && "invisible pointer-events-none",
      )}
      aria-hidden={!visible}
    >
      <MarkdownViewToggle mode="rendered" onChange={onSetView} />
      <div className="flex-1 overflow-auto">
        <div className="markdown-doc px-8 py-6">
          {status.kind === "loading" && (
            <p className="text-[12px] text-muted-foreground">
              {t("markdown.loading")}
            </p>
          )}
          {status.kind === "error" && (
            <p className="text-[12px] text-destructive">
              {t("markdown.readFailed", { error: status.message })}
            </p>
          )}
          {status.kind === "binary" && (
            <p className="text-[12px] text-muted-foreground">
              {t("markdown.binary")}
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="text-[12px] text-muted-foreground">
              {t("markdown.tooLarge", {
                size: status.size,
                limit: status.limit,
              })}
            </p>
          )}
          {status.kind === "ready" && (
            <MarkdownRender content={status.content} path={path} />
          )}
        </div>
      </div>
    </div>
  );
}
