import { Input } from "@/components/ui/input";
import { KEY_SEP } from "@/lib/platform";
import type { EditorPaneHandle } from "@/modules/editor";
import { useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import type { TerminalSearchController } from "@/modules/terminal/search/TerminalSearchController";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

const TERM_DECORATIONS = {
  matchBackground: "#515c6a",
  activeMatchBackground: "#d18616",
  matchOverviewRuler: "#d18616",
  activeMatchColorOverviewRuler: "#d18616",
};

export type SearchTarget =
  | { kind: "terminal"; addon: TerminalSearchController; focus: () => void }
  | { kind: "editor"; handle: EditorPaneHandle; focus: () => void }
  | {
      kind: "git-history";
      handle: { setQuery: (q: string) => void; clearQuery: () => void };
      focus: () => void;
    }
  | null;

export type SearchInlineHandle = { focus: () => void };

type Props = {
  target: SearchTarget;
};

/**
 * The find box, floating over the pane it searches.
 *
 * It used to be a field standing in the header, always there, whatever the tab was: 192px of the
 * chrome spent on a box that is empty most of the time, labelled with a shortcut nobody needs told.
 * It is now drawn only while it is being used, in the top-right corner of the active pane, and the
 * pane underneath keeps its full height - the box sits over the terminal or the Git history rather
 * than pushing them down.
 *
 * Escape closes it, as does an empty box losing focus; a box with a query stays until it is closed,
 * because reading the matches underneath is the point.
 */
export const SearchInline = forwardRef<SearchInlineHandle, Props>(
  function SearchInline({ target }, ref) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    const userShortcuts = usePreferencesStore((s) => s.shortcuts);

    const shortcutText = useMemo(() => {
      const s = SHORTCUTS.find((entry) => entry.id === "search.focus");
      if (!s) return "";
      const bindings = userShortcuts["search.focus"] || s.defaultBindings;
      if (!bindings || bindings.length === 0) return "";
      return getBindingTokens(bindings[0]).join(KEY_SEP);
    }, [userShortcuts]);

    const baseLabel =
      target?.kind === "git-history" ? t("header.search.git") : t("header.search");

    const placeholder = shortcutText
      ? `${baseLabel} (${shortcutText})`
      : baseLabel;

    const focus = useCallback(() => {
      if (!target) return;
      setOpen(true);
    }, [target]);

    useImperativeHandle(ref, () => ({ focus }), [focus]);

    // The field does not exist until the box opens, so the focus waits for the render that makes it.
    useEffect(() => {
      if (open) inputRef.current?.focus();
    }, [open]);

    const clearTarget = useCallback(() => {
      if (!target) return;
      if (target.kind === "terminal") target.addon.clearDecorations();
      else target.handle.clearQuery();
    }, [target]);

    const restoreTargetFocus = useCallback(() => {
      if (!target) return;
      target.focus();
    }, [target]);

    const close = useCallback(() => {
      setOpen(false);
      setQ("");
      clearTarget();
      restoreTargetFocus();
    }, [clearTarget, restoreTargetFocus]);

    // Target switched (terminal ↔ editor) or removed → drop highlights. A box left open over a tab
    // that is no longer there would search the wrong pane.
    useEffect(() => {
      clearTarget();
      setOpen(false);
      setQ("");
    }, [clearTarget]);

    const applyIncremental = (next: string) => {
      if (!target) return;
      if (target.kind === "terminal") {
        if (next) {
          target.addon.findNext(next, {
            incremental: true,
            decorations: TERM_DECORATIONS,
          });
        } else {
          target.addon.clearDecorations();
        }
      } else {
        target.handle.setQuery(next);
      }
    };

    const findDirection = (forward: boolean) => {
      if (!target || !q) return;
      if (target.kind === "terminal") {
        const opts = { decorations: TERM_DECORATIONS };
        if (forward) target.addon.findNext(q, opts);
        else target.addon.findPrevious(q, opts);
      } else if (target.kind === "editor") {
        if (forward) target.handle.findNext();
        else target.handle.findPrevious();
      }
      // git-history: the list filters live; Enter has no next/prev semantics.
    };

    if (!open || !target) return null;

    return (
      <div
        data-search-float
        className="absolute top-2 right-3 z-40 flex h-8 items-center gap-1.5 rounded-lg border border-border/80 bg-popover/95 pr-1 pl-2 shadow-lg backdrop-blur-sm animate-in fade-in-0 slide-in-from-top-1 duration-150"
      >
        <HugeiconsIcon
          icon={Search01Icon}
          size={13}
          strokeWidth={1.75}
          className="pointer-events-none shrink-0 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          value={q}
          placeholder={placeholder}
          className="h-6 w-[190px] border-0 bg-transparent px-0 text-[12.5px]! shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
          onChange={(event) => {
            const next = event.target.value;
            setQ(next);
            applyIncremental(next);
          }}
          onBlur={() => {
            // An empty box is not a search: it goes away as soon as it is left.
            if (!q) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              findDirection(!event.shiftKey);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        />
        <button
          type="button"
          onClick={close}
          className="shrink-0 rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label={t("header.clearSearch")}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </button>
      </div>
    );
  },
);
