import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { searchPhrasesExtension, wordWrapExtension } from "./extensions";

/**
 * Every label the find panel asks its state for, taken from @codemirror/search's own `phrase(...)`
 * calls. If that package grows one, this list is where a missing translation shows up.
 */
const PANEL_KEYS = [
  "Find",
  "Replace",
  "next",
  "previous",
  "all",
  "match case",
  "regexp",
  "by word",
  "replace",
  "replace all",
  "close",
  "Go to line",
  "go",
  "current match",
  "on line",
  "replaced match on line $",
];

describe("wordWrapExtension", () => {
  it("enables native line wrapping at the configured width", () => {
    const state = EditorState.create({
      extensions: [wordWrapExtension(80)],
    });

    expect(state.facet(EditorView.contentAttributes)).toEqual(
      expect.arrayContaining([
        { class: "cm-lineWrapping" },
        { style: "--verta-editor-wrap-column: 80ch" },
      ]),
    );
  });

  it("adds no content attributes when disabled", () => {
    const state = EditorState.create({
      extensions: [wordWrapExtension(null)],
    });

    expect(state.facet(EditorView.contentAttributes)).toEqual([]);
  });

  it("reuses the wrap theme across column changes", () => {
    const first = wordWrapExtension(80) as readonly Extension[];
    const second = wordWrapExtension(120) as readonly Extension[];

    expect(first[1]).toBe(second[1]);
  });
});

describe("searchPhrasesExtension", () => {
  it("translates every label the find panel asks for", () => {
    // Left unregistered, `state.phrase` falls back to the English name, which is how the panel
    // ended up reading as an English card in a Chinese window.
    const zh = EditorState.create({ extensions: [searchPhrasesExtension("zh")] });
    for (const key of PANEL_KEYS) {
      expect(zh.phrase(key), key).not.toBe(key);
    }
    expect(zh.phrase("Find")).toBe("查找");
    expect(zh.phrase("match case")).toBe("大小写");
    expect(zh.phrase("replace all")).toBe("全部替换");
  });

  it("keeps English as English", () => {
    const en = EditorState.create({ extensions: [searchPhrasesExtension("en")] });
    expect(en.phrase("Find")).toBe("Find");
    expect(en.phrase("previous")).toBe("previous");
    expect(en.phrase("replaced match on line $")).toContain("$");
  });
});
