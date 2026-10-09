import { defineStore } from 'pinia'
import {
  createProfile as apiCreateProfile,
  login as apiLogin,
  register as apiRegister,
  switchProfile as apiSwitchProfile,
  type AuthResult,
  type ChildBrief,
} from '@/api/auth'
import { useLiteracyStore } from './literacy'

const TOKEN_KEY = 'learnly_token'
const PARENT_KEY = 'learnly_parent_id'
const CHILD_KEY = 'learnly_child_id'
const CHILDREN_KEY = 'learnly_children'

/** 登录态与当前儿童。token/childId/children 持久化，切换儿童时重置业务 store（D4）。 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: (uni.getStorageSync(TOKEN_KEY) as string) || '',
    parentId: Number(uni.getStorageSync(PARENT_KEY)) || 0,
    childId: Number(uni.getStorageSync(CHILD_KEY)) || 0,
    children: parseChildren(uni.getStorageSync(CHILDREN_KEY)),
  }),

  getters: {
    isLoggedIn: (state) => !!state.token,
    hasChild: (state) => state.childId > 0,
  },

  actions: {
    setSession(token: string, parentId: number, childId: number) {
      this.token = token
      this.parentId = parentId
      this.childId = childId
      uni.setStorageSync(TOKEN_KEY, token)
      uni.setStorageSync(PARENT_KEY, String(parentId))
      uni.setStorageSync(CHILD_KEY, String(childId))
    },

    applyAuthResult(result: AuthResult) {
      this.setSession(result.token, result.parentId, 0)
      this.children = result.children
      uni.setStorageSync(CHILDREN_KEY, JSON.stringify(result.children))
    },

    async register(phone: string, password: string) {
      const result = await apiRegister(phone, password)
      this.applyAuthResult(result)
      return result
    },

    async login(phone: string, password: string) {
      const result = await apiLogin(phone, password)
      this.applyAuthResult(result)
      return result
    },

    /** 创建儿童档案并加入本地列表。 */
    async createChild(name: string, avatar = '') {
      const profile = await apiCreateProfile(name, avatar)
      this.children = [...this.children, { id: profile.id, name: profile.name, avatar: profile.avatar }]
      uni.setStorageSync(CHILDREN_KEY, JSON.stringify(this.children))
      return profile
    },

    /** 切换当前儿童：以新 JWT 落地 childId，并重置识字缓存。 */
    async switchChild(childId: number) {
      const { token } = await apiSwitchProfile(childId)
      this.setSession(token, this.parentId, childId)
      useLiteracyStore().reset()
    },

    logout() {
      this.setSession('', 0, 0)
      this.children = []
      uni.removeStorageSync(CHILDREN_KEY)
      useLiteracyStore().reset()
    },
  },
})

function parseChildren(raw: string): ChildBrief[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

