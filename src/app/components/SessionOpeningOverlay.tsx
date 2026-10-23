/**
 * 点开会话之后的过渡。
 *
 * 恢复一条会话要往终端里写命令，而写进去的瞬间那行命令就画在终端上 —— 看到的就是
 * 「有人在替你敲命令」。开标签之前把这层盖上去，那一幕就换成居中的一段过渡：几圈
 * 波纹往外扩，中间是应用图标，出现时图标震一下（像播放器起播）。底下终端照旧准备，
 * 只是不给人看。
 *
 * 有意只动 transform / opacity：这两个属性不会额外带一层合成层（合成层预算那支测试
 * 盯着的就是这条）；柔边用径向渐变，不用模糊。一律 `pointer-events-none`：过渡期间
 * 也不该挡输入。
 */
export function SessionOpeningOverlay({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <div
      data-session-opening
      aria-hidden="true"
      className="verta-session-opening pointer-events-none fixed inset-0 z-50 flex items-center justify-center"
    >
      <span className="verta-session-opening-ripple" />
      <span className="verta-session-opening-ripple" />
      <span className="verta-session-opening-ripple" />
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