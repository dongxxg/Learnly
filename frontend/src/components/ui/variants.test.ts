import { describe, expect, it } from 'vitest'
import { btnClass, cardClass } from './variants'

// 共享件变体纯函数契约（ui-kit 规格「共享 UI 组件契约」）：
//   类名是样式与组件的唯一耦合面，非法入参必须回退默认档而非产出脏类名。

describe('btnClass', () => {
  it('默认 primary/md', () => {
    expect(btnClass()).toBe('l-btn l-btn--primary l-btn--md')
  })

  it('枚举各变体与尺寸', () => {
    expect(btnClass('soft', 'lg')).toBe('l-btn l-btn--soft l-btn--lg')
    expect(btnClass('ghost', 'sm')).toBe('l-btn l-btn--ghost l-btn--sm')
    expect(btnClass('danger', 'md')).toBe('l-btn l-btn--danger l-btn--md')
  })

  it('disabled 追加禁用类', () => {
    expect(btnClass('primary', 'md', true)).toBe('l-btn l-btn--primary l-btn--md l-btn--disabled')
  })

  it('非法入参回退默认档（不产出脏类名）', () => {
    const cls = btnClass('bogus' as never, 'huge' as never)
    expect(cls).toBe('l-btn l-btn--primary l-btn--md')
    expect(cls).not.toContain('undefined')
  })
})

describe('cardClass', () => {
  it('默认 sm 阴影', () => {
    expect(cardClass()).toBe('l-card l-card--shadow-sm')
  })

  it('lg/none 档', () => {
    expect(cardClass('lg')).toBe('l-card l-card--shadow-lg')
    expect(cardClass('none')).toBe('l-card')
  })

  it('非法入参回退 sm', () => {
    expect(cardClass('bogus' as never)).toBe('l-card l-card--shadow-sm')
  })
})
