import type { LanguagePref } from "@/modules/i18n/language";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import {
  type AgentStateDot,
  DEFAULT_STATE_COLOURS,
  STATE_COLOUR_TOKENS,
  type StateColourToken,
} from "@/modules/terminal/agentStateColours";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

export const DEFAULT_THEME_ID = "verta-default";

export type BackgroundKind = "none" | "image";

export type TerminalCursorStyle = "bar" | "block" | "underline";

/**
 * How much a session list row says at rest. `compact` keeps the title and moves the numbers
 * and the directory into a popup; `standard` is the two-line row every install already shows.
 */
export type SessionListDensity = "standard" | "compact";

export const EDITOR_THEMES = [
  "kanagawa",
  "kanagawa-lotus",
  "kanagawa-dragon",
  "tokyo-night",
  "catppuccin-mocha",
  "catppuccin-latte",
  "rose-pine",
  "rose-pine-dawn",
  "everforest",
  "everforest-light",
  "dracula",
  "solarized-dark",
  "solarized-light",
  "nord",
  "gruvbox-dark",
  "atomone",
  "aura",
  "copilot",
  "github-dark",
  "github-light",
  "xcode-dark",
  "xcode-light",
] as const;

export type EditorThemeId = (typeof EDITOR_THEMES)[number];

/** "auto" follows the active app theme's editorTheme pairing (resolved live). */
export const EDITOR_THEME_AUTO = "auto" as const;
export type EditorThemePref = typeof EDITOR_THEME_AUTO | EditorThemeId;

export function isEditorThemeId(v: unknown): v is EditorThemeId {
  return (
    typeof v === "string" && (EDITOR_THEMES as readonly string[]).includes(v)
  );
}

export const EDITOR_THEME_MODE: Record<EditorThemeId, "light" | "dark"> = {
  kanagawa: "dark",
  "kanagawa-lotus": "light",
  "kanagawa-dragon": "dark",
  "tokyo-night": "dark",
  "catppuccin-mocha": "dark",
  "catppuccin-latte": "light",
  "rose-pine": "dark",
  "rose-pine-dawn": "light",
  everforest: "dark",
  "everforest-light": "light",
  dracula: "dark",
  "solarized-dark": "dark",
  "solarized-light": "light",
  nord: "dark",
  "gruvbox-dark": "dark",
  atomone: "dark",
  aura: "dark",
  copilot: "dark",
  "github-dark": "dark",
  "github-light": "light",
  "xcode-dark": "dark",
  "xcode-light": "light",
};

export const EDITOR_THEME_LABELS: Record<EditorThemeId, string> = {
  kanagawa: "Kanagawa Wave",
  "kanagawa-lotus": "Kanagawa Lotus",
  "kanagawa-dragon": "Kanagawa Dragon",
  "tokyo-night": "Tokyo Night",
  "catppuccin-mocha": "Catppuccin Mocha",
  "catppuccin-latte": "Catppuccin Latte",
  "rose-pine": "Rosé Pine",
  "rose-pine-dawn": "Rosé Pine Dawn",
  everforest: "Everforest Dark",
  "everforest-light": "Everforest Light",
  dracula: "Dracula",
  "solarized-dark": "Solarized Dark",
  "solarized-light": "Solarized Light",
  nord: "Nord",
  "gruvbox-dark": "Gruvbox Dark",
  atomone: "Atom One",
  aura: "Aura",
  copilot: "Copilot",
  "github-dark": "GitHub Dark",
  "github-light": "GitHub Light",
  "xcode-dark": "Xcode Dark",
  "xcode-light": "Xcode Light",
};

/** Which animation the session-opening transition uses (chosen under Settings → Themes). */
export type SessionTransitionId =
  | "ripples"
  | "pulse"
  | "orbit"
  | "bars"
  | "none";

/** The order here is the order in settings, with the default first. */
export const SESSION_TRANSITIONS: readonly SessionTransitionId[] = [
  "ripples",
  "pulse",
  "orbit",
  "bars",
  "none",
];

/** A stored value may come from another version: fall back to the default when unknown. */
export function coerceSessionTransition(value: unknown): SessionTransitionId {
  return typeof value === "string" &&
    (SESSION_TRANSITIONS as readonly string[]).includes(value)
    ? (value as SessionTransitionId)
    : DEFAULT_PREFERENCES.sessionTransition;
}

export type Preferences = {
  theme: ThemePref;
  themeId: string;
  backgroundKind: BackgroundKind;
  backgroundImageId: string | null;
  backgroundOpacity: number;
  backgroundBlur: number;
  windowVibrancy: boolean;
  editorTheme: EditorThemePref;
  editorFontSize: number;
  vimMode: boolean;
  editorWordWrap: boolean;
  editorWordWrapColumn: number;
  showHidden: boolean;
  explorerGitDecorations: boolean;
  /** How much a session row says at rest; see `SessionListDensity`. */
  sessionListDensity: SessionListDensity;
  /**
   * The colour each agent state is drawn in, on a tab chip and on a session list row alike.
   *
   * A fixed set of hues rather than a colour picker: the marker is six pixels across and the colour
   * is what the user reads from across the window, so a set known to be legible on both palettes is
   * worth more here than the freedom to choose anything.
   */
  agentStateColours: Record<AgentStateDot, StateColourToken>;
  /** Hide the main window in the tray when its close button is pressed. */
  closeToTray: boolean;
  /** Flash that button when an agent asks for input or finishes. */
  taskbarAttentionFlash: boolean;
  /**
   * Send a system notification when an agent is waiting on you, or a turn ends while the
   * window is not in front. The two surfaces have a switch each: the taskbar flash above
   * stays whatever it is set to.
   */
  desktopNotifications: boolean;
  terminalRenderer: "auto" | "webgl";
  terminalScreenReader: boolean;
  terminalCursorBlink: boolean;
  terminalCursorStyle: TerminalCursorStyle;
  /**
   * The font shared by terminal and editor (a single setting). Empty means
   * auto-detect the local Nerd Font; the key keeps the old `terminalFontFamily` name
   * so already-stored config needs no migration.
   */
  terminalFontFamily: string;
  terminalFontWeight: string;
  terminalShell: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  confirmCloseRunningTerminal: boolean;
  lastWslDistro: string | null;
  /** Whether Verta also lists WSL projects and sessions. Off by default, so a
   * fresh install never reaches into a distro until asked. */
  wslEnabled: boolean;
  /** What turning the switch off does. `false` only stops Verta's own queries;
   * `true` runs `wsl --shutdown`, which also ends whatever else runs in WSL. */
  wslShutdownOnDisable: boolean;
  zoomLevel: number;
  /**
   * Interface language. `system` follows the OS locale, which is what a fresh
   * install should do; the explicit values are the user overriding it.
   */
  language: LanguagePref;
  defaultWorkspaceEnv: string;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  editorAutoSave: boolean;
  editorAutoSaveDelay: number;
  editorFormatOnSave: boolean;
  editorFormatter: EditorFormatter;
  /** languageResolver id -> formatter, overriding the global default. */
  editorFormatterByLang: Record<string, EditorFormatter>;
  /** Shell template for the "custom" formatter; {file} is the quoted path. */
  editorCustomFormatCommand: string;
  lspActivation: Record<string, LspActivation>;
  lspCustomServers: LspCustomServer[];
  /** Which animation the session-opening transition uses; `none` disables it. */
  sessionTransition: SessionTransitionId;
};

export type EditorFormatter =
  | "lsp"
  | "biome"
  | "prettier"
  | "ruff"
  | "rustfmt"
  | "gofmt"
  | "clang-format"
  | "shfmt"
  | "zigfmt"
  | "custom";

export type LspActivation = "enabled" | "dismissed";

export type LspCustomServer = {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** languageResolver id -> LSP languageId */
  languages: Record<string, string>;
  rootMarkers: string[];
};

const STORE_PATH = "verta-settings.json";
const KEY_THEME = "theme";
const KEY_THEME_ID = "themeId";
const KEY_BG_KIND = "backgroundKind";
const KEY_BG_IMAGE_ID = "backgroundImageId";
const KEY_BG_OPACITY = "backgroundOpacity";
const KEY_BG_BLUR = "backgroundBlur";
const KEY_WINDOW_VIBRANCY = "windowVibrancy";
const KEY_EDITOR_THEME = "editorTheme";
const KEY_SESSION_TRANSITION = "sessionTransition";
const KEY_EDITOR_FONT_SIZE = "editorFontSize";
const KEY_VIM_MODE = "vimMode";
const KEY_EDITOR_WORD_WRAP = "editorWordWrap";
const KEY_EDITOR_WORD_WRAP_COLUMN = "editorWordWrapColumn";
const KEY_SHOW_HIDDEN = "showHidden";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_WSL_ENABLED = "wslEnabled";
const KEY_WSL_SHUTDOWN_ON_DISABLE = "wslShutdownOnDisable";
const KEY_EXPLORER_GIT_DECORATIONS = "explorerGitDecorations";
const KEY_SESSION_LIST_DENSITY = "sessionListDensity";
const KEY_AGENT_STATE_COLOURS = "agentStateColours";
const KEY_CLOSE_TO_TRAY = "closeToTray";
const KEY_TASKBAR_ATTENTION_FLASH = "taskbarAttentionFlash";
const KEY_DESKTOP_NOTIFICATIONS = "desktopNotifications";
const KEY_TERMINAL_RENDERER = "terminalRenderer";
const KEY_TERMINAL_SCREEN_READER = "terminalScreenReader";
const KEY_TERMINAL_CURSOR_BLINK = "terminalCursorBlink";
const KEY_TERMINAL_CURSOR_STYLE = "terminalCursorStyle";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_FONT_WEIGHT = "terminalFontWeight";
const KEY_TERMINAL_SHELL = "terminalShell";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_CONFIRM_CLOSE_RUNNING_TERMINAL = "confirmCloseRunningTerminal";
const KEY_LAST_WSL_DISTRO = "lastWslDistro";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_LANGUAGE = "language";
const KEY_DEFAULT_WORKSPACE_ENV = "defaultWorkspaceEnv";
const KEY_SHORTCUTS = "shortcuts";
const KEY_EDITOR_AUTO_SAVE = "editorAutoSave";
const KEY_EDITOR_AUTO_SAVE_DELAY = "editorAutoSaveDelay";
const KEY_EDITOR_FORMAT_ON_SAVE = "editorFormatOnSave";
const KEY_EDITOR_FORMATTER = "editorFormatter";
const KEY_EDITOR_FORMATTER_BY_LANG = "editorFormatterByLang";
const KEY_EDITOR_CUSTOM_FORMAT_COMMAND = "editorCustomFormatCommand";
const KEY_LSP_ACTIVATION = "lspActivation";
const KEY_LSP_CUSTOM_SERVERS = "lspCustomServers";

const TERMINAL_FONT_SIZE_DEFAULT = 14;
const TERMINAL_FONT_SIZE_MIN = 8;
const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_FONT_SIZE_DEFAULT = 13;
export const EDITOR_FONT_SIZE_MIN = 8;
export const EDITOR_FONT_SIZE_MAX = 32;
export const EDITOR_FONT_SIZES = [
  10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const EDITOR_WORD_WRAP_COLUMN_DEFAULT = 80;
export const EDITOR_WORD_WRAP_COLUMN_MIN = 20;
export const EDITOR_WORD_WRAP_COLUMN_MAX = 500;

const TERMINAL_SCROLLBACK_DEFAULT = 2000;
const TERMINAL_SCROLLBACK_MIN = 200;
const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  themeId: DEFAULT_THEME_ID,
  backgroundKind: "none",
  backgroundImageId: null,
  backgroundOpacity: 0.5,
  backgroundBlur: 0,
  editorTheme: EDITOR_THEME_AUTO,
  // Other themes bring their own transition; only the newly added variants are picked
  // here, with ripples as the default.
  sessionTransition: "ripples",
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  // Off by default: a translucent window keeps the compositor blending the
  // whole frame every present. An explicitly stored choice (either value)
  // always wins; only an absent key falls back to this.
  windowVibrancy: false,
  vimMode: false,
  editorWordWrap: false,
  editorWordWrapColumn: EDITOR_WORD_WRAP_COLUMN_DEFAULT,
  showHidden: false,
  explorerGitDecorations: true,
  sessionListDensity: "standard",
  // The colours the interface has always spoken with. Absent means these, so an install that has
  // never opened the setting draws exactly what it drew before it existed.
  agentStateColours: DEFAULT_STATE_COLOURS,
  closeToTray: true,
  taskbarAttentionFlash: true,
  desktopNotifications: true,
  terminalRenderer: "auto",
  terminalScreenReader: false,
  terminalCursorBlink: false,
  terminalCursorStyle: "bar",
  terminalFontFamily: "Cascadia Code",
  terminalFontWeight: "normal",
  terminalShell: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  confirmCloseRunningTerminal: true,
  lastWslDistro: null,
  wslEnabled: false,
  wslShutdownOnDisable: false,
  zoomLevel: 1.0,
  language: "system",
  defaultWorkspaceEnv: "local",
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  editorAutoSave: false,
  editorAutoSaveDelay: 1000,
  editorFormatOnSave: false,
  editorFormatter: "lsp",
  editorFormatterByLang: {},
  editorCustomFormatCommand: "",
  lspActivation: {},
  lspCustomServers: [],
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "verta://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip: fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;
  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    themeId: get<string>(KEY_THEME_ID) ?? DEFAULT_PREFERENCES.themeId,
    backgroundKind:
      get<BackgroundKind>(KEY_BG_KIND) ?? DEFAULT_PREFERENCES.backgroundKind,
    backgroundImageId:
      get<string | null>(KEY_BG_IMAGE_ID) ??
      DEFAULT_PREFERENCES.backgroundImageId,
    backgroundOpacity: clampBgOpacity(
      get<number>(KEY_BG_OPACITY) ?? DEFAULT_PREFERENCES.backgroundOpacity,
    ),
    backgroundBlur: clampBlur(
      get<number>(KEY_BG_BLUR) ?? DEFAULT_PREFERENCES.backgroundBlur,
    ),
    editorTheme: ((): EditorThemePref => {
      const stored = get<string>(KEY_EDITOR_THEME);
      if (stored === EDITOR_THEME_AUTO || isEditorThemeId(stored))
        return stored;
      return DEFAULT_PREFERENCES.editorTheme;
    })(),
    sessionTransition: coerceSessionTransition(
      get<string>(KEY_SESSION_TRANSITION),
    ),
    editorFontSize: clampEditorFontSize(
      get<number>(KEY_EDITOR_FONT_SIZE) ?? DEFAULT_PREFERENCES.editorFontSize,
    ),
    windowVibrancy:
      get<boolean>(KEY_WINDOW_VIBRANCY) ?? DEFAULT_PREFERENCES.windowVibrancy,
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    editorWordWrap:
      get<boolean>(KEY_EDITOR_WORD_WRAP) ?? DEFAULT_PREFERENCES.editorWordWrap,
    editorWordWrapColumn: clampEditorWordWrapColumn(
      get<number>(KEY_EDITOR_WORD_WRAP_COLUMN) ??
        DEFAULT_PREFERENCES.editorWordWrapColumn,
    ),
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    explorerGitDecorations:
      get<boolean>(KEY_EXPLORER_GIT_DECORATIONS) ??
      DEFAULT_PREFERENCES.explorerGitDecorations,
    closeToTray:
      get<boolean>(KEY_CLOSE_TO_TRAY) ?? DEFAULT_PREFERENCES.closeToTray,
    taskbarAttentionFlash:
      get<boolean>(KEY_TASKBAR_ATTENTION_FLASH) ??
      DEFAULT_PREFERENCES.taskbarAttentionFlash,
    desktopNotifications:
      get<boolean>(KEY_DESKTOP_NOTIFICATIONS) ??
      DEFAULT_PREFERENCES.desktopNotifications,
    terminalRenderer:
      get<string>(KEY_TERMINAL_RENDERER) === "webgl" ? "webgl" : "auto",
    sessionListDensity: coerceSessionListDensity(
      get<string>(KEY_SESSION_LIST_DENSITY),
    ),
    agentStateColours: coerceAgentStateColours(
      get<unknown>(KEY_AGENT_STATE_COLOURS),
    ),
    terminalScreenReader: get<boolean>(KEY_TERMINAL_SCREEN_READER) === true,
    terminalCursorBlink:
      get<boolean>(KEY_TERMINAL_CURSOR_BLINK) ??
      DEFAULT_PREFERENCES.terminalCursorBlink,
    terminalCursorStyle: coerceTerminalCursorStyle(
      get<unknown>(KEY_TERMINAL_CURSOR_STYLE),
    ),
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalFontWeight: coerceFontWeight(
      get<string>(KEY_TERMINAL_FONT_WEIGHT) ??
        DEFAULT_PREFERENCES.terminalFontWeight,
    ),
    terminalShell:
      get<string>(KEY_TERMINAL_SHELL) ?? DEFAULT_PREFERENCES.terminalShell,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    confirmCloseRunningTerminal:
      get<boolean>(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL) ??
      DEFAULT_PREFERENCES.confirmCloseRunningTerminal,
    lastWslDistro:
      get<string | null>(KEY_LAST_WSL_DISTRO) ??
      DEFAULT_PREFERENCES.lastWslDistro,
    wslEnabled: get<boolean>(KEY_WSL_ENABLED) ?? DEFAULT_PREFERENCES.wslEnabled,
    wslShutdownOnDisable:
      get<boolean>(KEY_WSL_SHUTDOWN_ON_DISABLE) ??
      DEFAULT_PREFERENCES.wslShutdownOnDisable,
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    language: get<LanguagePref>(KEY_LANGUAGE) ?? DEFAULT_PREFERENCES.language,
    defaultWorkspaceEnv:
      get<string>(KEY_DEFAULT_WORKSPACE_ENV) ??
      DEFAULT_PREFERENCES.defaultWorkspaceEnv,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    editorAutoSave:
      get<boolean>(KEY_EDITOR_AUTO_SAVE) ?? DEFAULT_PREFERENCES.editorAutoSave,
    editorAutoSaveDelay: clampAutoSaveDelay(
      get<number>(KEY_EDITOR_AUTO_SAVE_DELAY) ??
        DEFAULT_PREFERENCES.editorAutoSaveDelay,
    ),
    editorFormatOnSave:
      get<boolean>(KEY_EDITOR_FORMAT_ON_SAVE) ??
      DEFAULT_PREFERENCES.editorFormatOnSave,
    editorFormatter:
      get<EditorFormatter>(KEY_EDITOR_FORMATTER) ??
      DEFAULT_PREFERENCES.editorFormatter,
    editorFormatterByLang:
      get<Record<string, EditorFormatter>>(KEY_EDITOR_FORMATTER_BY_LANG) ??
      DEFAULT_PREFERENCES.editorFormatterByLang,
    editorCustomFormatCommand:
      get<string>(KEY_EDITOR_CUSTOM_FORMAT_COMMAND) ??
      DEFAULT_PREFERENCES.editorCustomFormatCommand,
    lspActivation:
      get<Record<string, LspActivation>>(KEY_LSP_ACTIVATION) ??
      DEFAULT_PREFERENCES.lspActivation,
    lspCustomServers:
      get<LspCustomServer[]>(KEY_LSP_CUSTOM_SERVERS) ??
      DEFAULT_PREFERENCES.lspCustomServers,
  };
}

export async function setLspActivation(
  id: string,
  value: LspActivation | null,
): Promise<void> {
  const current =
    ((await store.get(KEY_LSP_ACTIVATION)) as Record<string, LspActivation>) ??
    {};
  const next = { ...current };
  if (value === null) delete next[id];
  else next[id] = value;
  await writePref(KEY_LSP_ACTIVATION, next);
}

export async function setLspCustomServers(
  value: LspCustomServer[],
): Promise<void> {
  await writePref(KEY_LSP_CUSTOM_SERVERS, value);
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setThemeId(value: string): Promise<void> {
  await writePref(KEY_THEME_ID, value);
}

/** Slider stores 0..1. Actual rendered opacity is halved in SurfaceLayer
 *  so the image never exceeds 50%, which keeps UI/terminal readable at any setting. */
export const BG_OPACITY_RENDER_FACTOR = 0.5;

function clampBgOpacity(v: number): number {
  if (!Number.isFinite(v)) return 0.7;
  return Math.min(1, Math.max(0, v));
}

function clampBlur(v: number): number {
  if (!Number.isFinite(v)) return 16;
  return Math.min(64, Math.max(0, Math.round(v)));
}

export async function setBackgroundKind(value: BackgroundKind): Promise<void> {
  await writePref(KEY_BG_KIND, value);
}

export async function setBackgroundImageId(
  value: string | null,
): Promise<void> {
  await writePref(KEY_BG_IMAGE_ID, value);
}

export async function setBackgroundOpacity(value: number): Promise<void> {
  await writePref(KEY_BG_OPACITY, clampBgOpacity(value));
}

export async function setBackgroundBlur(value: number): Promise<void> {
  await writePref(KEY_BG_BLUR, clampBlur(value));
}

export async function setEditorTheme(value: EditorThemePref): Promise<void> {
  await writePref(KEY_EDITOR_THEME, value);
}

/** Which animation the session-opening transition uses. */
export async function setSessionTransition(
  value: SessionTransitionId,
): Promise<void> {
  await writePref(KEY_SESSION_TRANSITION, value);
}

export function clampEditorFontSize(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_FONT_SIZE_DEFAULT;
  return Math.min(
    EDITOR_FONT_SIZE_MAX,
    Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)),
  );
}

export async function setEditorFontSize(value: number): Promise<void> {
  await writePref(KEY_EDITOR_FONT_SIZE, clampEditorFontSize(value));
}


export async function setWindowVibrancy(value: boolean): Promise<void> {
  await writePref(KEY_WINDOW_VIBRANCY, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setEditorWordWrap(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_WORD_WRAP, value);
}

export function clampEditorWordWrapColumn(value: number): number {
  if (!Number.isFinite(value)) return EDITOR_WORD_WRAP_COLUMN_DEFAULT;
  return Math.min(
    EDITOR_WORD_WRAP_COLUMN_MAX,
    Math.max(EDITOR_WORD_WRAP_COLUMN_MIN, Math.round(value)),
  );
}

export async function setEditorWordWrapColumn(value: number): Promise<void> {
  await writePref(
    KEY_EDITOR_WORD_WRAP_COLUMN,
    clampEditorWordWrapColumn(value),
  );
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setExplorerGitDecorations(value: boolean): Promise<void> {
  await writePref(KEY_EXPLORER_GIT_DECORATIONS, value);
}

export async function setCloseToTray(value: boolean): Promise<void> {
  await writePref(KEY_CLOSE_TO_TRAY, value);
}

export async function setTaskbarAttentionFlash(value: boolean): Promise<void> {
  await writePref(KEY_TASKBAR_ATTENTION_FLASH, value);
}

export async function setDesktopNotifications(value: boolean): Promise<void> {
  await writePref(KEY_DESKTOP_NOTIFICATIONS, value);
}

export async function setWslEnabled(value: boolean): Promise<void> {
  await writePref(KEY_WSL_ENABLED, value);
}

export async function setWslShutdownOnDisable(value: boolean): Promise<void> {
  await writePref(KEY_WSL_SHUTDOWN_ON_DISABLE, value);
}

export async function setTerminalRenderer(
  value: "auto" | "webgl",
): Promise<void> {
  await writePref(KEY_TERMINAL_RENDERER, value === "webgl" ? "webgl" : "auto");
}

export async function setTerminalScreenReader(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_SCREEN_READER, value);
}

export async function setTerminalCursorBlink(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_BLINK, value);
}

export function coerceTerminalCursorStyle(value: unknown): TerminalCursorStyle {
  return value === "bar" || value === "block" || value === "underline"
    ? value
    : DEFAULT_PREFERENCES.terminalCursorStyle;
}

export async function setTerminalCursorStyle(value: unknown): Promise<void> {
  await writePref(KEY_TERMINAL_CURSOR_STYLE, coerceTerminalCursorStyle(value));
}

/**
 * The session list's density. Only the one word turns it compact; anything else draws the
 * standard list, which is what every existing install shows and what a corrupt file has to
 * fall back to rather than a blank row.
 */
export function coerceSessionListDensity(value: unknown): SessionListDensity {
  return value === "compact" ? "compact" : DEFAULT_PREFERENCES.sessionListDensity;
}

export async function setSessionListDensity(value: unknown): Promise<void> {
  await writePref(KEY_SESSION_LIST_DENSITY, coerceSessionListDensity(value));
}

/**
 * The colour of every agent state, repaired one state at a time.
 *
 * A state the stored table does not name, or names with something that is not one of the hues, keeps
 * the colour it has always had; only that state is repaired, so a table with one bad entry loses one
 * entry rather than the user's other five choices. This is the single place the preference is made
 * safe, which is why the components that draw a marker index into it without a fallback of their own.
 */
export function coerceAgentStateColours(
  value: unknown,
): Record<AgentStateDot, StateColourToken> {
  const colours = { ...DEFAULT_STATE_COLOURS };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return colours;
  }
  const stored = value as Record<string, unknown>;
  for (const state of Object.keys(colours) as AgentStateDot[]) {
    const token = stored[state];
    if (
      typeof token === "string" &&
      (STATE_COLOUR_TOKENS as readonly string[]).includes(token)
    ) {
      colours[state] = token as StateColourToken;
    }
  }
  return colours;
}

/** Write the whole table; the caller has already decided which entry moved. */
export async function setAgentStateColours(value: unknown): Promise<void> {
  await writePref(KEY_AGENT_STATE_COLOURS, coerceAgentStateColours(value));
}

/**
 * Put every state back on the colour it has always had.
 *
 * Written out rather than removed: removing the key means the same thing to a reader, but it means
 * it through a fallback path, and "the user asked for the defaults" and "the user has never chosen"
 * are worth being able to tell apart in the file.
 */
export async function resetAgentStateColours(): Promise<void> {
  await setAgentStateColours(DEFAULT_STATE_COLOURS);
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

const TERMINAL_FONT_WEIGHT_VALUES = new Set(["normal", "500", "600", "bold"]);

export function coerceFontWeight(value: string): string {
  const v = value.trim();
  return TERMINAL_FONT_WEIGHT_VALUES.has(v) ? v : "normal";
}

export async function setTerminalFontWeight(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_WEIGHT, coerceFontWeight(value));
}

export async function setTerminalShell(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_SHELL, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(-10, Math.min(10, Math.round(value)))
    : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setConfirmCloseRunningTerminal(
  value: boolean,
): Promise<void> {
  await writePref(KEY_CONFIRM_CLOSE_RUNNING_TERMINAL, value);
}

export async function setLastWslDistro(value: string | null): Promise<void> {
  await writePref(KEY_LAST_WSL_DISTRO, value);
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export async function setLanguage(value: LanguagePref): Promise<void> {
  await writePref(KEY_LANGUAGE, value);
}

export const AUTO_SAVE_DELAY_MIN = 100;
export const AUTO_SAVE_DELAY_MAX = 60000;

export function clampAutoSaveDelay(v: number): number {
  if (!Number.isFinite(v)) return 1000;
  return Math.min(
    AUTO_SAVE_DELAY_MAX,
    Math.max(AUTO_SAVE_DELAY_MIN, Math.round(v)),
  );
}

export async function setEditorAutoSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE, value);
}

export async function setEditorAutoSaveDelay(value: number): Promise<void> {
  await writePref(KEY_EDITOR_AUTO_SAVE_DELAY, clampAutoSaveDelay(value));
}

export async function setEditorFormatOnSave(value: boolean): Promise<void> {
  await writePref(KEY_EDITOR_FORMAT_ON_SAVE, value);
}

export async function setEditorFormatter(
  value: EditorFormatter,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER, value);
}

export async function setEditorFormatterByLang(
  value: Record<string, EditorFormatter>,
): Promise<void> {
  await writePref(KEY_EDITOR_FORMATTER_BY_LANG, value);
}

export async function setEditorCustomFormatCommand(
  value: string,
): Promise<void> {
  await writePref(KEY_EDITOR_CUSTOM_FORMAT_COMMAND, value);
}

export async function setDefaultWorkspaceEnv(value: string): Promise<void> {
  await writePref(KEY_DEFAULT_WORKSPACE_ENV, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | Record<string, never>,
): Promise<void> {
  await writePref(KEY_SHORTCUTS, value);
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_THEME_ID]: "themeId",
    [KEY_BG_KIND]: "backgroundKind",
    [KEY_BG_IMAGE_ID]: "backgroundImageId",
    [KEY_BG_OPACITY]: "backgroundOpacity",
    [KEY_BG_BLUR]: "backgroundBlur",
    [KEY_WINDOW_VIBRANCY]: "windowVibrancy",
    [KEY_EDITOR_THEME]: "editorTheme",
    [KEY_SESSION_TRANSITION]: "sessionTransition",
    [KEY_EDITOR_FONT_SIZE]: "editorFontSize",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_EDITOR_WORD_WRAP]: "editorWordWrap",
    [KEY_EDITOR_WORD_WRAP_COLUMN]: "editorWordWrapColumn",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_WSL_ENABLED]: "wslEnabled",
    [KEY_WSL_SHUTDOWN_ON_DISABLE]: "wslShutdownOnDisable",
    [KEY_EXPLORER_GIT_DECORATIONS]: "explorerGitDecorations",
    [KEY_SESSION_LIST_DENSITY]: "sessionListDensity",
    [KEY_AGENT_STATE_COLOURS]: "agentStateColours",
    [KEY_CLOSE_TO_TRAY]: "closeToTray",
    [KEY_TASKBAR_ATTENTION_FLASH]: "taskbarAttentionFlash",
    [KEY_DESKTOP_NOTIFICATIONS]: "desktopNotifications",
    [KEY_TERMINAL_RENDERER]: "terminalRenderer",
    [KEY_TERMINAL_SCREEN_READER]: "terminalScreenReader",
    [KEY_TERMINAL_CURSOR_BLINK]: "terminalCursorBlink",
    [KEY_TERMINAL_CURSOR_STYLE]: "terminalCursorStyle",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_FONT_WEIGHT]: "terminalFontWeight",
    [KEY_TERMINAL_SHELL]: "terminalShell",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_CONFIRM_CLOSE_RUNNING_TERMINAL]: "confirmCloseRunningTerminal",
    [KEY_LAST_WSL_DISTRO]: "lastWslDistro",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_LANGUAGE]: "language",
    [KEY_DEFAULT_WORKSPACE_ENV]: "defaultWorkspaceEnv",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_EDITOR_AUTO_SAVE]: "editorAutoSave",
    [KEY_EDITOR_AUTO_SAVE_DELAY]: "editorAutoSaveDelay",
    [KEY_EDITOR_FORMAT_ON_SAVE]: "editorFormatOnSave",
    [KEY_EDITOR_FORMATTER]: "editorFormatter",
    [KEY_EDITOR_FORMATTER_BY_LANG]: "editorFormatterByLang",
    [KEY_EDITOR_CUSTOM_FORMAT_COMMAND]: "editorCustomFormatCommand",
    [KEY_LSP_ACTIVATION]: "lspActivation",
    [KEY_LSP_CUSTOM_SERVERS]: "lspCustomServers",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(
    PREFS_CHANGED_EVENT,
    (e) => {
      const mapped = map[e.payload.key];
      if (mapped) cb(mapped, e.payload.value);
    },
  );
  return () => {
    unsubLocal();
    unsubEvent();
  };
}
