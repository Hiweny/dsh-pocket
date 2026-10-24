#!/usr/bin/env python3
"""截图分析：验证全屏底色同步（无白线）、键盘是否顶起页面。"""
import sys
from PIL import Image


def avg(img, box):
    crop = img.crop(box).convert("RGB").resize((1, 1), Image.BOX)
    return crop.getpixel((0, 0))


def hexc(c):
    return "#%02x%02x%02x" % c


def band(img, y0, y1):
    w, _ = img.size
    return avg(img, (0, y0, w, max(y0 + 1, y1)))


def find_color_rows(img, target, tol=26):
    """返回与 target 接近的行的 y 范围（用于定位输入框/按钮）。"""
    w, h = img.size
    rows = []
    px = img.convert("RGB")
    for y in range(0, h, 4):
        c = avg(px, (0, y, w, y + 4))
        if all(abs(c[i] - target[i]) <= tol for i in range(3)):
            rows.append(y)
    return rows


def analyze(path, label, page_color=(0x12, 0x34, 0x56)):
    img = Image.open(path)
    w, h = img.size
    top = band(img, 0, max(2, h // 200))
    bottom = band(img, h - max(2, h // 200), h)
    mid = band(img, h // 2, h // 2 + max(2, h // 200))
    print(f"== {label} {w}x{h}")
    print(f"   top={hexc(top)} bottom={hexc(bottom)} middle={hexc(mid)}")
    print(f"   page color={hexc(page_color)}")

    def near(c):
        return all(abs(c[i] - page_color[i]) <= 18 for i in range(3))

    print(f"   top matches page: {near(top)} | bottom matches page: {near(bottom)}")

    # 蓝色按钮 / accent 行分布（键盘弹起时 composer 会整体上移）
    accent = (0x4D, 0x6B, 0xFE)
    rows = find_color_rows(img, accent, tol=40)
    if rows:
        print(f"   accent rows: min={min(rows)} max={max(rows)} (h={h})")
    else:
        print("   accent rows: none")
    return {"top": top, "bottom": bottom, "accent_rows": (min(rows), max(rows)) if rows else None}


if __name__ == "__main__":
    page = (0x12, 0x34, 0x56)
    for p in sys.argv[1:]:
        analyze(p, p.split("/")[-1], page)
