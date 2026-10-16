// 共享件变体纯函数 —— 类名是组件与样式间的唯一耦合面；非法入参回退默认档。

export type BtnType = 'primary' | 'soft' | 'ghost' | 'danger'
export type BtnSize = 'lg' | 'md' | 'sm'
export type CardShadow = 'sm' | 'lg' | 'none'

const BTN_TYPE: Record<BtnType, string> = {
  primary: 'l-btn--primary',
  soft: 'l-btn--soft',
  ghost: 'l-btn--ghost',
  danger: 'l-btn--danger',
}
const BTN_SIZE: Record<BtnSize, string> = { lg: 'l-btn--lg', md: 'l-btn--md', sm: 'l-btn--sm' }
const CARD_SHADOW: Record<CardShadow, string> = {
  sm: 'l-card--shadow-sm',
  lg: 'l-card--shadow-lg',
  none: '',
}

export function btnClass(type: BtnType = 'primary', size: BtnSize = 'md', disabled = false): string {
  const t = BTN_TYPE[type] ?? BTN_TYPE.primary
  const s = BTN_SIZE[size] ?? BTN_SIZE.md
  return ['l-btn', t, s, disabled ? 'l-btn--disabled' : ''].filter(Boolean).join(' ')
}

export function cardClass(shadow: CardShadow = 'sm'): string {
  const s = CARD_SHADOW[shadow] ?? CARD_SHADOW.sm
  return ['l-card', s].filter(Boolean).join(' ')
}
