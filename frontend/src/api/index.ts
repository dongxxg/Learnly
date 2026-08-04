import { request } from './request'

// 健康检查（验证前端 → backend 链路）
export const health = () => request<{ status: string }>('/healthz')

// 业务 API 占位（按模块分文件组织）：
// export * from './literacy'   知芽识字
// export * from './english'    知芽英语
// export * from './math'       知节数学
// export * from './ai-teacher' 知芽AI老师
// export * from './parent'     知芽家长助手
