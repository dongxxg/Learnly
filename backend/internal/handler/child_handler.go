package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"learnly/backend/internal/auth"
	"learnly/backend/internal/service"
)

// ChildHandler 儿童档案 HTTP 处理器。
type ChildHandler struct {
	childService service.ChildService
}

// NewChildHandler 构造 ChildHandler。
func NewChildHandler(childService service.ChildService) *ChildHandler {
	return &ChildHandler{childService: childService}
}

// createProfileReq 创建档案请求。
type createProfileReq struct {
	Name   string `json:"name" binding:"required"`
	Avatar string `json:"avatar"`
}

// CreateProfile POST /api/profiles。
func (h *ChildHandler) CreateProfile(c *gin.Context) {
	parentID, ok := auth.GetParentId(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"code": "UNAUTHORIZED", "message": "未登录"})
		return
	}
	var req createProfileReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAMS", "message": err.Error()})
		return
	}
	profile, err := h.childService.CreateProfile(c.Request.Context(), parentID, req.Name, req.Avatar)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "CREATE_FAILED", "message": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, profile)
}

// switchProfileReq 切换档案请求。
type switchProfileReq struct {
	ChildID uint64 `json:"childId" binding:"required"`
}

// SwitchProfile POST /api/profiles/switch。
func (h *ChildHandler) SwitchProfile(c *gin.Context) {
	parentID, ok := auth.GetParentId(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"code": "UNAUTHORIZED", "message": "未登录"})
		return
	}
	var req switchProfileReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAMS", "message": err.Error()})
		return
	}
	token, err := h.childService.SwitchProfile(c.Request.Context(), parentID, req.ChildID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "SWITCH_FAILED", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token})
}
