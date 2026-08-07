package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"learnly/backend/internal/auth"
	"learnly/backend/internal/model"
	"learnly/backend/internal/service"
)

// CharacterHandler 汉字 HTTP 处理器。
type CharacterHandler struct {
	charService   service.CharacterService
	progressSvc   service.ProgressService
}

// NewCharacterHandler 构造 CharacterHandler。
func NewCharacterHandler(charService service.CharacterService, progressSvc service.ProgressService) *CharacterHandler {
	return &CharacterHandler{charService: charService, progressSvc: progressSvc}
}

// characterListItem 列表项（含当前 child 进度状态）。
type characterListItem struct {
	model.Character
	ProgressStatus string  `json:"progressStatus"`
	LastStudiedAt  *string `json:"lastStudiedAt,omitempty"`
}

// List GET /api/characters。
func (h *CharacterHandler) List(c *gin.Context) {
	parentID, ok := auth.GetParentId(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"code": "UNAUTHORIZED", "message": "未登录"})
		return
	}
	_ = parentID

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	level, _ := strconv.Atoi(c.DefaultQuery("level", "0"))

	result, err := h.charService.List(c.Request.Context(), page, pageSize, level)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": "QUERY_FAILED", "message": err.Error()})
		return
	}

	items := make([]characterListItem, 0, len(result.Items))
	for _, ch := range result.Items {
		item := characterListItem{Character: ch, ProgressStatus: model.StatusUnlearned}
		// 若已登录且选择了 child，尝试附加进度状态。
		if childID, ok := auth.GetChildId(c); ok && childID > 0 {
			if p, err := h.progressSvc.GetStatusByCharacter(c.Request.Context(), childID, ch.ID); err == nil {
				item.ProgressStatus = p.Status
				if p.LastStudyAt != nil {
					s := p.LastStudyAt.Format("2006-01-02T15:04:05")
					item.LastStudiedAt = &s
				}
			}
		}
		items = append(items, item)
	}

	c.JSON(http.StatusOK, gin.H{
		"total":    result.Total,
		"page":     result.Page,
		"pageSize": result.Size,
		"items":    items,
	})
}

// Detail GET /api/characters/:id。
func (h *CharacterHandler) Detail(c *gin.Context) {
	parentID, ok := auth.GetParentId(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"code": "UNAUTHORIZED", "message": "未登录"})
		return
	}
	_ = parentID

	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "INVALID_ID", "message": "非法 ID"})
		return
	}
	ch, err := h.charService.GetByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"code": "NOT_FOUND", "message": "汉字不存在"})
		return
	}

	resp := gin.H{
		"id":         ch.ID,
		"char":       ch.Char,
		"pinyin":     ch.Pinyin,
		"strokes":    ch.Strokes,
		"level":      ch.Level,
		"definition": ch.Definition,
		"orderData":  ch.OrderData,
		"progressStatus": model.StatusUnlearned,
	}
	if childID, ok := auth.GetChildId(c); ok && childID > 0 {
		if p, err := h.progressSvc.GetStatusByCharacter(c.Request.Context(), childID, ch.ID); err == nil {
			resp["progressStatus"] = p.Status
			resp["lastStudiedAt"] = p.LastStudyAt
		}
	}
	c.JSON(http.StatusOK, resp)
}
