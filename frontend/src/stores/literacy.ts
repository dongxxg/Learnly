import { defineStore } from 'pinia'
import {
  getStats,
  listCharacters,
  type CharacterItem,
  type StudyStats,
} from '@/api/literacy'

const DEFAULT_PAGE_SIZE = 20

/** 识字列表/统计缓存。当前 child 切换时由 auth store 调用 reset() 清空。 */
export const useLiteracyStore = defineStore('literacy', {
  state: () => ({
    items: [] as CharacterItem[],
    total: 0,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    level: 0,
    loading: false,
    stats: null as StudyStats | null,
  }),

  getters: {
    hasMore: (state) => state.items.length < state.total,
  },

  actions: {
    /** 分页加载；reset=true 时回到第一页并清空已有数据。 */
    async loadPage(reset = false) {
      if (this.loading) return
      this.loading = true
      try {
        if (reset) {
          this.page = 1
          this.total = 0
          this.items = []
        }
        const result = await listCharacters({
          page: this.page,
          pageSize: this.pageSize,
          level: this.level > 0 ? this.level : undefined,
        })
        this.total = result.total
        this.items = reset ? result.items : [...this.items, ...result.items]
      } finally {
        this.loading = false
      }
    },

    /** 上拉加载下一页。失败时回滚页码，避免弱网重试跳页漏字。 */
    async loadMore() {
      if (!this.hasMore || this.loading) return
      this.page += 1
      try {
        await this.loadPage(false)
      } catch (err) {
        this.page -= 1
        throw err
      }
    },

    setLevel(level: number) {
      this.level = level
      return this.loadPage(true)
    },

    async loadStats() {
      this.stats = await getStats()
    },

    /** 书写通过后本地同步进度状态（避免整页刷新）。 */
    applyProgress(characterId: number, status: CharacterItem['progressStatus']) {
      const target = this.items.find((item) => item.id === characterId)
      if (target) {
        target.progressStatus = status
      }
    },

    /** 切换 child / 退出登录时清空缓存。 */
    reset() {
      this.items = []
      this.total = 0
      this.page = 1
      this.level = 0
      this.loading = false
      this.stats = null
    },
  },
})
