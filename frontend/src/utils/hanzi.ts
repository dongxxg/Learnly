/** 识字模块纯逻辑工具（与组件解耦，便于复用与类型收敛）。 */

import type { ProgressStatus } from '@/api/literacy'

/** 汉字读音音频路径（static/audio 按码点命名，构建期内嵌 app 包）。 */
export function charAudioPath(char: string): string {
  return `/static/audio/u${char.codePointAt(0)!.toString(16)}.mp3`
}

/** 进度状态中文标签。 */
export const STATUS_LABEL: Record<ProgressStatus, string> = {
  unlearned: '未学',
  learning: '在学',
  learned: '已学',
}

/** 进度状态对应的角标样式类名。 */
export const STATUS_CLASS: Record<ProgressStatus, string> = {
  unlearned: 'status-unlearned',
  learning: 'status-learning',
  learned: 'status-learned',
}
