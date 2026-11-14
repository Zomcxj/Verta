import { detectMonoFontFamily } from "@/lib/fonts";
import { type MessageKey, translate } from "@/modules/i18n";
import type { Language } from "@/modules/i18n/language";
import { indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chromeTheme } from "./chromeTheme";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const lspCompartment = new Compartment();
export const indentCompartment = new Compartment();
export const searchPhrasesCompartment = new Compartment();

/**
 * The find panel's words, in the window's language.
 *
 * The panel belongs to CodeMirror, and it asks its state for each label by name (`Find`, `next`,
 * `match case`, ...). With nothing registered, `state.phrase` falls back to the name itself, so the
 * panel read as an English card floating in a Chinese window. `on line` and `current match` are the
 * screen-reader announcement of a match, and `replaced match on line $` is the one that reports a
 * replacement; they take the same table.
 */
export function searchPhrasesExtension(language: Language): Extension {
  const t = (key: MessageKey) => translate(language, key);
  return EditorState.phrases.of({
    Find: t("editor.search.find"),
    Replace: t("editor.search.replace"),
    next: t("editor.search.next"),
    previous: t("editor.search.previous"),
    all: t("editor.search.all"),
    "match case": t("editor.search.matchCase"),
    regexp: t("editor.search.regexp"),
    "by word": t("editor.search.byWord"),
    replace: t("editor.search.replaceOne"),
    "replace all": t("editor.search.replaceAll"),
    close: t("editor.search.close"),
    "Go to line": t("editor.search.goToLine"),
    go: t("editor.search.go"),
    "current match": t("editor.search.currentMatch"),
    "on line": t("editor.search.onLine"),
    "replaced match on line $": t("editor.search.replacedOnLine"),
  });
}

export function indentExtension(unit: string): Extension {
  return [
    indentUnit.of(unit),
    EditorState.tabSize.of(unit === "\t" ? 4 : unit.length),
  ];
}

export const DEFAULT_INDENT: Extension = indentExtension("  ");

const WORD_WRAP_COLUMN_VAR = "--verta-editor-wrap-column";
const WORD_WRAP_COLUMN_THEME = EditorView.theme({
  ".cm-content.cm-lineWrapping": {
    maxWidth: `var(${WORD_WRAP_COLUMN_VAR})`,
    marginLeft: "6px",
    marginRight: "2px",
  },
  ".cm-content.cm-lineWrapping .cm-line": {
    paddingLeft: "0",
    paddingRight: "0",
  },
});

export function wordWrapExtension(column: number | null): Extension {
  if (column === null) return [];
  return [
    EditorView.lineWrapping,
    WORD_WRAP_COLUMN_THEME,
    EditorView.contentAttributes.of({
      style: `${WORD_WRAP_COLUMN_VAR}: ${column}ch`,
    }),
  ];
}

// Only what basicSetup doesn't already cover, to avoid duplicate extensions.
// basicSetup gives us line numbers, fold gutter, history, indentOnInput,
// bracketMatching, closeBrackets, autocompletion, highlightActiveLine,
// highlightSelectionMatches and the search keymap.
// Singleton: per-pane instances would inject duplicate style modules.
const SHARED_EXTENSIONS: readonly Extension[] = Object.freeze([
  search({ top: true }),
  lintGutter(),
  chromeTheme(),
  EditorView.theme({
    "&, &.cm-editor, &.cm-editor.cm-focused": {
      backgroundColor: "transparent !important",
      color: "var(--foreground)",
      outline: "none",
      padding: "8px",
    },
    ".cm-scroller": {
      // The font comes from a CSS variable: the theme is built once at module
      // level, so its stack cannot be changed, and changing the font in settings
      // only updates the variable.
      fontFamily: `var(--editor-font-family, ${detectMonoFontFamily()})`,
      fontSize: "calc(var(--editor-font-size, 13px) * var(--app-zoom, 1))",
      lineHeight: "1.55",
      backgroundColor: "transparent !important",
    },
    ".cm-content": {
      caretColor: "var(--foreground)",
      backgroundColor: "transparent !important",
    },
    ".cm-gutters": {
      backgroundColor: "transparent !important",
      color: "var(--muted-foreground)",
    },
    ".cm-gutter-lint": {
      width: "0px",
    },
    ".cm-gutter": { backgroundColor: "transparent !important" },
    ".cm-lineNumbers .cm-gutterElement": {
      opacity: "0.55",
    },
    ".cm-foldGutter": { width: "10px" },
    ".cm-foldGutter .cm-gutterElement": {
      color: "var(--muted-foreground)",
      opacity: "0.5",
    },
    ".cm-activeLine": {
      borderTopRightRadius: "5px",
      borderBottomRightRadius: "5px",
      backgroundColor: "color-mix(in srgb, var(--foreground) 4%, transparent)",
    },
    ".cm-lineNumbers .cm-activeLineGutter": {
      borderTopLeftRadius: "5px",
      borderBottomLeftRadius: "5px",
      userSelect: "none",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--foreground)",
    },
    // Vim normal-mode block cursor: translucent foreground, no rose hue.
    ".cm-fat-cursor": {
      background:
        "color-mix(in srgb, var(--foreground) 35%, transparent) !important",
      outline:
        "1px solid color-mix(in srgb, var(--foreground) 55%, transparent) !important",
      color: "var(--foreground) !important",
      borderRadius: "2px",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "transparent !important",
      outline:
        "1px solid color-mix(in srgb, var(--foreground) 35%, transparent) !important",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
      {
        backgroundColor:
          "color-mix(in srgb, var(--foreground) 18%, transparent) !important",
      },
    ".cm-panels": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      borderColor: "var(--border)",
    },
  }),
]);

export function buildSharedExtensions(): readonly Extension[] {
  return SHARED_EXTENSIONS;
}
