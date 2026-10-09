# 生成 seed 字库的读音音频（edge-tts，zh-CN-XiaoxiaoNeural，语速放慢适配儿童）。
# 输出到 frontend/src/static/audio/（uni-app static 目录，构建期内嵌 app 包）。
# 文件按 Unicode 码点命名（人 → u4eba.mp3），缺字时输出清单并以非 0 退出。
import json
import pathlib
import subprocess
import sys
import time

FRONTEND = pathlib.Path(__file__).resolve().parent.parent
SEEDS = FRONTEND.parent / 'backend' / 'seeds' / 'characters.json'
OUT = FRONTEND / 'src' / 'static' / 'audio'
VOICE = 'zh-CN-XiaoxiaoNeural'
RATE = '-20%'  # 儿童产品：放慢语速


def out_name(ch: str) -> str:
    return f"u{ord(ch):x}.mp3"


def generate(ch: str, dest: pathlib.Path) -> bool:
    for attempt in range(3):
        try:
            subprocess.run(
                [sys.executable, '-m', 'edge_tts', '--voice', VOICE, '--rate', RATE,
                 '--text', ch, '--write-media', str(dest)],
                check=True, capture_output=True, timeout=30,
            )
            if dest.exists() and dest.stat().st_size > 0:
                return True
        except subprocess.SubprocessError:
            time.sleep(1 + attempt)
    return False


def main() -> None:
    seeds = json.loads(SEEDS.read_text(encoding='utf-8'))
    OUT.mkdir(parents=True, exist_ok=True)

    missing = []
    for i, item in enumerate(seeds):
        ch = item['char']
        dest = OUT / out_name(ch)
        if dest.exists() and dest.stat().st_size > 0:
            continue  # 幂等：已生成跳过
        if not generate(ch, dest):
            missing.append(ch)
        if (i + 1) % 20 == 0:
            print(f"{i + 1}/{len(seeds)}", flush=True)

    print(f"读音生成完成：{len(seeds) - len(missing)}/{len(seeds)}")
    if missing:
        print("缺字清单：", ' '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main()
