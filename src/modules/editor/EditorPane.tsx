import { isImageExtension } from "@/lib/imageFormats";
import { lspFormatDocument, useLspExtension } from "@/modules/lsp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { acceptCompletion, startCompletion } from "@codemirror/autocomplete";
import { redo, undo } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { convertFileSrc } from "@tauri-apps/api/core";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { resolveCurrentLanguage, useLanguage, useT } from "@/modules/i18n";
import { MarkdownViewToggle, toggleStopClass, ViewToggleBar } from "@/modules/markdown";
import { toast } from "sonner";
import { ZoomControls } from "@/components/mermaid-diagram";
import { PanZoomSurface } from "@/components/pan-zoom";
import { SidePreview, type ViewportMark, sidePreviewKind } from "./SidePreview";
import { CsvPreview } from "./CsvPreview";
import { DocxPreview, type DocxPreviewHandle } from "./DocxPreview";
import { MermaidPreview } from "./MermaidPreview";
import { PptxPreview } from "./PptxPreview";
import { XlsxPreview } from "./XlsxPreview";
import { htmlPreviewUrl } from "./htmlPreviewUrl";
import { findCardWidth } from "./lib/chromeTheme";
import { diagnosticsReporter } from "./lib/diagnosticsReporter";
import { useDiagnosticsStore } from "./lib/diagnosticsStore";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  indentCompartment,
  indentExtension,
  languageCompartment,
  lspCompartment,
  searchPhrasesCompartment,
  searchPhrasesExtension,
  vimCompartment,
  wordWrapExtension,
  wrapCompartment,
} from "./lib/extensions";
import {
  applyFormattedContent,
  readFileText,
  resolveFormatter,
  runExternalFormatter,
} from "./lib/externalFormat";
import { imageScale } from "./lib/imageScale";
import { detectIndentUnit } from "./lib/indent";
import { type LanguageResult, resolveLanguage } from "./lib/languageResolver";
import { FORCE_READ_LIMIT, useDocument } from "./lib/useDocument";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { initVimGlobals, vimHandlersExtension } from "./lib/vim";

initVimGlobals();

export type EditorPaneHandle = {
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
  /** Open CodeMirror's find/replace panel. */
  openSearch: () => void;
  focus: () => void;
  getSelection: () => string | null;
  getPath: () => string;
  /** Re-read the file from disk. Skips silently if the buffer is dirty. */
  reload: () => boolean;
  /** Move the cursor to a 1-based line and center it, once content is ready. */
  gotoLine: (line: number, options?: { focus?: boolean }) => void;
  /** Apply CodeMirror's undo/redo commands. */
  undo: () => void;
  redo: () => void;
  /** Persist the buffer (format-on-save + write), same as Mod+S / :w. */
  save: () => Promise<void>;
  /** Request an AI ghost suggestion at the cursor. */
  /** Open CodeMirror's completion popup. */
  triggerCodeComplete: () => void;
};

type Props = {
  path: string;
  /**
   * The path this file had before the explorer renamed it, when this pane is the continuation of
   * that same file rather than a fresh document. `null` for a file opened normally.
   */
  renamedFrom?: string | null;
  overrideLanguage?: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
  onClose?: () => void;
  /**
   * Drawn inside the editor column, so a corner control stays off the side
   * preview. Rendered only while this pane is the editor for the file.
   *
   * Handed the side-preview state: the caller puts its own "preview" stop in
   * the same group, and this pane then drops the corner button it used to draw
   * (two groups in one corner would overlap).
   */
  renderToggle?: (side: SidePreviewToggle) => React.ReactNode;
};

type SidePreviewToggle = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

// Above this, syntax highlighting and LSP are disabled: a multi-MB lezer
// parse tree and a didOpen of that size cost far more than they give.
const SYNTAX_MAX_BYTES = 4 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The draft timestamp only has to identify which interruption this was, so minutes are
 * enough. */
function draftTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// memo: EditorStack passes identity-stable props, so background editors
// skip re-rendering entirely when App re-renders (terminal events, tab churn).
export const EditorPane = memo(
  forwardRef<EditorPaneHandle, Props>(function EditorPane(props, ref) {
    const {
      path,
      renamedFrom,
      overrideLanguage,
      onDirtyChange,
      onSaved,
      onClose,
      renderToggle,
    } = props;

    const {
      doc,
      dirty,
      onChange,
      save,
      reload,
      adoptDiskText,
      openAnyway,
      pendingDraft,
      restoreDraft,
      discardDraft,
      subscribeBuffer,
    } = useDocument({
      path,
      renamedFrom,
      onDirtyChange,
    });
    const reloadRef = useRef(reload);
    reloadRef.current = reload;
    const adoptDiskTextRef = useRef(adoptDiskText);
    adoptDiskTextRef.current = adoptDiskText;
    const cmRef = useRef<ReactCodeMirrorRef>(null);
    // Only a `.docx` fills this; the shell's undo shortcut asks it first.
    const docxRef = useRef<DocxPreviewHandle | null>(null);
    const tr = useT();
    const language = useLanguage();
    const themeExt = useEditorThemeExt();
    const vimMode = usePreferencesStore((s) => s.vimMode);
    const wordWrapColumn = usePreferencesStore((s) =>
      s.editorWordWrap ? s.editorWordWrapColumn : null,
    );
    const languageRef = useRef<string | null>(null);
    const [langId, setLangId] = useState<string | null>(null);
    // Stabilize save + onSaved via refs so the extensions array never changes
    // identity: a new identity makes @uiw/react-codemirror reconfigure the
    // whole state, wiping the language compartment.
    const saveRef = useRef(save);
    saveRef.current = save;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const lspActiveRef = useRef(false);
    const warnedNoLspRef = useRef(false);
    const warnedNoFormatRef = useRef(false);

    // Side preview: off by default so the editor keeps the full width, and only
    // offered for files it can actually show something for.
    const previewKind = useMemo(() => sidePreviewKind(path), [path]);
    const [sideOpen, setSideOpen] = useState(false);
    const [viewport, setViewport] = useState<ViewportMark | null>(null);
    /**
     * The HTML render stop. An HTML file renders by handing the browser the file itself through the
     * asset protocol, which is what the PDF preview already does - so there is no parser here and no
     * new dependency, and the page keeps its own CSS and script. It reads the file from disk, so it
     * is offered only while the buffer is clean, exactly like the Markdown render stop.
     */
    const [htmlRendered, setHtmlRendered] = useState(false);
    /**
     * A `.csv` opens as the table it is.
     *
     * The source is one click away and still editable, but a file of a thousand rows is not
     * something anyone reads as text - which is what "unreadable" looked like from the outside.
     */
    const [csvRendered, setCsvRendered] = useState(true);
    /**
     * A `.mmd` / `.mermaid` opens as the diagram it is.
     *
     * The source is one stop away and still editable. Unlike the table and the HTML page this one
     * draws from the buffer rather than from the file on disk, so it is offered while the file is
     * dirty too: a diagram of what was last saved is not what someone editing a diagram wants to
     * look at.
     */
    const [diagramRendered, setDiagramRendered] = useState(true);
    /** 1 is "fit the pane, up to the drawing's own width"; the control sits beside the view switch. */
    const [diagramZoom, setDiagramZoom] = useState(1);
    const fileExt = path.split(".").pop()?.toLowerCase() ?? "";
    const isCsv = fileExt === "csv" || fileExt === "tsv";
    const isHtml = fileExt === "html" || fileExt === "htm";
    const isDiagram = fileExt === "mmd" || fileExt === "mermaid";
    // Unsaveable edits come first: what the frame shows is the file on disk, so a dirty buffer has
    // to fall back to the source rather than preview the text that was last written.
    const htmlRendering = isHtml && htmlRendered && !dirty;
    // Same rule as the HTML stop: the table shows the file on disk, so a dirty buffer falls back to
    // the source rather than to a table of what was last written.
    const csvRendering = isCsv && csvRendered && !dirty;
    const diagramRendering = isDiagram && diagramRendered;
    /**
     * The diagram's source, live.
     *
     * A `.mmd` draws from the buffer, not from `doc.content`: the document state only moves when a
     * file is loaded or reloaded, and a diagram that kept drawing the file as it was on disk while
     * the editor next to it showed something else is the exact bug the side preview already fixed by
     * subscribing. Subscribed only while the render stop is selected.
     */
    const [diagramText, setDiagramText] = useState(
      doc.status === "ready" ? doc.content : "",
    );
    const readyText = doc.status === "ready" ? doc.content : "";
    useEffect(() => {
      if (!diagramRendering) return;
      setDiagramText(readyText);
      return subscribeBuffer(setDiagramText);
    }, [diagramRendering, subscribeBuffer, readyText]);
    const toggleSide = useCallback(() => setSideOpen((open) => !open), []);
    // A different file starts collapsed again: the setting is per view, and
    // carrying it over would silently reflow a file the user did not ask for.
    // biome-ignore lint/correctness/useExhaustiveDependencies: path is the only trigger this reset has; dropping it would leave the side panel open across files
    useEffect(() => {
      setSideOpen(false);
    }, [path]);
    const sideVisible = sideOpen && previewKind !== "none";

    /**
     * What the side preview renders: the live buffer, not `doc.content`.
     *
     * The document state moves only when a file is loaded or reloaded, so a preview handed
     * `doc.content` showed the file as it was on disk while the person typed next to it - measured
     * as the preview still drawing `# Old title` after the editor read `# New title`. Subscribed only
     * while the column is open, so a pane with the preview shut re-renders no more than before.
     */
    const [previewText, setPreviewText] = useState(
      doc.status === "ready" ? doc.content : "",
    );
    useEffect(() => {
      if (!sideVisible) return;
      return subscribeBuffer(setPreviewText);
    }, [sideVisible, subscribeBuffer]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: tr only feeds formatter warning toasts, and listing it would rebuild the save handler on every language switch
    const performSave = useCallback(async () => {
      const view = cmRef.current?.view;
      const prefs = usePreferencesStore.getState();
      const formatter = resolveFormatter(languageRef.current, prefs);
      if (prefs.editorFormatOnSave && formatter === "lsp" && view) {
        if (lspActiveRef.current) {
          let res: "done" | "unsupported" = "done";
          try {
            res = await lspFormatDocument(view);
          } catch (e) {
            toast.error(tr("editor.lspFormatFailed"), {
              description: String(e),
            });
          }
          if (res === "unsupported" && !warnedNoFormatRef.current) {
            warnedNoFormatRef.current = true;
            toast.warning(tr("editor.formatSkipped.title"), {
              description: tr("editor.formatSkipped.noFormatter"),
            });
          }
        } else if (!warnedNoLspRef.current) {
          warnedNoLspRef.current = true;
          toast.warning(tr("editor.formatSkipped.title"), {
            description: tr("editor.formatSkipped.noLsp"),
          });
        }
      }
      // Snapshot before save: edits typed during the formatter round-trip
      // must not be clobbered by the disk read-back.
      const docAtSave = view?.state.doc;
      const saved = await saveRef.current();
      if (!saved) return;
      if (prefs.editorFormatOnSave && formatter !== "lsp") {
        const error = await runExternalFormatter(
          formatter,
          pathRef.current,
          prefs.editorCustomFormatCommand,
        );
        if (error) {
          toast.error(tr("editor.formatFailed", { formatter }), {
            description: error,
          });
        } else {
          const readBack = await readFileText(pathRef.current);
          if (readBack !== null && view && view.state.doc === docAtSave) {
            applyFormattedContent(
              view,
              adoptDiskTextRef.current(readBack.text, readBack.mtime),
            );
          }
        }
      }
      onSavedRef.current?.();
    }, []);
    const performSaveRef = useRef(performSave);
    performSaveRef.current = performSave;

    const pathRef = useRef(path);
    pathRef.current = path;

    const pendingLineRef = useRef<{
      path: string;
      line: number;
      focus: boolean;
    } | null>(null);
    const pendingFocusRef = useRef<string | null>(null);
    const statusRef = useRef(doc.status);
    useLayoutEffect(() => {
      statusRef.current = doc.status;
    }, [doc.status]);

    useEffect(() => {
      if (pendingLineRef.current?.path !== path) {
        pendingLineRef.current = null;
      }
      if (pendingFocusRef.current !== path) {
        pendingFocusRef.current = null;
      }
    }, [path]);

    const focusWhenRendered = useCallback(
      (view: EditorView, targetPath: string) => {
        requestAnimationFrame(() => {
          if (cmRef.current?.view === view && pathRef.current === targetPath) {
            view.focus();
          }
        });
      },
      [],
    );

    const applyPendingGoto = useCallback(() => {
      const view = cmRef.current?.view;
      const pending = pendingLineRef.current;
      if (!view || pending == null || statusRef.current !== "ready") return;
      if (pending.path !== path) {
        pendingLineRef.current = null;
        return;
      }
      const target = Math.max(1, Math.min(pending.line, view.state.doc.lines));
      const at = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: at },
        effects: EditorView.scrollIntoView(at, { y: "center" }),
      });
      if (pending.focus) focusWhenRendered(view, pending.path);
      pendingLineRef.current = null;
    }, [focusWhenRendered, path]);

    const applyPendingFocus = useCallback(() => {
      const view = cmRef.current?.view;
      const pendingPath = pendingFocusRef.current;
      if (!view || pendingPath === null || statusRef.current !== "ready")
        return;
      pendingFocusRef.current = null;
      if (pendingPath === path) focusWhenRendered(view, pendingPath);
    }, [focusWhenRendered, path]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      applyPendingGoto();
      applyPendingFocus();
    }, [doc.status, applyPendingFocus, applyPendingGoto]);

    const extensions = useMemo(
      () => [
        // basicSetup is added before user extensions by @uiw/react-codemirror,
        // so we must elevate vim's precedence to win the keymap.
        vimCompartment.of(
          usePreferencesStore.getState().vimMode ? Prec.highest(vim()) : [],
        ),
        wrapCompartment.of(
          wordWrapExtension(
            usePreferencesStore.getState().editorWordWrap
              ? usePreferencesStore.getState().editorWordWrapColumn
              : null,
          ),
        ),
        vimHandlersExtension(() => ({
          save: () => {
            void performSaveRef.current();
          },
          close: () => onCloseRef.current?.(),
        })),
        ...buildSharedExtensions(),
        searchPhrasesCompartment.of(
          searchPhrasesExtension(resolveCurrentLanguage()),
        ),
        indentCompartment.of(DEFAULT_INDENT),
        languageCompartment.of([]),
        lspCompartment.of([]),
        diagnosticsReporter(() => pathRef.current),
        // Report which part of the document is on screen, for the side preview.
        EditorView.updateListener.of((update) => {
          const view = update.view;
          if (
            !update.selectionSet &&
            !update.docChanged &&
            !update.geometryChanged
          ) {
            return;
          }
          const scroller = view.scrollDOM;
          const total = scroller.scrollHeight;
          if (total <= 0) return setViewport(null);
          const top = scroller.scrollTop;
          const height = scroller.clientHeight;
          setViewport({
            top: Math.min(1, Math.max(0, top / total)),
            height: Math.min(1, height / total),
          });
        }),
        // An open popup wins Tab over CodeMirror's own accept binding.
        Prec.highest(keymap.of([{ key: "Tab", run: acceptCompletion }])),
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              void performSaveRef.current();
              return true;
            },
          },
          { key: "Ctrl-g", run: gotoLine },
        ]),
      ],
      [],
    );

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: vimCompartment.reconfigure(vimMode ? Prec.highest(vim()) : []),
      });
    }, [vimMode]);

    useEffect(() => {
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: wrapCompartment.reconfigure(wordWrapExtension(wordWrapColumn)),
      });
    }, [wordWrapColumn]);

    useEffect(() => {
      // The find panel is already built; a language switch has to reach into it.
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: searchPhrasesCompartment.reconfigure(
          searchPhrasesExtension(language),
        ),
      });
    }, [language]);

    useEffect(() => {
      if (doc.status !== "ready") return;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: indentCompartment.reconfigure(
          indentExtension(detectIndentUnit(doc.content)),
        ),
      });
    }, [doc]);

    const lspExt = useLspExtension(path, langId, doc.status === "ready");
    useEffect(() => {
      lspActiveRef.current = lspExt !== null;
      const view = cmRef.current?.view;
      if (!view) return;
      view.dispatch({
        effects: lspCompartment.reconfigure(lspExt ?? []),
      });
    }, [lspExt]);

    useEffect(
      () => () => useDiagnosticsStore.getState().report(pathRef.current, null),
      [],
    );

    // Warm the language chunk while the file is still being read; the
    // ready-gated effect below then resolves from cache.
    useEffect(() => {
      const resolvePath = overrideLanguage ? `dummy.${overrideLanguage}` : path;
      void resolveLanguage(resolvePath).catch(() => {});
    }, [path, overrideLanguage]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: doc.size would re-run the language effect as the buffer grows, resetting langId mid-session
    useEffect(() => {
      const ext =
        overrideLanguage || (path.split(".").pop()?.toLowerCase() ?? null);
      languageRef.current = ext;
      if (doc.status !== "ready") return;
      if (doc.size > SYNTAX_MAX_BYTES) {
        setLangId(null);
        const view = cmRef.current?.view;
        view?.dispatch({ effects: languageCompartment.reconfigure([]) });
        return;
      }
      let cancelled = false;
      const resolve = async (): Promise<LanguageResult> => {
        const resolvePath = overrideLanguage
          ? `dummy.${overrideLanguage}`
          : path;
        return (
          (await resolveLanguage(resolvePath)) ?? { ext: [], name: "", id: "" }
        );
      };
      void resolve().then((result) => {
        if (cancelled) return;
        if (result.id) languageRef.current = result.id;
        setLangId(result.id || ext);
        const view = cmRef.current?.view;
        if (!view) return;
        view.dispatch({
          effects: languageCompartment.reconfigure(result.ext),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [path, doc.status, overrideLanguage]);

    useImperativeHandle(
      ref,
      () => ({
        setQuery: (q: string) => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(
              new SearchQuery({ search: q, caseSensitive: false }),
            ),
          });
          if (q) findNext(view);
        },
        findNext: () => {
          const view = cmRef.current?.view;
          if (view) findNext(view);
        },
        findPrevious: () => {
          const view = cmRef.current?.view;
          if (view) findPrevious(view);
        },
        clearQuery: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
        },
        openSearch: () => {
          const view = cmRef.current?.view;
          if (view) openSearchPanel(view);
        },
        focus: () => {
          pendingFocusRef.current = path;
          applyPendingFocus();
        },
        getSelection: () => {
          const view = cmRef.current?.view;
          if (!view) return null;
          const { from, to } = view.state.selection.main;
          if (from === to) return null;
          return view.state.sliceDoc(from, to);
        },
        getPath: () => path,
        reload: () => reloadRef.current(),
        gotoLine: (line: number, options) => {
          pendingLineRef.current = {
            path,
            line,
            focus: options?.focus ?? true,
          };
          applyPendingGoto();
        },
        undo: () => {
          // A `.docx` has no CodeMirror view: its undo takes back the last change that reached the
          // file, which is the only way to bring a deleted paragraph back.
          if (docxRef.current) {
            docxRef.current.undo();
            return;
          }
          const view = cmRef.current?.view;
          if (view) undo(view);
        },
        redo: () => {
          const view = cmRef.current?.view;
          if (view) redo(view);
        },
        save: () => {
          // Nothing was read as text for a `.docx` (or any file the text reader refused), so there is
          // no buffer: writing here would put an empty string over the archive. The document pane
          // saves itself, a paragraph at a time.
          if (fileExt === "docx" || statusRef.current !== "ready") {
            return Promise.resolve();
          }
          return performSaveRef.current();
        },
        triggerCodeComplete: () => {
          const view = cmRef.current?.view;
          if (!view) return;
          view.focus();
          startCompletion(view);
        },
      }),
      [path, fileExt, applyPendingFocus, applyPendingGoto],
    );

    // A `.docx` is an archive of XML, not text, so it goes to the reader whatever the text read has
    // to say about the file. Gating this on the read having *failed* meant the routing fell through
    // for a `.docx` whose bytes happen to be text - and for an empty one - which then opened in the
    // source editor, where an archive is nonsense, and it left the reader's own message unreachable.
    if (fileExt === "docx") {
      // The tab's dot is the same one a text file gets: it says "the file on disk is behind what
      // you see", which is what closing the tab has to warn about.
      return (
        <DocxPreview
          ref={docxRef}
          path={path}
          onDirtyChange={onDirtyChange}
        />
      );
    }
    // A workbook and a deck are archives of XML too, so they reach their readers the same way and
    // for the same reason: the text reader can only call them a binary file.
    if (fileExt === "xlsx" || fileExt === "xlsm") {
      return <XlsxPreview path={path} />;
    }
    if (fileExt === "pptx") {
      return <PptxPreview path={path} />;
    }
    // A `.csv` written in GB18030 is not UTF-8, so the *text* reader calls it a binary file - but
    // its table is exactly what the reader for it is for: the Rust side decodes the file itself.
    // Without this the table was unreachable for every Chinese export.
    if (isCsv && csvRendering) {
      return <CsvPreview path={path} />;
    }
    if (doc.status === "loading") {
      return (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          {tr("editor.loading")}
        </div>
      );
    }
    if (doc.status === "error") {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
          {doc.message}
        </div>
      );
    }
    if (doc.status === "binary" || doc.status === "toolarge") {
      const ext = fileExt;
      // One table for every pane (`lib/imageFormats.ts`): the sidebar and the main view used to keep
      // their own, and disagreed about `bmp` and `avif` - a thumbnail on one side, "cannot be
      // displayed" on the other. An SVG is not in it: it is text, and the editor is what opens it.
      const isImage = isImageExtension(ext);
      const isVideo = ["mp4", "webm", "ogg", "mov"].includes(ext);
      const isAudio = ["mp3", "wav", "flac", "aac", "m4a"].includes(ext);
      const isPdf = ext === "pdf";

      if (isImage || isVideo || isAudio || isPdf) {
        const assetUrl = convertFileSrc(path);
        const name = path.split(/[\\/]/).pop() ?? path;
        return (
          <div
            // No base colour of its own: this fills the tab's pane, which provides the
            // surface. A `bg-background` here is invisible on opaque themes but a solid
            // slab on glass themes (the pane tints 0.28 while this painted the colour
            // solid), so an opened image looked like a different surface than the window
            // around it. Same fix and reason as the side preview column, the markdown
            // preview and the preview pane.
            className="flex h-full min-h-0 flex-col items-center justify-center p-4 overflow-auto"
          >
            {isImage && <ImagePreview src={assetUrl} path={path} name={name} />}
            {isVideo && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <video
                controls
                preload="metadata"
                className="max-w-full max-h-full"
                src={assetUrl}
              />
            )}
            {isAudio && (
              // biome-ignore lint/a11y/useMediaCaption: local media preview opens arbitrary files with no caption track
              <audio
                controls
                preload="metadata"
                className="w-full max-w-md"
                src={assetUrl}
              />
            )}
            {isPdf && (
              <iframe
                src={assetUrl}
                className="w-full h-full border-none"
                title={path.split("/").pop()}
              />
            )}
          </div>
        );
      }

      const canForce =
        doc.status === "toolarge" && doc.size <= FORCE_READ_LIMIT;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
          <div className="text-sm text-foreground">
            {doc.status === "binary"
              ? tr("editor.binaryFile")
              : tr("editor.fileTooLarge")}
          </div>
          <div className="text-xs text-muted-foreground">
            {formatBytes(doc.size)} ·{" "}
            {ext === "doc"
              ? tr("editor.docUnsupported")
              : canForce
                ? tr("editor.syntaxDisabled")
                : tr("editor.previewUnsupported")}
          </div>
          {canForce && (
            <button
              type="button"
              onClick={openAnyway}
              className="mt-2 rounded-md border border-border bg-muted/60 px-3 py-1 text-xs text-foreground hover:bg-accent"
            >
              {tr("editor.openAnyway")}
            </button>
          )}
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 zoom-exempt">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {renderToggle?.({ open: sideOpen, setOpen: setSideOpen })}
          {isCsv && !renderToggle ? (
            <MarkdownViewToggle
              mode={csvRendering ? "rendered" : "raw"}
              onChange={(mode) => setCsvRendered(mode === "rendered")}
              renderedDisabled={dirty}
              renderedHint={tr("markdown.saveToPreview")}
            />
          ) : null}
          {isHtml && !renderToggle ? (
            // Two stops rather than the Markdown control's three: an HTML file has no side-by-side
            // column, so "rendered" replaces the source rather than joining it. No backdrop
            // blur either: it would add a compositing layer.
            <MarkdownViewToggle
              mode={htmlRendering ? "rendered" : "raw"}
              onChange={(mode) => setHtmlRendered(mode === "rendered")}
              renderedDisabled={dirty}
              renderedHint={tr("markdown.saveToPreview")}
            />
          ) : null}
          {isDiagram && !renderToggle ? (
            // No `renderedDisabled`: this stop draws from the buffer, so a dirty file is the case it
            // exists for rather than one it has to refuse. The zoom belongs in this bar rather than
            // floating over the drawing: it is a control of the view, like the switch beside it.
            <MarkdownViewToggle
              mode={diagramRendering ? "rendered" : "raw"}
              onChange={(mode) => setDiagramRendered(mode === "rendered")}
            >
              {diagramRendering ? (
                <ZoomControls zoom={diagramZoom} onChange={setDiagramZoom} />
              ) : null}
            </MarkdownViewToggle>
          ) : null}
          {pendingDraft ? (
            // A draft from an interrupted session: a narrow bar that neither blocks
            // editing nor changes the file on its own.
            <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-[11px]">
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {tr("editor.draft.found", {
                  time: draftTime(pendingDraft.at),
                })}
              </span>
              <button
                type="button"
                onClick={() => {
                  restoreDraft();
                  toast.message(tr("editor.draft.restored"));
                }}
                className="shrink-0 rounded border border-border/60 bg-background px-1.5 py-0.5 text-[10.5px] hover:bg-accent"
              >
                {tr("editor.draft.restore")}
              </button>
              <button
                type="button"
                onClick={discardDraft}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {tr("editor.draft.discard")}
              </button>
            </div>
          ) : null}
          {/* Markdown moved this into the view switch at the top right (three
              stops: rendered / raw / preview). What is left here is the files
              that have a side preview but no view switch: images and SVGs - and
              they sit in that same bar, in that same corner, with the one stop
              they have. It used to be a lone button in the bottom right, so the
              same choice was in a different place depending on the file. No
              backdrop blur: it would add a compositing layer, which the startup
              budget forbids. */}
          {previewKind !== "none" && !renderToggle && (
            <ViewToggleBar>
              <button
                type="button"
                onClick={toggleSide}
                title={
                  sideOpen ? tr("editor.preview.hide") : tr("editor.preview.show")
                }
                aria-label={
                  sideOpen ? tr("editor.preview.hide") : tr("editor.preview.show")
                }
                aria-pressed={sideOpen}
                className={toggleStopClass(sideOpen)}
              >
                {tr("editor.preview.title")}
              </button>
            </ViewToggleBar>
          )}
          {htmlRendering ? (
            // The same browser-level preview the PDF stop uses, pointed at the file over the asset
            // protocol, which `frame-src` already allows - so no CSP change, and no parser between
            // the file and what it looks like.
            //
            // The URL is built segment by segment rather than with `convertFileSrc`: that encodes the
            // whole path as one segment, and a page whose stylesheet is `./style.css` then resolves it
            // to `http://asset.localhost/style.css` and renders unstyled. See `htmlPreviewUrl`.
            //
            // `sandbox` is the browser preview's own list, and it stops short of
            // `allow-top-navigation`: with it, a page could navigate the Tauri webview itself and
            // put `window.__TAURI__` on an origin of its choosing.
            <iframe
              key={`${path}#html-preview`}
              src={htmlPreviewUrl(path)}
              title={path.split(/[\\/]/).pop() ?? path}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
              referrerPolicy="no-referrer"
              className="h-full min-h-0 w-full flex-1 border-0 bg-white"
            />
          ) : csvRendering ? (
            <CsvPreview path={path} />
          ) : diagramRendering ? (
            <MermaidPreview
              content={diagramText}
              zoom={diagramZoom}
              onZoomChange={setDiagramZoom}
            />
          ) : (
            <CodeMirror
              ref={cmRef}
              value={doc.content}
              onChange={onChange}
              theme={themeExt}
              extensions={extensions}
              height="100%"
              className="verta-code-editor flex-1 min-h-0 overflow-hidden"
              // The find card is a fixed width, and the width depends on the language of its
              // labels; the theme reads this property, so switching language needs no reconfigure.
              style={
                {
                  "--verta-find-card-width": findCardWidth(language),
                } as React.CSSProperties
              }
              basicSetup={{
                lineNumbers: true,
                highlightActiveLineGutter: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                highlightActiveLine: true,
                highlightSelectionMatches: true,
                searchKeymap: true,
              }}
            />
          )}
        </div>
        {previewKind !== "none" && (
          <SidePreview
            kind={previewKind}
            content={previewText}
            path={path}
            imageSrc={previewKind === "image" ? convertFileSrc(path) : null}
            viewport={sideVisible ? viewport : null}
            onToggle={toggleSide}
            visible={sideVisible}
          />
        )}
      </div>
    );
  }),
);

/**
 * A picture opened as a file.
 *
 * Fits the window by default so a huge screenshot is readable at a glance, 1:1 on request for
 * checking detail, and any magnification in between or beyond - the same steps and the same control
 * a diagram uses. The original pixel size is shown either way, so it is obvious what is being looked
 * at, and a picture bigger than the pane drags with the left button.
 */
function ImagePreview({
  src,
  path,
  name,
}: {
  src: string;
  path: string;
  name: string;
}) {
  const t = useT();
  const [fit, setFit] = useState(true);
  /** A magnification over whichever stop is on; 1 is "that stop as it is". */
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);

  /** The room the picture has. Zero is not a room: a pane that has not been laid out is not a fit. */
  const rememberRoom = useCallback((room: { w: number; h: number }) => {
    if (room.w <= 0 || room.h <= 0) return;
    setBox((was) => (was && was.w === room.w && was.h === room.h ? was : room));
  }, []);

  /** The scrollport's own content box, read on the spot. */
  const measureRoom = useCallback(
    (node: HTMLDivElement) => rememberRoom({ w: node.clientWidth, h: node.clientHeight }),
    [rememberRoom],
  );

  /**
   * The picture's own pixel size, once the browser knows it.
   *
   * Read from the element as well as from `load`, because a picture that is already decoded when
   * React attaches its handler never raises `load` at all - the event has been and gone. Nothing
   * then knows how big the picture is, so nothing can fit it, and it is drawn at its own pixels:
   * measured here as a 3072x3072 screenshot sitting at 3074px inside a 1070px pane, with no inline
   * size at all. Reading `complete` on mount closes that race.
   */
  const readNaturalSize = useCallback((img: HTMLImageElement | null) => {
    if (!img?.complete || img.naturalWidth === 0) return;
    const next = { w: img.naturalWidth, h: img.naturalHeight };
    setSize((was) => (was && was.w === next.w && was.h === next.h ? was : next));
    // The room is read here as well as observed below. A pane that has not been laid out yet - the
    // one this tab is opened into while the workspace is still switching - reports *nothing* to a
    // resize observer, not even a zero, and a fit with no room is no fit: measured on a real run as a
    // 3072px picture opened at its own size in a 1070px pane, with the observer attached and silent.
    const node = viewport.current;
    if (node) measureRoom(node);
  }, [measureRoom]);

  // `src` is a dependency so that swapping the picture re-reads the element: the previous picture's
  // pixels are not this one's, and a stale size would fit the new one to the old one's shape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the body reads the element, not `src`; the dependency is what makes a swapped source be read again
  useEffect(() => {
    readNaturalSize(picture.current);
  }, [src, readNaturalSize]);

  // The room the picture has, watched rather than measured once: dragging a divider or resizing
  // the window changes it, and a picture that fits has to follow.
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) rememberRoom({ w: rect.width, h: rect.height });
    });
    observer.observe(node);
    // And a few frames of its own, because the first report from an observer attached before the pane
    // had a box can be nothing at all: the fit then waits for a resize that may never come, which is
    // how a picture opened during startup was drawn at its own size.
    let frames = 0;
    let frame = requestAnimationFrame(function tick() {
      measureRoom(node);
      frames += 1;
      if (frames < 5) frame = requestAnimationFrame(tick);
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [measureRoom, rememberRoom]);

  // `imageScale` holds the rule and its reasons (fit scales up as well as down, 1:1 means the
  // picture's own pixels, and an unknown size answers `null` rather than drawing at 1).
  const scale = imageScale({ fit, natural: size, box, zoom });
  /**
   * The size the picture is drawn at, floored.
   *
   * Floored so a rounding error cannot raise a scrollbar at the fit stop - `scale` is already the
   * smaller of the two ratios, so flooring its product cannot exceed the room. It is *not* clamped to
   * the room: a magnification past 100% has to be able to exceed it, which is what makes the picture
   * bigger than its pane and therefore worth dragging.
   */
  const drawn =
    scale !== null && size !== null
      ? {
          w: Math.max(1, Math.floor(size.w * scale)),
          h: Math.max(1, Math.floor(size.h * scale)),
        }
      : null;

  if (failed) {
    return (
      <div className="flex flex-col items-center gap-1 text-center">
        <div className="text-sm text-destructive">
          {t("editor.image.readFailed")}
        </div>
        <div className="text-xs text-muted-foreground">{path}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center gap-2">
      <div className="flex w-full shrink-0 items-center gap-2 px-1 text-[11px] text-muted-foreground">
        <span className="truncate text-foreground">{name}</span>
        {size && (
          <span className="shrink-0 tabular-nums">
            {size.w} x {size.h}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <ZoomControls zoom={zoom} onChange={setZoom} />
          <button
            type="button"
            onClick={() => {
              // Either stop is a fresh look: carrying a magnification across would make "fit" not
              // fit and "1:1" not 1:1.
              setFit((was) => !was);
              setZoom(1);
            }}
            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            {fit ? t("editor.image.originalSize") : t("editor.image.fitToWindow")}
          </button>
        </span>
      </div>
      {/* The scrollport, and the drag: both come from the shared surface, which centres with
          `safe` in both axes (plain centring puts the leading edge of an overflowing picture
          outside the scrollable range, so its left could never be reached) and drags by moving the
          scroll offsets rather than by transforming the picture. */}
      <PanZoomSurface
        viewportRef={viewport}
        zoom={zoom}
        onZoomChange={setZoom}
        draggable={drawn !== null && box !== null && (drawn.w > box.w + 1 || drawn.h > box.h + 1)}
      >
        <img
          ref={picture}
          src={src}
          alt={name}
          decoding="async"
          onLoad={(event) => readNaturalSize(event.currentTarget)}
          onError={() => setFailed(true)}
          className={
            // `max-w-none` in both stops, because the base layer caps every image at its container's
            // width. The size is the picture's own (see `drawn`), so leaving the cap on would clamp
            // the width and let the height keep growing - a magnification would stretch the picture
            // instead of enlarging it. The cap is not needed to protect the pane either: at the fit
            // stop `drawn` is already the smaller of the two ratios, so it cannot exceed the room.
            "max-w-none rounded-md border border-border shadow-sm"
          }
          style={{
            ...(drawn ? { width: `${drawn.w}px`, height: `${drawn.h}px` } : {}),
            backgroundImage:
              "conic-gradient(var(--muted) 0.25turn, transparent 0.25turn 0.5turn, var(--muted) 0.5turn 0.75turn, transparent 0.75turn)",
            backgroundSize: "20px 20px",
          }}
        />
      </PanZoomSurface>
    </div>
  );
}
