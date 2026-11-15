import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { type MessageKey, useLanguage, useT } from "@/modules/i18n";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  EDITOR_THEME_AUTO,
  EDITOR_THEME_LABELS,
  EDITOR_THEME_MODE,
  EDITOR_THEMES,
  type EditorThemePref,
  SESSION_TRANSITIONS,
  type SessionTransitionId,
  setBackgroundBlur,
  setBoundless,
  setBackgroundImageId,
  setBackgroundKind,
  setBackgroundOpacity,
  setEditorTheme,
  setCornerRadius,
  setSessionTransition,
  setShapeId,
  setMaterialParam,
  setWindowVibrancy,
  type ThemePref,
} from "@/modules/settings/store";
import {
  defaultGlassParamsFor,
  listShapes,
  RADIUS_STOPS,
  resolveShapePref,
  radiusStopIndex,
  SHAPE_LABELS,
  ShapeIcon,
  shapeUsesGlass,
  useTheme,
} from "@/modules/theme";
import {
  deleteBgImage,
  importBgImageFromFile,
} from "@/modules/theme/bgImageStore";
import { deleteCustomTheme } from "@/modules/theme/customThemes";
import {
  deleteThemeFile,
  handOffThemeEdit,
  type ThemeEditRequest,
} from "@/modules/theme/themeFiles";
import { listBuiltinThemes } from "@/modules/theme/themes";
import {
  themeDescription,
  themeName,
} from "@/modules/theme/themes/themeNames";
import { DEFAULT_THEME_ID } from "@/modules/theme/types";
import {
  type Backdrop,
  getBackdropKind,
} from "@/modules/theme/vibrancy";
import {
  ComputerIcon,
  Edit02Icon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { StateColoursGroup } from "../components/StateColoursGroup";

/** The label for each shape. A map rather than `t(\`settings.shape.${id}\`)` so a new preset cannot
 * ship without one. */
/**
 * The three answers to "which mode" - the generic one, at the top of this section.
 *
 * It lives here rather than in General because everything it decides is below it: the palette list,
 * the shape, the background. General keeps the things that are only about the app's own chrome.
 */
const APPEARANCE: {
  id: ThemePref;
  /** Message key, resolved where it is drawn. */
  label: MessageKey;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "settings.mode.system", icon: ComputerIcon },
  { id: "light", label: "settings.mode.light", icon: Sun03Icon },
  { id: "dark", label: "settings.mode.dark", icon: Moon02Icon },
];

/** Names of the transition animations. One more line here per animation, plus
 * the copy on both sides of the string table. */
const SESSION_TRANSITION_LABELS = {
  ripples: "settings.themes.transition.ripples",
  pulse: "settings.themes.transition.pulse",
  orbit: "settings.themes.transition.orbit",
  bars: "settings.themes.transition.bars",
  none: "settings.themes.transition.none",
} as const;

/**
 * One glass number.
 *
 * The three are the same control with a different range, so they are one function rather than three
 * copies: the value is shown as a percentage because that is how a material is described ("a quarter
 * of the pane's own colour"), and the slider is continuous because the stops of a material are not
 * names the way the radius stops are.
 */
function GlassSlider({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  // The thumb follows the pointer locally and the preference is written when the gesture ends.
  //
  // Writing on every move put a disk write on every percent, and a controlled slider that writes on
  // mount wrote its own minimum over the stored value: the pane's opacity was 2% after the sliders
  // appeared, with nobody touching them. The store stays the truth - `value` wins whenever it
  // changes, which is what makes the reset button move the thumbs.
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span
          data-glass-value={id}
          className="tabular-nums text-[11px] text-muted-foreground"
        >
          {Math.round(draft * 100)}%
        </span>
      </div>
      <Slider
        className="py-1.5"
        value={[draft]}
        min={min}
        max={max}
        step={0.01}
        onValueChange={(next) => setDraft(next[0] ?? draft)}
        onValueCommit={(next) => {
          const settled = next[0];
          if (typeof settled === "number" && settled !== value) onChange(settled);
        }}
      />
      <span className="text-[10px] text-muted-foreground">{hint}</span>
    </div>
  );
}

export function ThemesSection() {
  const t = useT();
  const language = useLanguage();
  const {
    themeId,
    setThemeId,
    resolvedMode,
    customThemes,
    mode,
    setMode,
    radius,
    activeTheme,
  } = useTheme();
  const builtinThemes = listBuiltinThemes();
  const themes = useMemo(
    () => [...builtinThemes, ...customThemes],
    [builtinThemes, customThemes],
  );
  const customIds = useMemo(
    () => new Set(customThemes.map((t) => t.id)),
    [customThemes],
  );

  const [bgError, setBgError] = useState<string | null>(null);
  const bgInputRef = useRef<HTMLInputElement | null>(null);

  // Editing happens in the main window's code editor, so Settings closes
  // (destroying its WebContent process) rather than hiding and staying resident.
  const startThemeEdit = (req: ThemeEditRequest) =>
    void handOffThemeEdit(req, () => getCurrentWindow().close());
  const onEditTheme = (id: string) => startThemeEdit({ action: "edit", id });

  const editorThemePref = usePreferencesStore((s) => s.editorTheme);
  const sessionTransition = usePreferencesStore((s) => s.sessionTransition);
  const backgroundKind = usePreferencesStore((s) => s.backgroundKind);
  const backgroundImageId = usePreferencesStore((s) => s.backgroundImageId);
  const backgroundOpacity = usePreferencesStore((s) => s.backgroundOpacity);
  const backgroundBlur = usePreferencesStore((s) => s.backgroundBlur);
  const windowVibrancy = usePreferencesStore((s) => s.windowVibrancy);
  const boundless = usePreferencesStore((s) => s.boundless);
  const shapePref = usePreferencesStore((s) => s.shapeId);
  const glassPaneOpacity = usePreferencesStore((s) => s.glassPaneOpacity);
  const glassEdge = usePreferencesStore((s) => s.glassEdge);
  const glassSheen = usePreferencesStore((s) => s.glassSheen);
  const acrylicPaneOpacity = usePreferencesStore((s) => s.acrylicPaneOpacity);
  const acrylicEdge = usePreferencesStore((s) => s.acrylicEdge);
  const acrylicSheen = usePreferencesStore((s) => s.acrylicSheen);
  // A theme may suggest a shape, and `auto` resolves to it; the sliders follow what is drawn, not
  // what is stored, so they appear for a suggested glass shape as well.
  const drawnShape = useMemo(
    () => resolveShapePref(shapePref, activeTheme.shape),
    [shapePref, activeTheme],
  );
  // The sliders follow the shape in force, and write to its own recipe: the two see-through shapes
  // are tuned apart, so moving one must not move the other.
  const materialShape: "acrylic" | "glass" =
    drawnShape === "acrylic" ? "acrylic" : "glass";
  const material =
    materialShape === "acrylic"
      ? { paneOpacity: acrylicPaneOpacity, edge: acrylicEdge, sheen: acrylicSheen }
      : { paneOpacity: glassPaneOpacity, edge: glassEdge, sheen: glassSheen };

  const [backdrop, setBackdrop] = useState<Backdrop>("none");
  useEffect(() => {
    let alive = true;
    void getBackdropKind().then((k) => {
      if (alive) setBackdrop(k);
    });
    return () => {
      alive = false;
    };
  }, []);

  const onRemoveCustomTheme = async (id: string) => {
    if (themeId === id) setThemeId(DEFAULT_THEME_ID);
    await deleteCustomTheme(id);
    void deleteThemeFile(id);
  };

  const onPickBgFile = () => bgInputRef.current?.click();

  const handleBgFiles = async (files: FileList | null) => {
    setBgError(null);
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!file.type.startsWith("image/")) {
      setBgError(t("settings.themes.notImage", { file: file.name }));
      return;
    }
    try {
      const prev = backgroundImageId;
      const { id } = await importBgImageFromFile(file);
      await setBackgroundImageId(id);
      await setBackgroundKind("image");
      if (prev && prev !== id) await deleteBgImage(prev).catch(() => undefined);
    } catch (e) {
      setBgError(
        e instanceof Error ? e.message : t("settings.themes.importImageFailed"),
      );
    }
  };

  const onRemoveBackground = async () => {
    setBgError(null);
    const prev = backgroundImageId;
    await setBackgroundKind("none");
    await setBackgroundImageId(null);
    if (prev) await deleteBgImage(prev).catch(() => undefined);
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title={t("settings.themes.title")}
        description={t("settings.themes.description")}
      />

      <div className="flex flex-col gap-2">
        <Label>{t("settings.appearance")}</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{t(o.label)}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("settings.appearanceHint")} {t("settings.appearanceHintTail")}
        </p>
      </div>

      {backdrop === "none" ? null : (
        <SettingRow
          title={
            backdrop === "mica"
              ? t("settings.themes.mica.title")
              : t("settings.themes.vibrancy.title")
          }
          description={
            backdrop === "mica"
              ? t("settings.themes.mica.description")
              : t("settings.themes.vibrancy.description")
          }
        >
          <Switch
            checked={windowVibrancy}
            onCheckedChange={(v) => void setWindowVibrancy(v)}
          />
        </SettingRow>
      )}

      {/* Its own row rather than a choice in the picker: the sheet is about the layout, and every
          shape still draws on it. Below the material switch because both answer "how does the
          window itself look", before the list of colours starts. */}
      <SettingRow
        title={t("settings.boundless.title")}
        description={t("settings.boundless.description")}
      >
        <Switch
          checked={boundless}
          onCheckedChange={(v) => void setBoundless(v)}
        />
      </SettingRow>

      <div className="flex flex-col gap-2">
        <Label>{t("settings.themes.theme")}</Label>
        <div className="grid grid-cols-2 gap-2">
          {themes.map((theme) => {
            const v =
              theme.variants[resolvedMode] ??
              theme.variants.dark ??
              theme.variants.light;
            const c = v?.colors;
            const swatchBg = c?.background ?? "var(--background)";
            const swatchFg = c?.foreground ?? "var(--foreground)";
            const swatchAccent = c?.primary ?? c?.accent ?? "var(--accent)";
            const swatchMuted = c?.muted ?? "var(--muted)";
            const selected = themeId === theme.id;
            const isCustom = customIds.has(theme.id);
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => setThemeId(theme.id)}
                className={cn(
                  "group flex items-center gap-3 rounded-lg border p-2.5 text-left transition-all",
                  selected
                    ? "border-foreground/60 ring-1 ring-foreground/20"
                    : "border-border/60 hover:border-border",
                )}
              >
                <div
                  className="flex h-10 w-14 shrink-0 items-center justify-center gap-1 rounded-md border border-border/40"
                  style={{ background: swatchBg }}
                >
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchAccent }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchFg, opacity: 0.7 }}
                  />
                  <span
                    className="h-5 w-2 rounded-sm"
                    style={{ background: swatchMuted }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12.5px] font-medium">
                    {themeName(theme.id, theme.name, language)}
                  </span>
                  {themeDescription(
                        theme.id,
                        theme.description,
                        language,
                      ) ? (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {themeDescription(
                        theme.id,
                        theme.description,
                        language,
                      )}
                    </span>
                  ) : null}
                </div>
                {isCustom ? (
                  <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                    {/* biome-ignore lint/a11y/useFocusableInteractive: a tabindex here would take DOM focus off the theme row button and onto this icon */}
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: this chip only shows on hover and the row button above already owns keyboard selection */}
                    {/* biome-ignore lint/a11y/useSemanticElements: a real button here would nest inside the theme row button that wraps it */}
                    <span
                      role="button"
                      aria-label={`${t("settings.themes.editTheme")} ${themeName(theme.id, theme.name, language)}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditTheme(theme.id);
                      }}
                    >
                      <HugeiconsIcon
                        icon={Edit02Icon}
                        size={12}
                        strokeWidth={1.75}
                      />
                    </span>
                    {/* biome-ignore lint/a11y/useFocusableInteractive: a tabindex here would take DOM focus off the theme row button and onto this icon */}
                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: this chip only shows on hover and the row button above already owns keyboard selection */}
                    {/* biome-ignore lint/a11y/useSemanticElements: a real button here would nest inside the theme row button that wraps it */}
                    <span
                      role="button"
                      aria-label={`${t("settings.themes.removeTheme")} ${themeName(theme.id, theme.name, language)}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRemoveCustomTheme(theme.id);
                      }}
                    >
                      ×
                    </span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex min-w-0 flex-col">
          <Label>{t("settings.shape.title")}</Label>
        </div>
        {/* Each choice draws itself - the three regions, their borders, their shadow and the
            material - so they can be told apart before being applied. The radius is not part of a
            shape any more: it is the slider below, which the drawings follow.
            One row, not a grid: the seven presets are read as a set, and a wrapped grid put the
            seventh alone on a line of its own while the two see-through ones - the comparison this
            axis is about - ended up in different rows. */}
        <div className="grid grid-cols-7 gap-1">
          {listShapes().map((id) => {
            const selected = shapePref === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => void setShapeId(id)}
                aria-pressed={selected}
                className={cn(
                  "flex min-w-0 flex-col items-center gap-1 rounded-md border px-0.5 py-1.5 text-[10.5px] whitespace-nowrap transition-colors",
                  selected
                    ? "border-foreground/60 bg-foreground/[0.04] text-foreground"
                    : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <ShapeIcon shape={id} radius={radius} />
                {t(SHAPE_LABELS[id])}
              </button>
            );
          })}
        </div>

        {/* The material's three numbers. Shown only for the shapes that draw the layer, because a
            slider that changes nothing is a control that lies. */}
        {shapeUsesGlass(drawnShape) ? (
          <div className="flex flex-col gap-2 rounded-md border border-border/60 px-2.5 py-2">
            <div className="flex items-center justify-between gap-3">
              <Label>{t("settings.shape.glassParams")}</Label>
              <button
                type="button"
                data-glass-reset=""
                onClick={() => {
                  const defaults = defaultGlassParamsFor(drawnShape);
                  void setMaterialParam(materialShape, "paneOpacity", defaults.paneOpacity);
                  void setMaterialParam(materialShape, "edge", defaults.edge);
                  void setMaterialParam(materialShape, "sheen", defaults.sheen);
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground outline-none transition-colors duration-[var(--dur-base)] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {t("settings.shape.glassReset")}
              </button>
            </div>
            <span className="text-[10px] text-muted-foreground">
              {t("settings.shape.glassParamsHint")}
            </span>
            <GlassSlider
              id="pane"
              label={t("settings.shape.glassPaneOpacity")}
              hint={t("settings.shape.glassPaneOpacityHint")}
              value={material.paneOpacity}
              min={0.02}
              max={0.9}
              onChange={(value) => void setMaterialParam(materialShape, "paneOpacity", value)}
            />
            <GlassSlider
              id="edge"
              label={t("settings.shape.glassEdge")}
              hint={t("settings.shape.glassEdgeHint")}
              value={material.edge}
              min={0}
              max={0.8}
              onChange={(value) => void setMaterialParam(materialShape, "edge", value)}
            />
            <GlassSlider
              id="sheen"
              label={t("settings.shape.glassSheen")}
              hint={t("settings.shape.glassSheenHint")}
              value={material.sheen}
              min={0}
              max={0.5}
              onChange={(value) => void setMaterialParam(materialShape, "sheen", value)}
            />
          </div>
        ) : null}

        {/* One slider for every corner in the app, in stops rather than a continuous range: a gear
            lever, not a dial. The dots are the stops, so the control says where it can land. */}
        <div className="flex flex-col gap-1.5 pt-1">
          <div className="flex items-center justify-between gap-3">
            <Label>{t("settings.shape.radius")}</Label>
            <span
              data-radius-value=""
              className="tabular-nums text-[11px] text-muted-foreground"
            >
              {/* The stops are rem; pixels are what the eye judges. */}
              {Math.round(Number.parseFloat(radius) * 16)}px
            </span>
          </div>
          {/* The padding is the point: the thumb is 16px tall, which is a small thing to hit, so the
              control keeps a taller band that a click anywhere in counts as. */}
          <Slider
            className="py-2"
            value={[radiusStopIndex(radius)]}
            min={0}
            max={RADIUS_STOPS.length - 1}
            step={1}
            onValueChange={(v) =>
              void setCornerRadius(RADIUS_STOPS[v[0] ?? radiusStopIndex(radius)])
            }
          />
          {/* The dots are the stops and they are also targets: the slider snaps per stop, so a click on
              one is the same move made directly. */}
          <div className="flex justify-between">
            {RADIUS_STOPS.map((stop) => (
              <button
                key={stop}
                type="button"
                data-stop={stop}
                aria-label={`${Math.round(Number.parseFloat(stop) * 16)}px`}
                onClick={() => void setCornerRadius(stop)}
                className="flex h-4 w-4 items-center justify-center"
              >
                <span
                  className={cn(
                    "h-1 w-1 rounded-full",
                    stop === radius
                      ? "bg-foreground/70"
                      : "bg-muted-foreground/40",
                  )}
                />
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {t("settings.shape.radiusHint")}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <Label>{t("settings.themes.editorTheme.title")}</Label>
            <span className="text-[11px] text-muted-foreground">
              {t("settings.themes.editorTheme.description")}
            </span>
          </div>
          <Select
            value={editorThemePref}
            onValueChange={(v) => void setEditorTheme(v as EditorThemePref)}
          >
            <SelectTrigger size="sm" className="h-8 w-44 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EDITOR_THEME_AUTO} className="text-[12px]">
                {t("settings.themes.editorTheme.auto")}
              </SelectItem>
              <SelectSeparator />
              {[...EDITOR_THEMES]
                .sort(
                  (a, b) =>
                    (EDITOR_THEME_MODE[a] === resolvedMode ? 0 : 1) -
                    (EDITOR_THEME_MODE[b] === resolvedMode ? 0 : 1),
                )
                .map((id) => (
                  <SelectItem
                    key={id}
                    value={id}
                    disabled={EDITOR_THEME_MODE[id] !== resolvedMode}
                    className="text-[12px]"
                  >
                    {EDITOR_THEME_LABELS[id]}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <Label>{t("settings.themes.transition.title")}</Label>
            <span className="text-[11px] text-muted-foreground">
              {t("settings.themes.transition.description")}
            </span>
          </div>
          <Select
            value={sessionTransition}
            onValueChange={(v) =>
              void setSessionTransition(v as SessionTransitionId)
            }
          >
            <SelectTrigger size="sm" className="h-8 w-44 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_TRANSITIONS.map((id) => (
                <SelectItem key={id} value={id} className="text-[12px]">
                  {t(SESSION_TRANSITION_LABELS[id])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <StateColoursGroup />

      {/* biome-ignore lint/a11y/noStaticElementInteractions: this wrapper is only a file drop target, and the import button below is the accessible path */}
      <div
        role="presentation"
        className="flex flex-col gap-2"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          e.preventDefault();
          void handleBgFiles(e.dataTransfer.files);
        }}
      >
        <div className="flex items-center justify-between">
          <Label>{t("settings.themes.background")}</Label>
          <div className="flex items-center gap-2">
            {backgroundKind === "image" && backgroundImageId ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                onClick={() => void onRemoveBackground()}
              >
                {t("settings.themes.remove")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={onPickBgFile}
            >
              {backgroundKind === "image"
                ? t("settings.themes.replaceImage")
                : t("settings.themes.chooseImage")}
            </Button>
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                void handleBgFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {bgError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive">
            {bgError}
          </div>
        ) : null}
        {backgroundKind === "image" && backgroundImageId ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-muted-foreground">
                {t("settings.themes.opacity")}
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {Math.round(backgroundOpacity * 100)}%
              </span>
            </div>
            <Slider
              value={[backgroundOpacity]}
              min={0}
              max={1}
              step={0.01}
              onValueChange={(v) => void setBackgroundOpacity(v[0] ?? 0)}
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11.5px] text-muted-foreground">
                {t("settings.themes.blur")}
              </span>
              <span className="tabular-nums text-[11px] text-muted-foreground">
                {backgroundBlur}px
              </span>
            </div>
            <Slider
              value={[backgroundBlur]}
              min={0}
              max={64}
              step={1}
              onValueChange={(v) => void setBackgroundBlur(v[0] ?? 0)}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {t("settings.themes.dropImage")}
          </p>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
