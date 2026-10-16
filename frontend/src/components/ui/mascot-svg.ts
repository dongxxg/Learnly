// 小芽吉祥物（PM 定稿 2026-10-15：方向 A 简约双子叶芽，几何扁平无脸）
// viewBox 64×64：双叶（左浅绿右深绿）+ 直茎。使用场景限 hero/庆祝/空态（ui-kit 规格）。

const GREEN = '#4CAF7A'
const GREEN_DEEP = '#3E9163'

export interface MascotOptions {
  variant?: 'duo' | 'mono'
  /** mono 模式的单色（duo 模式忽略） */
  color?: string
}

export function mascotSvg(opts: MascotOptions = {}): string {
  const { variant = 'duo', color = GREEN_DEEP } = opts
  const leftLeaf = variant === 'mono' ? color : GREEN
  const rightLeaf = variant === 'mono' ? color : GREEN_DEEP
  const stem = variant === 'mono' ? color : GREEN_DEEP
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">` +
    `<path d="M32 34C24 34 15 30 12 20c10-1 18 5 20 14z" fill="${leftLeaf}"/>` +
    `<path d="M32 34c8 0 17-4 20-14-10-1-18 5-20 14z" fill="${rightLeaf}"/>` +
    `<path d="M32 34v24" stroke="${stem}" stroke-width="4" stroke-linecap="round"/>` +
    `</svg>`
  )
}
