package router

import (
	"github.com/gin-gonic/gin"

	"learnly/backend/internal/handler"
)

// New 组装路由。Deps 携带 DB/Redis 供需要下游依赖的 handler 使用。
func New(deps handler.Deps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	// 探针
	r.GET("/healthz", handler.Healthz)
	r.GET("/readyz", deps.Readyz)

	// API v1 —— 业务模块路由将在此注册：
	//   v1 := r.Group("/api/v1")
	//   literacy  知芽识字
	//   english   知芽英语
	//   math      知节数学
	//   ai-teacher 知芽AI老师（代理转发到 ai-service）
	//   parent    知芽家长助手
	v1 := r.Group("/api/v1")
	_ = v1

	return r
}
