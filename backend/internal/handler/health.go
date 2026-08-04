package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"
)

// Deps 通过依赖注入把 DB / Redis 交给 handler 层，避免全局状态。
type Deps struct {
	DB    *gorm.DB
	Redis *redis.Client
}

// Healthz 存活探针：进程在跑就返回 ok，不检查下游依赖。
func Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "service": "learnly-backend"})
}

// Readyz 就绪探针：探测 postgres / redis 是否可用，决定是否接入流量。
func (d Deps) Readyz(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
	defer cancel()

	code := http.StatusOK
	checks := gin.H{}

	if d.DB != nil {
		sqlDB, err := d.DB.DB()
		if err == nil && sqlDB.PingContext(ctx) == nil {
			checks["postgres"] = "ok"
		} else {
			checks["postgres"] = "unavailable"
			code = http.StatusServiceUnavailable
		}
	} else {
		checks["postgres"] = "not-configured"
		code = http.StatusServiceUnavailable
	}

	if d.Redis != nil {
		if d.Redis.Ping(ctx).Err() == nil {
			checks["redis"] = "ok"
		} else {
			checks["redis"] = "unavailable"
			code = http.StatusServiceUnavailable
		}
	} else {
		checks["redis"] = "not-configured"
		code = http.StatusServiceUnavailable
	}

	c.JSON(code, gin.H{"status": readyStatus(code), "checks": checks})
}

func readyStatus(code int) string {
	if code == http.StatusOK {
		return "ready"
	}
	return "not-ready"
}
