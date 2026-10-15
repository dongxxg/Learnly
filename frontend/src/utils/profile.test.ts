import { describe, expect, it } from 'vitest'
import { maskPhone } from './profile'

describe('utils/profile / maskPhone', () => {
  it('11 位手机号保留前 3 后 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })

  it('8 位以上非标准长度同样保留前 3 后 4', () => {
    expect(maskPhone('12345678')).toBe('123****5678')
  })

  it('不足 8 位返回空串（调用方回退默认称谓，不出残缺掩码）', () => {
    expect(maskPhone('1234567')).toBe('')
    expect(maskPhone('138')).toBe('')
  })

  it('空串返回空串', () => {
    expect(maskPhone('')).toBe('')
  })
})
