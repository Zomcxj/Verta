import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useState } from "react";
import { native, type WireScreenshotShot } from "@/lib/native";
import { useT } from "@/modules/i18n";
import { dragBox, isUsableSelection, selectionRect } from "./lib/selection";

type Pt = { x: number; y: number };

/**
 * 覆盖窗口：铺一整屏「冻结」的画面，让人在上面拖出一块。
 *
 * 这里只负责「选」，裁剪、存图、进剪贴板全在后端做——把整屏喂给 asset 协议再用 canvas 裁，
 * 跨源会给 canvas 打上脏标记，`toBlob` 直接抛。
 */
export function ScreenshotOverlay() {
  const t = useT();
  const [shot, setShot] = useState<WireScreenshotShot | null>(null);
  const [start, setStart] = useState<Pt | null>(null);
  const [end, setEnd] = useState<Pt | null>(null);
  /** 已经交出去了，别再收第二次指针事件。 */
  const [settling, setSettling] = useState(false);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const bounds = useMemo(
    () => ({ width: shot?.width ?? 0, height: shot?.height ?? 0 }),
    [shot],
  );

  // 挂载后问一次要显示哪张图。没有（比如被取消过）就如实报回去，别留个黑窗口。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const pending = await native.screenshotPending();
        if (!alive) return;
        if (!pending) {
          await native.screenshotFailed(t("screenshot.nothingPending"));
          return;
        }
        setShot(pending);
      } catch (e) {
        if (alive) await native.screenshotFailed(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [t]);

  /**
   * 图真的画出来了再把窗口显示出来。
   *
   * 后端建窗时是 hidden 的：先显示再加载会闪一下黑底。后端那边还有一次 700ms 的兜底 show，
   * 所以这里就算不跑，窗口也不会一直藏着。
   */
  const reveal = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
    } catch (e) {
      await native.screenshotFailed(String(e));
    }
  }, []);

  // Esc 取消。截图中途想放弃是很正常的动作，得能随时退出来。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void native.screenshotCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const live = start && end ? selectionRect(start, end, dpr, bounds) : null;
  const box = start && end ? dragBox(start, end) : null;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (settling || !shot) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const pt = { x: event.clientX, y: event.clientY };
    setStart(pt);
    setEnd(pt);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start || settling) return;
    setEnd({ x: event.clientX, y: event.clientY });
  };

  const onPointerUp = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start) return;
    const dropped = { x: event.clientX, y: event.clientY };
    const rect = selectionRect(start, dropped, dpr, bounds);
    setStart(null);
    setEnd(null);
    // 只是点了一下、或者框得太小：当没选，让人重来，别存一张 1×1 的图。
    if (!isUsableSelection(rect)) return;
    setSettling(true);
    try {
      await native.screenshotFinish(rect);
    } catch (e) {
      await native.screenshotFailed(String(e));
    }
  };

  return (
    <div className="fixed inset-0 select-none overflow-hidden bg-black">
      {shot ? (
        <img
          src={convertFileSrc(shot.previewPath)}
          alt=""
          draggable={false}
          className="pointer-events-none absolute top-0 left-0"
          style={{ width: shot.width / (dpr > 0 ? dpr : 1), height: shot.height / (dpr > 0 ? dpr : 1) }}
          onLoad={() => {
            void reveal();
          }}
          onError={() => {
            void native.screenshotFailed(t("screenshot.previewFailed", { path: shot.previewPath }));
          }}
        />
      ) : null}

      <div
        className="absolute inset-0 cursor-crosshair"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          void onPointerUp(event);
        }}
      >
        {box ? (
          <div
            className="pointer-events-none absolute border border-sky-400"
            style={{
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              // 框外压暗：一圈夸张的阴影比再铺四块黑布简单，也不会漏缝。
              boxShadow: "0 0 0 100vmax rgba(0, 0, 0, 0.45)",
            }}
          >
            {live ? (
              <span className="absolute -top-6 left-0 rounded bg-sky-500 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums">
                {live.width} × {live.height}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded bg-black/65 px-2 py-1 text-[12px] text-white/90">
        {t("screenshot.hint")}
      </div>
    </div>
  );
}