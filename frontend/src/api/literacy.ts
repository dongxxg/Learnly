import { request } from './request'

/** 学习进度状态（单向：unlearned → learning → learned）。 */
export type ProgressStatus = 'unlearned' | 'learning' | 'learned'

/** 汉字（列表项/详情）。 */
export interface CharacterItem {
  id: number
  char: string
  pinyin: string
  strokes: number
  level: number
  definition: string
  progressStatus: ProgressStatus
  lastStudiedAt?: string
}

/** 汉字分页结果（后端已按 level→strokes→id 从简单到复杂排序）。 */
export interface CharacterPage {
  total: number
  page: number
  pageSize: number
  items: CharacterItem[]
}

/** 学习统计。 */
export interface StudyStats {
  learned: number
  learning: number
  unlearned: number
  total: number
}

export function listCharacters(params: { page: number; pageSize: number; level?: number }) {
  return request<CharacterPage>({
    url: '/api/v1/characters',
    data: params,
  })
}

export function getCharacter(id: number) {
  return request<CharacterItem>({
    url: `/api/v1/characters/${id}`,
  })
}

/** 上报学习行为：action = start（进详情）/ complete（书写通过）。 */
export function recordStudy(characterId: number, action: 'start' | 'complete') {
  return request<CharacterItem>({
    url: '/api/v1/progress',
    method: 'POST',
    data: { characterId, action },
  })
}

export function getStats() {
  return request<StudyStats>({
    url: '/api/v1/progress/stats',
  })
}
