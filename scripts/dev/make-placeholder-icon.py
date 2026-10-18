#!/usr/bin/env python3
"""生成 Verta 的占位图标（深色圆角底 + 白色 V）。

源项目那套图标不能入库，这里先放一个中性且明显是占位的东西，等有正式设计再换掉。
用法：python scripts/dev/make-placeholder-icon.py [输出目录]
产物：<输出目录>/app-icon.png（1024，给 `pnpm tauri icon` 用）、public/logo.png（256，界面里的 logo）
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
BG = (28, 28, 30, 255)  # 与深色主题的底色接近
MARK = (244, 244, 246, 255)
STROKE = 104


def draw_mark(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    inset = round(size * 0.06)
    draw.rounded_rectangle(
        [inset, inset, size - inset, size - inset],
        radius=round(size * 0.21),
        fill=BG,
    )

    # 一个 V：两条粗线加三个圆头，和源项目那个三角没有任何关系。
    top = round(size * 0.31)
    bottom = round(size * 0.70)
    left = round(size * 0.30)
    right = round(size * 0.70)
    middle = round(size * 0.50)
    width = round(STROKE * size / SIZE)
    points = [(left, top), (middle, bottom), (right, top)]
    draw.line(points, fill=MARK, width=width, joint="curve")
    for x, y in points:
        draw.ellipse(
            [x - width // 2, y - width // 2, x + width // 2, y + width // 2],
            fill=MARK,
        )
    return image


def main() -> None:
    out_dir = Path(sys.argv[1] if len(sys.argv) > 1 else ".superpowers/icon-src")
    out_dir.mkdir(parents=True, exist_ok=True)

    source = draw_mark(SIZE)
    source.save(out_dir / "app-icon.png")

    # 界面里用到的 logo：index.html 的 favicon、关于页、终端水印。
    public_logo = Path("public/logo.png")
    if public_logo.parent.is_dir():
        draw_mark(256).save(public_logo)
        print(f"wrote {public_logo}")

    print(f"wrote {out_dir / 'app-icon.png'} ({SIZE}px source for `pnpm tauri icon`)")


if __name__ == "__main__":
    main()