// 同源优先（H5 走 nginx 反代），否则用 VITE_API_BASE_URL（开发直连 backend）
const BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

const TOKEN_KEY = 'learnly_token'
const LOGIN_PAGE = '/pages/auth/login'

/** 业务错误：携带 HTTP 状态码与后端错误码（如 TOKEN_EXPIRED）。 */
export class ApiError extends Error {
  readonly statusCode: number
  readonly code?: string

  constructor(message: string, statusCode: number, code?: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

export interface RequestOptions extends UniApp.RequestOptions {}

/** 401 统一处理：清登录态并跳登录页（登录页自身不重复跳转）。 */
function handleUnauthorized(code?: string) {
  uni.removeStorageSync(TOKEN_KEY)
  const pages = getCurrentPages()
  const current = pages[pages.length - 1]?.route ?? ''
  if (current.includes('pages/auth/login')) return
  uni.showToast({
    title: code === 'TOKEN_EXPIRED' ? '登录已过期，请重新登录' : '请先登录',
    icon: 'none',
  })
  setTimeout(() => {
    uni.reLaunch({ url: LOGIN_PAGE })
  }, 600)
}

/** 统一请求封装：注入 base url 与 JWT、处理业务码/401/网络错误。 */
export function request<T = unknown>(options: RequestOptions): Promise<T> {
  const url = /^https?:\/\//.test(options.url) ? options.url : BASE_URL + options.url
  const token = uni.getStorageSync(TOKEN_KEY) as string | ''
  const header: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.header,
  }
  if (token) {
    header.Authorization = `Bearer ${token}`
  }

  return new Promise<T>((resolve, reject) => {
    uni.request({
      url,
      method: options.method || 'GET',
      data: options.data,
      header,
      success: (res) => {
        const body = res.data as Partial<ApiResponse<T>>
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // 后端为裸 JSON（无信封），data 缺省时回退到 body 本身。
          resolve((body.data ?? body) as T)
        } else {
          if (res.statusCode === 401) {
            handleUnauthorized(body?.code as string | undefined)
          }
          reject(new ApiError(body?.message || `HTTP ${res.statusCode}`, res.statusCode, body?.code as string | undefined))
        }
      },
      fail: (err) => reject(new ApiError(err.errMsg, 0)),
    })
  })
}
