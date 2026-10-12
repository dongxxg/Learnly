import { describe, expect, it } from 'vitest'
import { LETTERS, letterAudioPath, toLowerLetter, toUpperLetter } from './english'

describe('utils/english / LETTERS', () => {
  it('共 26 个字母，按 A→Z 升序', () => {
    expect(LETTERS).toHaveLength(26)
    expect(LETTERS[0]).toBe('A')
    expect(LETTERS[25]).toBe('Z')
    for (let i = 0; i < 26; i++) {
      expect(LETTERS[i].codePointAt(0)).toBe(65 + i)
    }
  })
})

describe('utils/english / letterAudioPath', () => {
  it('大写字母 → letter-<小写>.mp3（与 scripts/gen-audio.py --lang en 产物命名一致）', () => {
    expect(letterAudioPath('A')).toBe('/static/audio/letter-a.mp3')
    expect(letterAudioPath('Z')).toBe('/static/audio/letter-z.mp3')
  })

  it('小写输入同样归一为小写文件名', () => {
    expect(letterAudioPath('b')).toBe('/static/audio/letter-b.mp3')
  })

  it('非法输入返回 null（页面据此置灰读音按钮）', () => {
    expect(letterAudioPath('1')).toBeNull()
    expect(letterAudioPath('AB')).toBeNull()
    expect(letterAudioPath('')).toBeNull()
    expect(letterAudioPath('汉')).toBeNull()
  })
})

describe('utils/english / 大小写字形工具', () => {
  it('toLowerLetter / toUpperLetter 互逆', () => {
    expect(toLowerLetter('A')).toBe('a')
    expect(toUpperLetter('a')).toBe('A')
    expect(toLowerLetter('a')).toBe('a')
    expect(toUpperLetter('Q')).toBe('Q')
  })
})
