// 同源优先（H5 走 nginx 反代），否则用 VITE_API_BASE_URL（开发直连 backend）
const BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

export interface ApiResponse<T = unknown> {
  code: number
  message: string
  data: T
}

export interface RequestOptions extends UniApp.RequestOptions {}

/** 统一请求封装：注入 base url、处理业务码与网络错误。 */
export function request<T = unknown>(options: RequestOptions): Promise<T> {
  const url = /^https?:\/\//.test(options.url) ? options.url : BASE_URL + options.url

  return new Promise<T>((resolve, reject) => {
    uni.request({
      url,
      method: options.method || 'GET',
      data: options.data,
      header: { 'Content-Type': 'application/json', ...options.header },
      success: (res) => {
        const body = res.data as ApiResponse<T>
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body.data ?? (body as unknown as T))
        } else {
          reject(new Error(body?.message || `HTTP ${res.statusCode}`))
        }
      },
      fail: (err) => reject(new Error(err.errMsg)),
    })
  })
}
