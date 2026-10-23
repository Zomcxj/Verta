import { usePreferencesStore } from "@/modules/settings/preferences";

/**
 * 点开会话之后的过渡，**只盖终端那一块**（由 `WorkspaceSurface` 画在终端层里，
 * 不是铺满全屏）：要挡住的只是「命令被写进终端」那一幕，侧栏、标签栏、状态栏照常可见。
 *
 * 恢复一条会话要往终端里写命令，写进去的瞬间那行命令就画在终端上 —— 看到的就是
 * 「有人在替你敲命令」。开标签之前把这层盖上去，那一幕就换成居中的一段过渡：中间是
 * 应用图标，出现时图标震一下，周围按设置里选的那种动画走（设置 → 主题页那一项）。
 *
 * 有意只动 transform / opacity：这两个属性不会额外带一层合成层（合成层预算那支测试
 * 盯着的就是这条）；柔边用径向渐变，不用模糊。一律 `pointer-events-none`：过渡期间
 * 也不该挡输入。
 */
export function SessionOpeningOverlay({ open }: { open: boolean }) {
  const variant = usePreferencesStore((s) => s.sessionTransition);
  if (!open || variant === "none") return null;
  return (
    <div
      data-session-opening
      data-session-opening-variant={variant}
      aria-hidden="true"
      className="verta-session-opening pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
    >
      {variant === "ripples" ? (
        <>
          <span className="verta-session-opening-ripple" />
          <span className="verta-session-opening-ripple" />
          <span className="verta-session-opening-ripple" />
        </>
      ) : null}
      {variant === "pulse" ? (
        <>
          <span className="verta-session-opening-pulse" />
          <span className="verta-session-opening-pulse" />
          <span className="verta-session-opening-pulse" />
        </>
      ) : null}
      {variant === "orbit" ? (
        <>
          <span className="verta-session-opening-orbit" />
          <span className="verta-session-opening-orbit is-inner" />
        </>
      ) : null}
      {variant === "bars" ? (
        <span className="verta-session-opening-bars">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className="verta-session-opening-core">
        <img
          src="/logo.png"
          alt=""
          width={44}
          height={44}
          className="size-11 rounded-xl"
        />
      </span>
    </div>
  );
}