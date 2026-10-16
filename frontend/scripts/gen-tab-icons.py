#!/usr/bin/env python3
"""TabBar PNG 图标重绘（ui-polish 3.1）：SVG 矢量 → Edge headless 栅格化 81×81 PNG。

零第三方依赖：图标定义为与 src/components/ui/icons.ts 同源的线性风格路径，
经 Edge --headless --screenshot 栅格化。改色/改形后重跑本脚本即可再生成。
用法：python scripts/gen-tab-icons.py [--out ../src/static/tab]
"""

import argparse
import pathlib
import subprocess
import tempfile
import time

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
SIZE = 81  # 与现有 tabBar 图标规格一致

# 与 icons.ts 同源的线性风格路径（24×24 viewBox，stroke=2）
ICONS = {
    "home": '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    "profile": '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
}
COLORS = {
    "": "#9CA3AF",  # 未选中：$learnly-text-light
    "-active": "#4CAF7A",  # 选中：$learnly-primary
}

HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;background:#FFFFFF}}
svg{{display:block;width:{size}px;height:{size}px}}
</style></head><body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
 stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}</svg>
</body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(pathlib.Path(__file__).parent / ".." / "src" / "static" / "tab"))
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    for name, body in ICONS.items():
        for suffix, color in COLORS.items():
            html = HTML.format(size=SIZE, color=color, body=body)
            with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
                f.write(html)
                tmp = pathlib.Path(f.name)
            png = out_dir / f"{name}{suffix}.png"
            png.unlink(missing_ok=True)  # 先删：Edge 截图失败静默，靠"文件未重建"暴露
            with tempfile.TemporaryDirectory(prefix="edge-tab-profile") as profile:
                subprocess.run(  # msedge 是 GUI 程序，立即返回；靠轮询等落盘
                    [EDGE, "--headless", "--disable-gpu", f"--user-data-dir={profile}",
                     f"--screenshot={png}", f"--window-size={SIZE},{SIZE}", tmp.as_uri()],
                    capture_output=True, text=True, timeout=60,
                )
            for _ in range(50):  # 最多等 10s
                if png.exists():
                    break
                time.sleep(0.2)
            tmp.unlink(missing_ok=True)
            if not png.exists():
                raise SystemExit(f"[gen-tab-icons] FAILED {png.name}: Edge 未产出截图 {result.stderr[:200]}")
            print(f"[gen-tab-icons] OK {png.name} ({png.stat().st_size}B)")


if __name__ == "__main__":
    main()
