import { native } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listen } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  handleCursor,
  isUsableSelection,
  MIN_SIDE,
  moveRect,
  type ResizeHandle,
  rectFromDrag,
  resizeRect,
  type ScreenshotRect,
  toPhysical,
} from "./lib/selection";

type Pt = { x: number; y: number };
type Gesture =
  | { kind: "new"; start: Pt }
  | { kind: "move"; origin: Pt; base: ScreenshotRect }
  | { kind: "resize"; handle: ResizeHandle; origin: Pt; base: ScreenshotRect };

/** 后端把覆盖窗口亮出来时叫这一声。窗口是养着的，每次截图都从这条消息开始。 */
const ARMED_EVENT = "screenshot:armed";

/**
 * 压暗的程度。
 *
 * 轻一点：这一层只是提示「现在是截图模式」，底下是活着的屏幕。压太重会像把画面冻住——那是另一
 * 种做法（冻结快照），用户明确不要。
 */
const DIM = "rgba(0, 0, 0, 0.25)";

/** 圆角滑杆的默认值（CSS 像素）。 */
const DEFAULT_RADIUS = 15;

const HANDLES: ResizeHandle[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

/** 把手在框上的位置（CSS 像素）。四角压在角上，四边压在边中点上。 */
const HANDLE_POS: Record<
  ResizeHandle,
  { left: string; top: string; translate: string }
> = {
  n: { left: "50%", top: "0%", translate: "translate(-50%, -50%)" },
  ne: { left: "100%", top: "0%", translate: "translate(-50%, -50%)" },
  e: { left: "100%", top: "50%", translate: "translate(-50%, -50%)" },
  se: { left: "100%", top: "100%", translate: "translate(-50%, -50%)" },
  s: { left: "50%", top: "100%", translate: "translate(-50%, -50%)" },
  sw: { left: "0%", top: "100%", translate: "translate(-50%, -50%)" },
  w: { left: "0%", top: "50%", translate: "translate(-50%, -50%)" },
  nw: { left: "0%", top: "0%", translate: "translate(-50%, -50%)" },
};

/**
 * 覆盖窗口：铺满整屏的一层浅灰，让人在上面框一块出来，松手之后还能接着调。
 *
 * 这里只管「选」与「画」：屏幕上没有冻结的画面可画——压在底下的就是屏幕本身，框选期间它一直是
 * 活的（跟 Windows 自带截图一样）。真正的抓屏发生在点保存那一刻，由后端把窗口藏掉之后再抓，
 * 免得灰层、选择框、把手、操作条一起进到图里。
 *
 * 裁剪、存图、进剪贴板也都在后端：这里把选区坐标交回去就行。
 */
export function ScreenshotOverlay() {
  const t = useT();
  /** 已经框出来的那块（CSS 像素，相对窗口左上角）。松手之后就是它一直在，直到保存或取消。 */
  const [rect, setRect] = useState<ScreenshotRect | null>(null);
  const [gesture, setGesture] = useState<Gesture["kind"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** 四角圆角半径，CSS 像素；0 就是不圆。默认 15：稍微收一点角，图上看着舒服。 */
  const [radius, setRadius] = useState(DEFAULT_RADIUS);
  const gestureRef = useRef<Gesture | null>(null);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const scale = dpr > 0 ? dpr : 1;

  /**
   * 窗口自己的 CSS 尺寸就是「画面」的尺寸：这个窗口铺满整块虚拟桌面，它多大，量到的选区就在多
   * 大的范围里；后端抓屏用的也是同一块范围。每次现读——显示器插拔、分辨率改过，窗口会跟着变。
   */
  const viewBounds = useCallback(
    () => ({ width: window.innerWidth, height: window.innerHeight }),
    [],
  );

  /**
   * 窗口是养着的（后端只把 webview 建一次），所以每次截图都从这一条消息开始。
   *
   * 收到就把上一次的选区、圆角、报错全清掉：否则用户会看到上一次那个框还杵在屏幕上面。
   */
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void (async () => {
      const off = await listen(ARMED_EVENT, () => {
        setRect(null);
        setFailure(null);
        setSaving(false);
        setRadius(DEFAULT_RADIUS);
        gestureRef.current = null;
        setGesture(null);
      });
      if (disposed) off();
      else stop = off;
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const cancel = useCallback(() => {
    void native.screenshotCancel();
  }, []);

  const save = useCallback(async () => {
    if (!rect || saving) return;
    const physical = toPhysical(rect, scale, viewBounds());
    if (!isUsableSelection(physical, scale)) return;
    setSaving(true);
    setFailure(null);
    try {
      // 圆角按 CSS 像素调，交给后端的是物理像素。
      const radiusPhysical = Math.round(radius * scale);
      // 成与不成都不在这儿收尾：后端抓屏、存图之后会把窗口藏起来（抓屏得发生在藏之后）；
      // 失败了会被告知，而且选区还留着——用户能接着调、接着存。
      await native.screenshotFinish(physical, radiusPhysical);
    } catch (e) {
      setFailure(String(e));
      setSaving(false);
    }
  }, [rect, saving, scale, viewBounds, radius]);

  // Esc 取消、Enter 保存。截图中途想放弃、或者框完就想立刻存，都是很自然的动作。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, save]);

  // 手势期间在 window 上收 move / up：把手与整块都要跟着走，而在元素上收事件会因为
  // 指针捕获、子元素挡住等等漏掉几步。这里是 layout effect：要赶在下一帧之前就挂上，
  // 否则按下之后紧接的那一下移动会丢（手快的人能碰上）。
  useLayoutEffect(() => {
    if (!gesture) return;
    const onMove = (event: PointerEvent) => {
      const active = gestureRef.current;
      if (!active) return;
      const at = { x: event.clientX, y: event.clientY };
      if (active.kind === "new") {
        setRect(rectFromDrag(active.start, at));
        return;
      }
      const delta = { dx: at.x - active.origin.x, dy: at.y - active.origin.y };
      const next =
        active.kind === "move"
          ? moveRect(active.base, delta.dx, delta.dy, viewBounds())
          : // 最小边长按物理像素折算回 CSS：拉到底也不能把它拉成一块「没法用」的框，
            // 否则把手与操作条会在拖的过程中突然消失。
            resizeRect(
              active.base,
              active.handle,
              delta.dx,
              delta.dy,
              viewBounds(),
              MIN_SIDE / scale,
            );
      setRect(next);
    };
    const onUp = () => {
      const active = gestureRef.current;
      gestureRef.current = null;
      setGesture(null);
      if (active?.kind === "new") {
        // 只是点了一下，或者框得太小：当没框，让人重来，别留个没法用的框在这儿。
        setRect((current) => {
          if (!current) return null;
          const physical = toPhysical(current, scale, viewBounds());
          return isUsableSelection(physical, scale) ? current : null;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [gesture, scale, viewBounds]);

  const live = rect ? toPhysical(rect, scale, viewBounds()) : null;
  const hasSelection = !!live && isUsableSelection(live, scale);
  const picking = gesture === "new";
  /** 框已经画出来了（哪怕还在拖）：这时候用阴影压暗框外，框里保持透明，好让人看清要截的那块。 */
  const boxed = !!rect && rect.width > 0 && rect.height > 0;

  const onBackdropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (saving || event.button !== 0) return;
    const at = { x: event.clientX, y: event.clientY };
    // 点在已经框好的那块里面 = 整块挪；点在别处 = 重新框一块。
    if (hasSelection && rect && pointInRect(at, rect)) {
      gestureRef.current = { kind: "move", origin: at, base: rect };
      setGesture("move");
      return;
    }
    gestureRef.current = { kind: "new", start: at };
    setGesture("new");
    setRect({ x: at.x, y: at.y, width: 0, height: 0 });
  };

  const onHandlePointerDown =
    (handle: ResizeHandle) => (event: React.PointerEvent) => {
      if (saving || !rect || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      gestureRef.current = {
        kind: "resize",
        handle,
        origin: { x: event.clientX, y: event.clientY },
        base: rect,
      };
      setGesture("resize");
    };

  /** 操作条贴在哪：贴着选区**右下角**；底下放不下就翻到上面；横向不许出画面。
   *
   * 宽度是用估算值收边的，条本身仍然是内容宽度（原来写死过 188，那是为了装尺寸文字；
   * 尺寸挪到标签上之后，写死的宽度就变成右边一块空白了）。
   */
  const toolbarStyle = (() => {
    if (!rect || !hasSelection) return undefined;
    const estimated = 158;
    const gap = 10;
    const left = Math.max(
      4,
      Math.min(
        rect.x + rect.width - estimated,
        window.innerWidth - estimated - 4,
      ),
    );
    const below = rect.y + rect.height + gap;
    const above = rect.y - gap - 32;
    const top =
      below + 32 <= window.innerHeight - 4 ? below : Math.max(4, above);
    return { left, top };
  })();

  /** 尺寸标签默认在框上头；贴着屏幕顶上就翻到下面去。 */
  const tagAbove = !rect ? true : rect.y >= 34;

  return (
    <div className="fixed inset-0 select-none overflow-hidden">
      {/* 还没框出东西来：整屏压一层浅灰，让人一眼看出现在是截图模式（跟系统一样）。
          框出来之后撤掉这一层，改由选区那圈阴影压暗框外——框里是活着的屏幕，看得清要截的那块。 */}
      {boxed ? null : (
        <div className="absolute inset-0" style={{ background: DIM }} />
      )}

      <div
        data-screenshot-ui="backdrop"
        className="absolute inset-0"
        style={{
          touchAction: "none",
          cursor: picking ? "crosshair" : "default",
        }}
        onPointerDown={onBackdropPointerDown}
      />

      {boxed && rect ? (
        <div
          data-screenshot-ui="box"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
            // 框外压暗：一圈夸张的阴影比再铺四块黑布简单，也不会漏缝。
            boxShadow: `0 0 0 100vmax ${DIM}`,
            cursor: hasSelection ? "move" : "crosshair",
            // 圆角所见即所得：这里圆成什么样，存出来的图就圆成什么样（后端按同一个半径抠角）。
            borderRadius: radius,
          }}
          className="absolute outline-2 outline-primary outline-offset-[-1px]"
          onPointerDown={(event) => {
            if (saving || !hasSelection || event.button !== 0) return;
            event.stopPropagation();
            gestureRef.current = {
              kind: "move",
              origin: { x: event.clientX, y: event.clientY },
              base: rect,
            };
            setGesture("move");
          }}
        >
          {/* 只在框好之后给把手：还在拖的时候给把手会跟拖动打架。 */}
          {hasSelection && !picking
            ? HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  aria-label={`调整 ${handle}`}
                  className="absolute h-2.5 w-2.5 rounded-[3px] border border-primary bg-white shadow-[0_1px_2px_rgba(0,0,0,0.5)] transition-transform hover:scale-110"
                  style={{
                    left: HANDLE_POS[handle].left,
                    top: HANDLE_POS[handle].top,
                    transform: HANDLE_POS[handle].translate,
                    cursor: handleCursor(handle),
                  }}
                  onPointerDown={onHandlePointerDown(handle)}
                />
              ))
            : null}
        </div>
      ) : null}

      {rect && hasSelection && live ? (
        <div
          data-screenshot-ui
          className="absolute flex items-center gap-1.5 rounded-lg border border-white/10 bg-neutral-900/95 p-1 shadow-[0_6px_24px_rgba(0,0,0,0.5)]"
          style={toolbarStyle}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <label
            className="flex items-center gap-1.5 pr-0.5 pl-1"
            title={t("screenshot.radius")}
          >
            <input
              type="range"
              min={0}
              max={40}
              value={radius}
              aria-label={t("screenshot.radius")}
              onChange={(event) => setRadius(Number(event.target.value))}
              className="h-1 w-14 accent-primary"
            />
            <span className="w-5 text-[10px] text-white/55 tabular-nums">
              {radius}
            </span>
          </label>
          <button
            type="button"
            title={t("screenshot.save")}
            aria-label={t("screenshot.save")}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" />
            ) : (
              <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            title={t("screenshot.cancel")}
            aria-label={t("screenshot.cancel")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-white/75 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-60"
            onClick={cancel}
            disabled={saving}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      {failure ? (
        <div
          data-screenshot-ui
          className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-red-400/40 bg-red-950/90 px-3 py-1.5 text-[12px] text-red-100 shadow-lg"
        >
          {t("screenshot.saveFailed", { error: failure })}
        </div>
      ) : (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-black/65 px-2.5 py-1 text-[12px] text-white/90">
          {hasSelection ? t("screenshot.hintAdjust") : t("screenshot.hint")}
        </div>
      )}

      {rect && hasSelection && live ? (
        <div
          className="pointer-events-none absolute flex items-center gap-1.5 rounded-md bg-black/75 px-2 py-1 text-[11px] text-white tabular-nums shadow-lg"
          style={{
            left: Math.max(2, Math.min(rect.x, window.innerWidth - 150)),
            top: tagAbove ? rect.y - 28 : rect.y + rect.height + 6,
          }}
        >
          <span>
            {live.width} × {live.height}
          </span>
          <span className="text-white/50">
            {live.x}, {live.y}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function pointInRect(point: Pt, rect: ScreenshotRect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}
