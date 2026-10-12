/** 英语字母模块纯逻辑工具（与组件解耦，便于复用与类型收敛）。 */

/** A–Z 大写字母常量（顺序即列表/页签展示顺序）。 */
export const LETTERS: readonly string[] = Array.from({ length: 26 }, (_, i) =>
  String.fromCharCode(65 + i),
)

/** 是否为单个英文字母（大小写均可）。 */
export function isEnglishLetter(text: string): boolean {
  return /^[A-Za-z]$/.test(text)
}

/** 大写字母形态（'a' → 'A'）；非字母原样返回。 */
export function toUpperLetter(letter: string): string {
  return isEnglishLetter(letter) ? letter.toUpperCase() : letter
}

/** 小写字母形态（'A' → 'a'）；非字母原样返回。 */
export function toLowerLetter(letter: string): string {
  return isEnglishLetter(letter) ? letter.toLowerCase() : letter
}

/**
 * 字母名读音音频路径（static/audio 按小写字母命名，构建期内嵌 app 包）。
 * 与 scripts/gen-audio.py `--lang en` 产物命名（letter-<小写>.mp3）保持一致；
 * 非法输入返回 null，调用方据此置灰读音按钮。
 */
export function letterAudioPath(letter: string): string | null {
  if (!isEnglishLetter(letter)) {
    return null
  }
  return `/static/audio/letter-${letter.toLowerCase()}.mp3`
}
