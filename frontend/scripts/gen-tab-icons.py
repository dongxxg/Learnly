#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 tabBar 图标（81×81 PNG，灰/萌芽绿双态，透明底）。

零第三方依赖：手写 RGBA 像素缓冲 + zlib 打包 PNG（4x 超采样抗锯齿）。
用法：python scripts/gen-tab-icons.py
产物：src/static/tab/{home,profile}{,-active}.png
"""
import math
import struct
import zlib
from pathlib import Path

SIZE = 81
SS = 4  # 超采样倍数
GRAY = (0x9C, 0xA3, 0xAF)   # $learnly-text-light
GREEN = (0x4C, 0xAF, 0x7A)  # $learnly-primary

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "static" / "tab"


def in_home(nx: float, ny: float) -> bool:
    """房子：屋顶三角 + 屋身方 + 门洞。坐标归一化到 [0,1]。"""
    # 屋顶：顶点 (0.5, 0.10) 底边 y=0.46 宽 [0.08, 0.92]
    if 0.10 <= ny <= 0.46:
        half = (ny - 0.10) / (0.46 - 0.10) * 0.42
        if abs(nx - 0.5) <= half:
            return True
    # 屋身：y [0.46, 0.90] x [0.16, 0.84]，门洞 x [0.42, 0.58] y [0.62, 0.90]
    if 0.46 <= ny <= 0.90 and 0.16 <= nx <= 0.84:
        if 0.42 <= nx <= 0.58 and 0.62 <= ny <= 0.90:
            return False
        return True
    return False


def in_profile(nx: float, ny: float) -> bool:
    """人形：头圆 + 肩弧。"""
    # 头：圆心 (0.5, 0.30) 半径 0.16
    if (nx - 0.5) ** 2 + (ny - 0.30) ** 2 <= 0.16 ** 2:
        return True
    # 肩：椭圆心 (0.5, 0.86) 半轴 (0.30, 0.26)，截 y <= 0.86
    if ny <= 0.86 and ((nx - 0.5) / 0.30) ** 2 + ((ny - 0.86) / 0.26) ** 2 <= 1.0:
        return True
    return False


def render(shape, rgb) -> bytes:
    """4x 超采样渲染 → RGBA 像素行（PNG scanline 格式，带 filter 字节）。"""
    rows = []
    for py in range(SIZE):
        row = bytearray([0])  # filter type 0
        for px in range(SIZE):
            hit = 0
            for oy in range(SS):
                for ox in range(SS):
                    nx = (px * SS + ox + 0.5) / (SIZE * SS)
                    ny = (py * SS + oy + 0.5) / (SIZE * SS)
                    if shape(nx, ny):
                        hit += 1
            alpha = round(255 * hit / (SS * SS))
            row.extend(rgb + (alpha,))
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path: Path, raw: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, shape in (("home", in_home), ("profile", in_profile)):
        for suffix, rgb in (("", GRAY), ("-active", GREEN)):
            write_png(OUT_DIR / f"{name}{suffix}.png", render(shape, rgb))
            print(f"[tab-icons] {name}{suffix}.png")


if __name__ == "__main__":
    main()
