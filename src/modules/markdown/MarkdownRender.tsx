import { MarkdownCode } from "@/components/markdown-code";
import { type ComponentProps, useMemo } from "react";
import { Streamdown } from "streamdown";
import { MarkdownImage } from "./MarkdownImage";
import { MarkdownLink } from "./MarkdownLink";

/** The directory a relative image reference resolves against. */
export function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
}

type Props = {
  /** Markdown source, already in hand: no reading happens here. */
  content: string;
  /** File the source belongs to, so relative images resolve beside it. */
  path: string;
  /** Applied to the outermost wrapper, for the caller's own spacing. */
  className?: string;
  /**
   * Repair half-written markdown before rendering. A saved file never needs it;
   * a live editor buffer does, or a table being typed flickers as its rows come
   * and go.
   */
  incomplete?: boolean;
};

/**
 * Renders markdown with this app's image and link handling.
 *
 * Content is a prop rather than something read from disk, so a caller can feed
 * it a live editor buffer: the side preview has to follow typing, and reading
 * the file on every keystroke would show what was saved instead of what is
 * being written.
 */
export function MarkdownRender({ content, path, className, incomplete }: Props) {
  const baseDir = useMemo(() => directoryOf(path), [path]);
  // Images resolve against the document, so the override is per file.
  const components = useMemo(
    () => ({
      a: MarkdownLink,
      code: MarkdownCode,
      img: (props: ComponentProps<typeof MarkdownImage>) => (
        <MarkdownImage {...props} baseDir={baseDir} />
      ),
    }),
    [baseDir],
  );

  return (
    <Streamdown
      className={
        className ??
        "markdown-rendered select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      }
      components={components}
      mode="static"
      parseIncompleteMarkdown={incomplete ?? false}
    >
      {content}
    </Streamdown>
  );
}
