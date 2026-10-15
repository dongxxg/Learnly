/** 知芽家长中心纯逻辑工具（与页面解耦，便于复用与类型收敛）。 */

/**
 * 手机号脱敏展示：保留前 3 后 4（13812345678 → 138****5678）。
 * 长度不足 8 位（含空串）返回空串，调用方据此回退默认称谓。
 */
export function maskPhone(phone: string): string {
  if (phone.length < 8) {
    return ''
  }
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}
