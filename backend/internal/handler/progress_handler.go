package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"learnly/backend/internal/auth"
	"learnly/backend/internal/service"
)

// ProgressHandler 学习进度 HTTP 处理器。
type ProgressHandler struct {
	progressSvc service.ProgressService
}

// NewProgressHandler 构造 ProgressHandler。
func NewProgressHandler(progressSvc service.ProgressService) *ProgressHandler {
	return &ProgressHandler{progressSvc: progressSvc}
}

// recordStudyReq 学习行为上报请求。
type recordStudyReq struct {
	CharacterID uint64 `json:"characterId" binding:"required"`
	Action      string `json:"action" binding:"required,oneof=start complete"`
}

// RecordStudy POST /api/progress。
func (h *ProgressHandler) RecordStudy(c *gin.Context) {
	childID, ok := auth.GetChildId(c)
	if !ok || childID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": "CHILD_REQUIRED", "message": "请先选择儿童档案"})
		return
	}
	var req recordStudyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_PARAMS", "message": err.Error()})
		return
	}
	p, err := h.progressSvc.RecordStudy(c.Request.Context(), childID, req.CharacterID, req.Action)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "RECORD_FAILED", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, p)
}

// GetStats GET /api/progress/stats。
func (h *ProgressHandler) GetStats(c *gin.Context) {
	childID, ok := auth.GetChildId(c)
	if !ok || childID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": "CHILD_REQUIRED", "message": "请先选择儿童档案"})
		return
	}
	stats, err := h.progressSvc.GetStats(c.Request.Context(), childID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": "QUERY_FAILED", "message": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// 避免 unused import errors。
var _ = errors.New
