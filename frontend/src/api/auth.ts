import { request } from './request'

/** 儿童档案简要信息。 */
export interface ChildBrief {
  id: number
  name: string
  avatar: string
}

/** 注册/登录返回。 */
export interface AuthResult {
  token: string
  expiresIn: number
  parentId: number
  children: ChildBrief[]
}

/** 儿童档案完整信息。 */
export interface ChildProfile {
  id: number
  parentId: number
  name: string
  avatar: string
}

export function register(phone: string, password: string) {
  return request<AuthResult>({
    url: '/api/v1/auth/register',
    method: 'POST',
    data: { phone, password },
  })
}

export function login(phone: string, password: string) {
  return request<AuthResult>({
    url: '/api/v1/auth/login',
    method: 'POST',
    data: { phone, password },
  })
}

export function createProfile(name: string, avatar = '') {
  return request<ChildProfile>({
    url: '/api/v1/profiles',
    method: 'POST',
    data: { name, avatar },
  })
}

/** 切换当前儿童，返回含 childId 声明的新 JWT。 */
export function switchProfile(childId: number) {
  return request<{ token: string }>({
    url: '/api/v1/profiles/switch',
    method: 'POST',
    data: { childId },
  })
}
