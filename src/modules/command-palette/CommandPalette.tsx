import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileIcon } from "@/modules/explorer/FileIcon";
import { type MessageKey, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  type KeyBinding,
  SHORTCUT_ALIASES,
  SHORTCUTS,
  type ShortcutId,
} from "@/modules/shortcuts";
import {
  listBuiltinThemes,
  listShapes,
  SHAPE_LABELS,
  ShapeIcon,
  type ShapeId,
  useTheme,
} from "@/modules/theme";
import {
  AlertCircleIcon,
  ArrowTurnBackwardIcon,
  CommandIcon,
  TerminalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { COMMAND_GROUPS } from "./commands";
import { useCommandHistory } from "./hooks/useCommandHistory";
import {
  CONTENT_SEARCH_MIN_QUERY,
  useContentSearch,
} from "./hooks/useContentSearch";
import { fuzzyBest } from "./lib/fuzzy";
import { MODE_HINTS, parseQuery } from "./lib/mode";
import { mruRank, mruSnapshot, recordUse } from "./lib/mru";
import type { PaletteItem } from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: "commands" | "content";
  commandItems: PaletteItem[];
  workspaceRoot: string | null;
  onOpenContentHit: (path: string, line: number) => void;
  insertCommand: ((cmd: string) => void) | null;
};

const SHORTCUTS_BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));
/**
 * How long the pointer may rest on a row before the shell adopts it.
 *
 * Both lists preview on hover - a theme repaints, a shape redraws the panes - and both wait, because
 * walking the pointer down a list of six or thirty would otherwise rewrite the window on every row it
 * crosses.
 */
const PREVIEW_DELAY_MS = 140;

export const CommandPalette = memo(function CommandPalette({
  open,
  onOpenChange,
  initialMode,
  commandItems,
  workspaceRoot,
  onOpenContentHit,
  insertCommand,
}: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [value, setValue] = useState("");
  const [page, setPage] = useState<"root" | "themes" | "shapes">("root");
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const {
    themeId,
    customThemes,
    setThemeId,
    previewThemeId,
    shapePref,
    radius,
    setShapeId,
    previewShape,
  } = useTheme();

  const parsed = parseQuery(query);
  // The two pickers are pages of their own: while one is open the palette offers its choices and
  // nothing else, so the query filters that list rather than the commands.
  const inThemes = page === "themes";
  const inShapes = page === "shapes";
  const inPicker = inThemes || inShapes;
  const themeFilter = inThemes ? query.trim() : "";

  const content = useContentSearch(
    workspaceRoot,
    parsed.term,
    open && page === "root" && parsed.mode === "content",
  );
  const history = useCommandHistory(
    parsed.term,
    open && page === "root" && parsed.mode === "history",
  );

  const mru = useMemo(() => (open ? mruSnapshot() : {}), [open]);

  const rankedCommands = useMemo(() => {
    if (inPicker || parsed.mode !== "commands") return [];
    return rankCommands(commandItems, parsed.term, mru, t);
  }, [commandItems, parsed.term, parsed.mode, inPicker, mru, t]);

  const themes = useMemo(() => {
    if (!inThemes) return [];
    const all = [...listBuiltinThemes(), ...customThemes];
    const q = themeFilter.toLowerCase();
    if (!q) return all;
    return all
      .map((t) => ({ t, s: fuzzyBest(q, [t.name, t.id]) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
      .map((x) => x.t);
  }, [inThemes, themeFilter, customThemes]);

  const shapes = useMemo(() => {
    if (!inShapes) return [];
    const all = listShapes();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all
      .map((id) => ({ id, s: fuzzyBest(q, [t(SHAPE_LABELS[id]), id]) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0))
      .map((x) => x.id);
  }, [inShapes, query, t]);

  const resetPalette = useCallback(() => {
    setQuery("");
    setValue("");
    setPage("root");
    previewThemeId(null);
    previewShape(null);
  }, [previewThemeId, previewShape]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetPalette();
      onOpenChange(next);
    },
    [onOpenChange, resetPalette],
  );

  useEffect(() => {
    if (!open) return;
    setQuery(initialMode === "content" ? "#" : "");
    setPage("root");
    const handle = window.setTimeout(() => {
      document.getElementById("verta-command-palette-input")?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open, initialMode]);

  useEffect(() => {
    if (!inThemes || !value.startsWith("theme:")) return;
    const id = value.slice("theme:".length);
    if (id === "back") return;
    const handle = window.setTimeout(
      () => previewThemeId(id),
      PREVIEW_DELAY_MS,
    );
    return () => window.clearTimeout(handle);
  }, [value, inThemes, previewThemeId]);

  useEffect(() => {
    if (!inShapes || !value.startsWith("shape:")) return;
    const id = value.slice("shape:".length);
    if (id === "back") return;
    const handle = window.setTimeout(
      () => previewShape(id as ShapeId),
      PREVIEW_DELAY_MS,
    );
    return () => window.clearTimeout(handle);
  }, [value, inShapes, previewShape]);

  const runAfterClose = useCallback(
    (fn: () => void) => {
      handleOpenChange(false);
      window.setTimeout(fn, 0);
    },
    [handleOpenChange],
  );

  const enterThemes = useCallback(() => {
    setPage("themes");
    setQuery("");
    setValue("");
  }, []);

  const enterShapes = useCallback(() => {
    setPage("shapes");
    setQuery("");
    setValue("");
  }, []);

  const leavePicker = useCallback(() => {
    previewThemeId(null);
    previewShape(null);
    setPage("root");
    setQuery("");
    setValue("");
  }, [previewThemeId, previewShape]);

  const runCommand = useCallback(
    (item: PaletteItem) => {
      if (item.disabledReason) return;
      if (item.id === "theme.pick") return enterThemes();
      if (item.id === "shape.pick") return enterShapes();
      if (item.id === "search.content") return setQuery("#");
      if (item.id === "history.open") return setQuery(">");
      recordUse(item.id);
      runAfterClose(item.run);
    },
    [enterThemes, enterShapes, runAfterClose],
  );

  const openContent = useCallback(
    (path: string, line: number) => {
      runAfterClose(() => onOpenContentHit(path, line));
    },
    [onOpenContentHit, runAfterClose],
  );

  const runHistory = useCallback(
    (cmd: string) => {
      if (!insertCommand) return;
      runAfterClose(() => insertCommand(cmd));
    },
    [insertCommand, runAfterClose],
  );

  const commitTheme = useCallback(
    (id: string) => {
      setThemeId(id);
      handleOpenChange(false);
    },
    [setThemeId, handleOpenChange],
  );

  const commitShape = useCallback(
    (id: ShapeId) => {
      setShapeId(id);
      handleOpenChange(false);
    },
    [setShapeId, handleOpenChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!inPicker) return;
      if (e.key === "Escape" || (e.key === "Backspace" && query.length === 0)) {
        e.preventDefault();
        e.stopPropagation();
        leavePicker();
      }
    },
    [inPicker, query, leavePicker],
  );

  const placeholder = inThemes
    ? t("palette.placeholder.themes")
    : inShapes
      ? t("palette.placeholder.shapes")
      : parsed.mode === "content"
        ? t("palette.placeholder.content")
        : parsed.mode === "history"
          ? t("palette.placeholder.history")
          : t("palette.placeholder.command");

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t("palette.title")}
      description={t("palette.description")}
      className="top-1/2 w-[min(680px,calc(100vw-32px))] -translate-y-1/2"
      // Escape leaves a picker page and closes the palette only from the commands. Without this the
      // dialog's own capture-phase listener wins and the whole palette goes away, which is what used
      // to happen on the theme page too - the key looked broken rather than one level up.
      onEscapeKeyDown={(event) => {
        if (page === "root") return;
        event.preventDefault();
        leavePicker();
      }}
    >
      <Command
        shouldFilter={false}
        loop
        value={value}
        onValueChange={setValue}
        onKeyDown={onKeyDown}
      >
        <CommandInput
          id="verta-command-palette-input"
          value={query}
          onValueChange={setQuery}
          placeholder={placeholder}
          autoFocus
        />
        <ScrollArea className="max-h-[420px]">
          <CommandList className="max-h-none overflow-visible pr-3">
            {inThemes ? (
              <CommandGroup heading={t("palette.group.themes")}>
                <CommandItem
                  value="theme:back"
                  onSelect={leavePicker}
                  className="text-[12.5px]"
                >
                  <HugeiconsIcon
                    icon={ArrowTurnBackwardIcon}
                    size={14}
                    strokeWidth={1.75}
                  />
                  <span>{t("palette.back")}</span>
                </CommandItem>
                {themes.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`theme:${t.id}`}
                    onSelect={() => commitTheme(t.id)}
                    className="text-[12.5px]"
                  >
                    <span className="truncate">{t.name}</span>
                    {t.id === themeId ? (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={14}
                        strokeWidth={2}
                        className="ml-auto text-muted-foreground"
                      />
                    ) : null}
                  </CommandItem>
                ))}
                {themes.length === 0 ? (
                  <StatusItem label={t("palette.noThemes")} />
                ) : null}
              </CommandGroup>
            ) : inShapes ? (
              <CommandGroup heading={t("palette.group.shapes")}>
                <CommandItem
                  value="shape:back"
                  onSelect={leavePicker}
                  className="text-[12.5px]"
                >
                  <HugeiconsIcon
                    icon={ArrowTurnBackwardIcon}
                    size={14}
                    strokeWidth={1.75}
                  />
                  <span>{t("palette.back")}</span>
                </CommandItem>
                {/* Each row draws itself, with the corners the current radius stop gives it: the
                    same reason the settings picker does - the words 无界 and 极简 are the only thing
                    telling two borderless choices apart otherwise, and a picture says it faster. */}
                {shapes.map((id) => (
                  <CommandItem
                    key={id}
                    value={`shape:${id}`}
                    onSelect={() => commitShape(id)}
                    className="text-[12.5px]"
                  >
                    <ShapeIcon shape={id} radius={radius} className="shrink-0" />
                    <span className="truncate">{t(SHAPE_LABELS[id])}</span>
                    {id === shapePref ? (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={14}
                        strokeWidth={2}
                        className="ml-auto text-muted-foreground"
                      />
                    ) : null}
                  </CommandItem>
                ))}
                {shapes.length === 0 ? (
                  <StatusItem label={t("palette.noMatches")} />
                ) : null}
              </CommandGroup>
            ) : parsed.mode === "commands" ? (
              rankedCommands.length === 0 ? (
                <EmptyHint />
              ) : (
                COMMAND_GROUPS.map((group) => {
                  const rows = rankedCommands.filter((a) => a.group === group);
                  if (rows.length === 0) return null;
                  return (
                    <CommandGroup key={group} heading={t(group)}>
                      {rows.map((item) => (
                        <ActionItem
                          key={item.id}
                          item={item}
                          shortcutLabel={formatShortcut(
                            item.shortcutId,
                            userShortcuts,
                          )}
                          onRun={() => runCommand(item)}
                        />
                      ))}
                    </CommandGroup>
                  );
                })
              )
            ) : parsed.mode === "content" ? (
              <CommandGroup heading={t("palette.group.contents")}>
                {!workspaceRoot ? (
                  <StatusItem label={t("palette.noWorkspaceRoot")} />
                ) : parsed.term.length < CONTENT_SEARCH_MIN_QUERY ? (
                  <StatusItem label={t("palette.typeMore")} />
                ) : (
                  <AsyncBody
                    loading={content.loading}
                    error={content.error}
                    empty={content.results.length === 0}
                    emptyLabel={t("palette.noMatches")}
                    onRetry={content.retry}
                  >
                    {content.results.map((hit) => (
                      <CommandItem
                        key={`${hit.path}:${hit.line}`}
                        value={`content:${hit.path}:${hit.line}`}
                        onSelect={() => openContent(hit.path, hit.line)}
                        className="text-[12.5px]"
                      >
                        <FileIcon
                          name={basename(hit.rel)}
                          className="size-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                          {hit.text.trim()}
                        </span>
                        <span className="ml-auto max-w-64 shrink-0 truncate text-[11px] font-normal text-muted-foreground">
                          {hit.rel}:{hit.line}
                        </span>
                      </CommandItem>
                    ))}
                  </AsyncBody>
                )}
              </CommandGroup>
            ) : parsed.mode === "history" ? (
              <CommandGroup heading={t("palette.group.history")}>
                {!insertCommand ? (
                  <StatusItem label={t("palette.openTerminal")} />
                ) : (
                  <AsyncBody
                    loading={history.loading}
                    error={history.error}
                    empty={history.results.length === 0}
                    emptyLabel={t("palette.noHistory")}
                    onRetry={history.retry}
                  >
                    {history.results.map((cmd) => (
                      <CommandItem
                        key={`hist:${cmd}`}
                        value={`hist:${cmd}`}
                        onSelect={() => runHistory(cmd)}
                        className="text-[12.5px]"
                      >
                        <HugeiconsIcon
                          icon={TerminalIcon}
                          size={14}
                          strokeWidth={1.75}
                          className="text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                          {cmd}
                        </span>
                      </CommandItem>
                    ))}
                  </AsyncBody>
                )}
              </CommandGroup>
            ) : (
              <CommandGroup heading={t("palette.searchModes")}>
                {MODE_HINTS.map((hint) => (
                  <CommandItem
                    key={hint.sigil}
                    value={`hint:${hint.sigil}`}
                    onSelect={() => setQuery(hint.sigil)}
                    className="text-[12.5px]"
                  >
                    <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {hint.sigil}
                    </kbd>
                    <span>{t(hint.labelKey)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </ScrollArea>
      </Command>
    </CommandDialog>
  );
});

function rankCommands(
  items: PaletteItem[],
  term: string,
  mru: Record<string, number>,
  lookup: (key: MessageKey, values?: Record<string, string | number>) => string,
): PaletteItem[] {
  if (!term) {
    return [...items].sort((a, b) => mruRank(mru, b.id) - mruRank(mru, a.id));
  }
  const scored: { item: PaletteItem; s: number }[] = [];
  for (const item of items) {
    // Match what is on screen: titles and group headings are keys now, so
    // searching the raw key would never find the translated "Settings" title.
    const visibleTitle = lookup(item.title);
    const visibleGroup = lookup(item.group);
    const s = fuzzyBest(term, [
      visibleTitle,
      visibleGroup,
      ...(item.keywords ?? []),
      // Some rows answer to words that are not in their title: "the terminal tab"
      // is what you call the row that closes one. Aliases come from the shortcut
      // catalogue so the settings list and this palette agree.
      ...(item.shortcutId ? (SHORTCUT_ALIASES[item.shortcutId] ?? []) : []),
    ]);
    if (s !== null) scored.push({ item, s });
  }
  scored.sort(
    (a, b) => b.s - a.s || mruRank(mru, b.item.id) - mruRank(mru, a.item.id),
  );
  return scored.map((x) => x.item);
}

function ActionItem({
  item,
  shortcutLabel,
  onRun,
}: {
  item: PaletteItem;
  shortcutLabel: string | null;
  onRun: () => void;
}) {
  const t = useT();
  const rightLabel = item.disabledReason
    ? t(item.disabledReason as MessageKey)
    : (item.trailing ?? shortcutLabel);
  return (
    <CommandItem
      value={`cmd:${item.id}`}
      disabled={!!item.disabledReason}
      onSelect={onRun}
      className="text-[12.5px]"
    >
      {item.icon ? (
        <HugeiconsIcon
          icon={item.icon}
          size={14}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
      ) : null}
      <span className="truncate">{t(item.title)}</span>
      {rightLabel ? (
        <CommandShortcut
          className={item.disabledReason ? "normal-case tracking-normal" : ""}
        >
          {rightLabel}
        </CommandShortcut>
      ) : null}
    </CommandItem>
  );
}

function AsyncBody({
  loading,
  error,
  empty,
  emptyLabel,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyLabel: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  if (error) {
    return (
      <>
        <StatusItem label={t("palette.searchFailed")} tone="error" />
        <CommandItem value="retry" onSelect={onRetry} className="text-[12.5px]">
          <span>{t("palette.retry")}</span>
        </CommandItem>
      </>
    );
  }
  if (empty && loading) return <StatusItem label={t("palette.searching")} />;
  if (empty) return <StatusItem label={emptyLabel} />;
  return <>{children}</>;
}

function StatusItem({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "muted" | "error";
}) {
  return (
    <CommandItem
      value={`status:${label}`}
      disabled
      className="text-[12.5px] font-normal"
    >
      {tone === "error" ? (
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={14}
          strokeWidth={1.75}
          className="text-destructive"
        />
      ) : null}
      <span
        className={
          tone === "error" ? "text-destructive" : "text-muted-foreground"
        }
      >
        {label}
      </span>
    </CommandItem>
  );
}

function EmptyHint() {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
      <HugeiconsIcon icon={CommandIcon} size={18} strokeWidth={1.5} />
      <span>{t("palette.empty")}</span>
    </div>
  );
}

function basename(rel: string): string {
  const parts = rel.split(/[\\/]/);
  return parts[parts.length - 1] || rel;
}

function formatShortcut(
  shortcutId: ShortcutId | undefined,
  userShortcuts: Record<ShortcutId, KeyBinding[]>,
): string | null {
  if (!shortcutId) return null;
  const shortcut = SHORTCUTS_BY_ID.get(shortcutId);
  const bindings = userShortcuts[shortcutId] ?? shortcut?.defaultBindings;
  const tokens = getBindingTokens(bindings?.[0]);
  return tokens.length ? tokens.join(" ") : null;
}
