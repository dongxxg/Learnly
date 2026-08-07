package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

const (
	// HeaderAuthorization Authorization 头。
	HeaderAuthorization = "Authorization"
	// BearerPrefix JWT 前缀。
	BearerPrefix = "Bearer "
)

// contextKey 用于 gin context 存储的键。
const (
	ContextParentID = "parentId"
	ContextChildID  = "childId"
)

// Middleware JWT 鉴权中间件。
// 从 Authorization Header 提取 token，校验后注入 parentId/childId 到 gin context。
// 过期返回 401 + code TOKEN_EXPIRED；无效返回 401。
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader(HeaderAuthorization)
		if header == "" || !strings.HasPrefix(header, BearerPrefix) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"code":    "TOKEN_REQUIRED",
				"message": "缺少 Authorization Header",
			})
			return
		}
		tokenStr := strings.TrimPrefix(header, BearerPrefix)
		claims, err := VerifyToken(tokenStr)
		if err != nil {
			if err == ErrTokenExpired {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
					"code":    "TOKEN_EXPIRED",
					"message": "登录已过期，请重新登录",
				})
				return
			}
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"code":    "TOKEN_INVALID",
				"message": "登录无效，请重新登录",
			})
			return
		}
		c.Set(ContextParentID, claims.ParentID)
		c.Set(ContextChildID, claims.ChildID)
		c.Next()
	}
}

// GetParentId 从 gin context 获取当前 parent ID。
func GetParentId(c *gin.Context) (uint64, bool) {
	v, ok := c.Get(ContextParentID)
	if !ok {
		return 0, false
	}
	id, ok := v.(uint64)
	return id, ok
}

// GetChildId 从 gin context 获取当前 child ID。
func GetChildId(c *gin.Context) (uint64, bool) {
	v, ok := c.Get(ContextChildID)
	if !ok {
		return 0, false
	}
	id, ok := v.(uint64)
	return id, ok
}
