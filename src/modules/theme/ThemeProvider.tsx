import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  DEFAULT_THEME_ID,
  loadPreferences,
  onPreferencesChange,
  setShapeId as persistShapeId,
  setTheme as persistTheme,
  setThemeId as persistThemeId,
  type ThemePref,
} from "@/modules/settings/store";
import {
  applyBoundless,
  applyRadius,
  applyShape,
  applyTheme,
} from "./applyTheme";
import {
  DEFAULT_RADIUS,
  radiusOf,
  type RadiusStop,
} from "./radius";
import {
  listCustomThemes,
  onCustomThemesChange,
} from "./customThemes";
import { SurfaceLayer } from "./SurfaceLayer";
import {
  resolveShape,
  resolveShapePref,
  type ShapeId,
  type ShapeMaterial,
  type ShapePref,
} from "./shape";
import { getBuiltinTheme, getDefaultTheme } from "./themes";
import type { Theme } from "./types";

export type { Theme };

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultMode?: ThemePref;
};

type ThemeProviderState = {
  mode: ThemePref;
  resolvedMode: "dark" | "light";
  themeId: string;
  activeTheme: Theme;
  customThemes: Theme[];
  /** The shape in force: a chosen one, the theme's suggestion, or the default. */
  shape: ShapeId;
  /** What the preference holds - `auto` until someone chooses - so a picker can mark the choice
   * rather than whatever the theme is suggesting. */
  shapePref: ShapePref;
  /** How round every corner is, the value the slider is on. */
  radius: RadiusStop;
  /** What the shape in force asks the window for: a material, a clear pane, or nothing. */
  shapeMaterial: ShapeMaterial | null;
  setMode: (mode: ThemePref) => void;
  /** Store a shape, the way the picker does. */
  setShapeId: (id: ShapeId) => void;
  setThemeId: (id: string) => void;
  /** Apply a theme transiently without persisting; null reverts to committed. */
  previewThemeId: (id: string | null) => void;
  /** The same for a shape, so a picker can show one before the choice is made. */
  previewShape: (id: ShapeId | null) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

const FAST_PATH_KEY = "verta-ui-theme-shadow";
const FAST_PATH_THEME_ID = "verta-ui-theme-id-shadow";

function readFastMode(fallback: ThemePref): ThemePref {
  if (typeof window === "undefined") return fallback;
  const v = window.localStorage.getItem(FAST_PATH_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : fallback;
}

function writeFastMode(t: ThemePref): void {
  try { window.localStorage.setItem(FAST_PATH_KEY, t); } catch { /* ignore */ }
}

function readFastThemeId(): string {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;
  return window.localStorage.getItem(FAST_PATH_THEME_ID) ?? DEFAULT_THEME_ID;
}

function writeFastThemeId(id: string): void {
  try { window.localStorage.setItem(FAST_PATH_THEME_ID, id); } catch { /* ignore */ }
}

function resolveTheme(id: string, custom: Theme[]): Theme {
  return custom.find((t) => t.id === id) ?? getBuiltinTheme(id) ?? getDefaultTheme();
}

export function ThemeProvider({ children, defaultMode = "system" }: ThemeProviderProps) {
  const [mode, setModeState] = useState<ThemePref>(() => readFastMode(defaultMode));
  const [themeId, setThemeIdState] = useState<string>(() => readFastThemeId());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewShapeId, setPreviewShapeId] = useState<ShapeId | null>(null);
  const [shapeId, setShapeIdState] = useState<ShapePref>("auto");
  const [radius, setRadiusState] = useState<RadiusStop>(DEFAULT_RADIUS);
  // The merged sheet, its own axis: hydrated with the rest and followed by key, like the radius.
  const [boundless, setBoundlessState] = useState(false);
  // The two recipes, kept apart: the acrylic pane and the glass pane are tuned on their own, because
  // what is behind them is not the same (blurred material versus a sharp desktop).
  const [glassPaneOpacity, setGlassPaneOpacity] = useState(0.3);
  const [glassEdge, setGlassEdge] = useState(0.3);
  const [glassSheen, setGlassSheen] = useState(0.15);
  const [acrylicPaneOpacity, setAcrylicPaneOpacity] = useState(0.2);
  const [acrylicEdge, setAcrylicEdge] = useState(0);
  const [acrylicSheen, setAcrylicSheen] = useState(0.15);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    let alive = true;
    void loadPreferences().then((p) => {
      if (!alive) return;
      setModeState(p.theme);
      setThemeIdState(p.themeId);
      setShapeIdState(p.shapeId);
      setRadiusState(p.cornerRadius);
      setBoundlessState(p.boundless);
      setGlassPaneOpacity(p.glassPaneOpacity);
      setGlassEdge(p.glassEdge);
      setGlassSheen(p.glassSheen);
      setAcrylicPaneOpacity(p.acrylicPaneOpacity);
      setAcrylicEdge(p.acrylicEdge);
      setAcrylicSheen(p.acrylicSheen);
      writeFastMode(p.theme);
      writeFastThemeId(p.themeId);
    });
    const unlistenP = onPreferencesChange((key, value) => {
      if (key === "theme" && (value === "system" || value === "light" || value === "dark")) {
        setModeState(value);
        writeFastMode(value);
      } else if (key === "themeId" && typeof value === "string") {
        setThemeIdState(value);
        writeFastThemeId(value);
      } else if (key === "shapeId" && typeof value === "string") {
        setShapeIdState(value as ShapePref);
      } else if (key === "boundless" && typeof value === "boolean") {
        setBoundlessState(value);
      } else if (key === "cornerRadius" && typeof value === "string") {
        setRadiusState(radiusOf(value));
      } else if (key === "glassPaneOpacity" && typeof value === "number") {
        setGlassPaneOpacity(value);
      } else if (key === "glassEdge" && typeof value === "number") {
        setGlassEdge(value);
      } else if (key === "glassSheen" && typeof value === "number") {
        setGlassSheen(value);
      } else if (key === "acrylicPaneOpacity" && typeof value === "number") {
        setAcrylicPaneOpacity(value);
      } else if (key === "acrylicEdge" && typeof value === "number") {
        setAcrylicEdge(value);
      } else if (key === "acrylicSheen" && typeof value === "number") {
        setAcrylicSheen(value);
      }
    });
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void listCustomThemes().then((list) => { if (alive) setCustomThemes(list); });
    const unlisten = onCustomThemesChange(() => {
      void listCustomThemes().then((list) => setCustomThemes(list));
    });
    return () => {
      alive = false;
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolvedMode: "dark" | "light" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedMode);
  }, [resolvedMode]);

  const effectiveId = previewId ?? themeId;
  const activeTheme = useMemo(
    () => resolveTheme(effectiveId, customThemes),
    [effectiveId, customThemes],
  );
  const effectiveShape = useMemo(
    () => previewShapeId ?? resolveShapePref(shapeId, activeTheme.shape),
    [previewShapeId, shapeId, activeTheme],
  );
  const shapeMaterial = useMemo(
    () => resolveShape(effectiveShape).material,
    [effectiveShape],
  );
  useEffect(() => {
    // Every built-in theme carries its own `variants` now, including the default one, so
    // there is no id to special-case here: the same call paints them all. `clearTheme`
    // stays exported for the screenshot window, which renders a theme it does not own.
    applyTheme(activeTheme, resolvedMode);
  }, [activeTheme, resolvedMode]);

  /**
   * The shape, applied on its own axis.
   *
   * Its own effect rather than a tail on the theme's, because the two answer different inputs: a
   * shape has to follow a change of mode and a change of theme (a theme may suggest a shape, and the
   * variant it suggests may carry a glass recipe the shape has to leave alone).
   */
  useEffect(() => {
    const variant =
      activeTheme.variants[resolvedMode] ??
      activeTheme.variants.dark ??
      activeTheme.variants.light;
    applyShape(effectiveShape, {
      themeGlass: Boolean(variant?.glass),
      themeTerminal: variant?.terminal?.background,
      // The shape in force decides which recipe is written; a shape with no layer ignores both.
      glass:
        effectiveShape === "acrylic"
          ? { paneOpacity: acrylicPaneOpacity, edge: acrylicEdge, sheen: acrylicSheen }
          : { paneOpacity: glassPaneOpacity, edge: glassEdge, sheen: glassSheen },
    });
  }, [
    effectiveShape,
    activeTheme,
    resolvedMode,
    glassPaneOpacity,
    glassEdge,
    glassSheen,
    acrylicPaneOpacity,
    acrylicEdge,
    acrylicSheen,
  ]);

  /**
   * The merged sheet, on its own axis.
   *
   * It has to outlive a shape change: a sheet that is one surface under `glass` is still one surface
   * when the shape becomes `slab`, and the stylesheet keys the whole layout off this attribute rather
   * than off a preset.
   */
  useEffect(() => {
    applyBoundless(boundless);
  }, [boundless]);

  /**
   * The radius, applied after the theme and after the shape.
   *
   * Order is the whole contract here: a theme may spell `colors.radius` and `applyTheme` writes it, so
   * the axis that the user chose by hand has to be the last thing to speak. It is also why the shape's
   * own effect no longer mentions the radius at all.
   */
  useEffect(() => {
    applyRadius(radius);
  }, [radius]);

  const setMode = useCallback((next: ThemePref) => {
    setModeState(next);
    writeFastMode(next);
    void persistTheme(next);
  }, []);

  const setThemeId = useCallback((id: string) => {
    setPreviewId(null);
    setThemeIdState(id);
    writeFastThemeId(id);
    void persistThemeId(id);
  }, []);

  const previewThemeId = useCallback((id: string | null) => {
    setPreviewId(id);
  }, []);

  // Choosing a shape ends any preview of one, the way `setThemeId` does: the stored value is what the
  // next render should draw from, not the one the pointer happened to be over.
  const setShapeId = useCallback((id: ShapeId) => {
    setPreviewShapeId(null);
    setShapeIdState(id);
    void persistShapeId(id);
  }, []);

  const previewShape = useCallback((id: ShapeId | null) => {
    setPreviewShapeId(id);
  }, []);

  const value = useMemo<ThemeProviderState>(
    () => ({
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      customThemes,
      shape: effectiveShape,
      shapePref: shapeId,
      shapeMaterial,
      radius,
      setMode,
      setShapeId,
      setThemeId,
      previewShape,
      previewThemeId,
    }),
    [
      mode,
      resolvedMode,
      themeId,
      activeTheme,
      customThemes,
      effectiveShape,
      shapeId,
      shapeMaterial,
      radius,
      setMode,
      setShapeId,
      setThemeId,
      previewShape,
      previewThemeId,
    ],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      <SurfaceLayer />
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme(): ThemeProviderState {
  const ctx = useContext(ThemeProviderContext);
  if (!ctx) throw new Error("useTheme must be used within a <ThemeProvider>");
  return ctx;
}
