# 生成 seed 字库的读音音频（edge-tts，构建期内嵌 app 包）。
# - 中文（默认）：zh-CN-XiaoxiaoNeural，语速放慢适配儿童，文本取 backend/seeds/characters.json；
#   文件按 Unicode 码点命名（人 → u4eba.mp3），缺字时输出清单并以非 0 退出。
# - 英文（--lang en）：en-US-AnaNeural 童声，文本为字母名（"A"…"Z"），
#   产物 static/audio/letter-<小写>.mp3 共 26 个（与 utils/english.ts letterAudioPath 一致）。
import argparse
import json
import pathlib
import subprocess
import sys
import time

FRONTEND = pathlib.Path(__file__).resolve().parent.parent
SEEDS = FRONTEND.parent / 'backend' / 'seeds' / 'characters.json'
OUT = FRONTEND / 'src' / 'static' / 'audio'
RATE = '-20%'  # 儿童产品：放慢语速

LANG_CONFIG = {
    'zh': {'voice': 'zh-CN-XiaoxiaoNeural'},
    'en': {'voice': 'en-US-AnaNeural'},
}


def out_name_zh(ch: str) -> str:
    return f"u{ord(ch):x}.mp3"


def zh_items() -> list[tuple[str, str]]:
    seeds = json.loads(SEEDS.read_text(encoding='utf-8'))
    return [(item['char'], out_name_zh(item['char'])) for item in seeds]


def en_items() -> list[tuple[str, str]]:
    # 字母名单字即可触发 edge-tts 读字母名（"A" → /eɪ/），文件名统一小写。
    return [(ch.upper(), f"letter-{ch.lower()}.mp3") for ch in 'abcdefghijklmnopqrstuvwxyz']


def generate(text: str, voice: str, dest: pathlib.Path) -> bool:
    for attempt in range(3):
        try:
            subprocess.run(
                [sys.executable, '-m', 'edge_tts', '--voice', voice, '--rate', RATE,
                 '--text', text, '--write-media', str(dest)],
                check=True, capture_output=True, timeout=30,
            )
            if dest.exists() and dest.stat().st_size > 0:
                return True
            dest.unlink(missing_ok=True)  # 失败尝试可能残留 0 字节文件，清理避免混入构建产物
        except subprocess.SubprocessError:
            time.sleep(1 + attempt)
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description='生成识字/英语读音音频')
    parser.add_argument('--lang', choices=sorted(LANG_CONFIG), default='zh', help='读音语言（默认 zh）')
    args = parser.parse_args()

    voice = LANG_CONFIG[args.lang]['voice']
    items = zh_items() if args.lang == 'zh' else en_items()
    OUT.mkdir(parents=True, exist_ok=True)

    missing = []
    for i, (text, name) in enumerate(items):
        dest = OUT / name
        if dest.exists() and dest.stat().st_size > 0:
            continue  # 幂等：已生成跳过
        if not generate(text, voice, dest):
            missing.append(text)
        if (i + 1) % 20 == 0:
            print(f"{i + 1}/{len(items)}", flush=True)

    print(f"读音生成完成：{len(items) - len(missing)}/{len(items)}")
    if missing:
        print("缺字清单：", ' '.join(missing))
        sys.exit(1)


if __name__ == '__main__':
    main()
