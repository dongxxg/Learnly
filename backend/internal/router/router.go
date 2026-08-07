package router

import (
	"github.com/gin-gonic/gin"

	"learnly/backend/internal/auth"
	"learnly/backend/internal/handler"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// New 组装路由。Deps 携带 DB/Redis 供需要下游依赖的 handler 使用。
func New(deps handler.Deps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())

	// 探针
	r.GET("/healthz", handler.Healthz)
	r.GET("/readyz", deps.Readyz)

	// 构建 literacy 模块依赖。
	parentRepo := repository.NewParentRepository(deps.DB)
	childRepo := repository.NewChildProfileRepository(deps.DB)
	charRepo := repository.NewCharacterRepository(deps.DB)
	progressRepo := repository.NewProgressRepository(deps.DB)

	authSvc := service.NewAuthService(parentRepo, childRepo)
	childSvc := service.NewChildService(childRepo)
	charSvc := service.NewCharacterService(charRepo)
	progressSvc := service.NewProgressService(progressRepo)

	authHandler := handler.NewAuthHandler(authSvc)
	childHandler := handler.NewChildHandler(childSvc)
	charHandler := handler.NewCharacterHandler(charSvc, progressSvc)
	progressHandler := handler.NewProgressHandler(progressSvc)

	// API v1
	v1 := r.Group("/api/v1")

	// 公开路由
	authGroup := v1.Group("/auth")
	{
		authGroup.POST("/register", authHandler.Register)
		authGroup.POST("/login", authHandler.Login)
	}

	// 受保护路由（需 JWT）
	authorized := v1.Group("")
	authorized.Use(auth.Middleware())
	{
		// 儿童档案
		authorized.POST("/profiles", childHandler.CreateProfile)
		authorized.POST("/profiles/switch", childHandler.SwitchProfile)

		// 汉字
		authorized.GET("/characters", charHandler.List)
		authorized.GET("/characters/:id", charHandler.Detail)

		// 学习进度
		authorized.POST("/progress", progressHandler.RecordStudy)
		authorized.GET("/progress/stats", progressHandler.GetStats)
	}

	return r
}
