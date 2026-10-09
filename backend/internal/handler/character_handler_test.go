package handler_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"learnly/backend/internal/handler"
	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// mockCharacterService 仅覆写被测方法。
type mockCharacterService struct {
	service.CharacterService
	page       *repository.CharacterPage
	findResult *model.Character
	findErr    error
}

func (m *mockCharacterService) List(ctx context.Context, page, size, level int) (*repository.CharacterPage, error) {
	return m.page, nil
}

func (m *mockCharacterService) GetByID(ctx context.Context, id uint64) (*model.Character, error) {
	return m.findResult, m.findErr
}

// mockProgressService 记录调用次数（验证 N+1 消除）。
type mockProgressService struct {
	service.ProgressService
	callCount    int
	batch        map[uint64]model.Progress
	singleResult *model.Progress
}

func (m *mockProgressService) GetStatusesByCharacters(ctx context.Context, childID uint64, characterIDs []uint64) (map[uint64]model.Progress, error) {
	m.callCount++
	return m.batch, nil
}

func (m *mockProgressService) GetStatusByCharacter(ctx context.Context, childID, characterID uint64) (*model.Progress, error) {
	return m.singleResult, nil
}

// newTestRouter 构造挂载 List 路由并注入已登录上下文的 gin 引擎。
func newTestRouter(h *handler.CharacterHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/characters", withAuthContext(), h.List)
	return r
}

// withAuthContext 注入已登录 parent/child 上下文。
func withAuthContext() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set("parentId", uint64(1))
		c.Set("childId", uint64(5))
		c.Next()
	}
}

func TestCharacterHandler_List_BatchProgressSingleCall(t *testing.T) {
	charSvc := &mockCharacterService{page: &repository.CharacterPage{
		Total: 3, Page: 1, Size: 20,
		Items: []model.Character{
			{ID: 1, Char: "一", Pinyin: "yī", Strokes: 1, Level: 1},
			{ID: 2, Char: "二", Pinyin: "èr", Strokes: 2, Level: 1},
			{ID: 3, Char: "三", Pinyin: "sān", Strokes: 3, Level: 1},
		},
	}}
	progSvc := &mockProgressService{batch: map[uint64]model.Progress{
		2: {CharacterID: 2, Status: model.StatusLearning},
	}}

	r := newTestRouter(handler.NewCharacterHandler(charSvc, progSvc))
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/characters?page=1&pageSize=20", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, 200, w.Code)

	var body struct {
		Total int64 `json:"total"`
		Items []struct {
			ID             uint64 `json:"id"`
			ProgressStatus string `json:"progressStatus"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, int64(3), body.Total)
	require.Len(t, body.Items, 3)

	// 批量附加：有进度用实际状态，无进度默认未学。
	assert.Equal(t, model.StatusUnlearned, body.Items[0].ProgressStatus)
	assert.Equal(t, model.StatusLearning, body.Items[1].ProgressStatus)
	assert.Equal(t, model.StatusUnlearned, body.Items[2].ProgressStatus)

	// 关键断言：进度查询仅 1 次调用（N+1 消除）。
	assert.Equal(t, 1, progSvc.callCount)
}

func TestCharacterHandler_List_Unauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/characters", handler.NewCharacterHandler(&mockCharacterService{}, &mockProgressService{}).List)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/characters", nil))
	assert.Equal(t, 401, w.Code)
	assert.Contains(t, w.Body.String(), "UNAUTHORIZED")
}

func TestCharacterHandler_Detail(t *testing.T) {
	studyAt := time.Date(2026, 10, 8, 10, 0, 0, 0, time.UTC)
	charSvc := &mockCharacterService{
		findResult: &model.Character{ID: 2, Char: "二", Pinyin: "èr", Strokes: 2, Level: 1, Definition: "数字二"},
	}
	progSvc := &mockProgressService{singleResult: &model.Progress{
		Status: model.StatusLearning, LastStudyAt: &studyAt,
	}}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/characters/:id", withAuthContext(), handler.NewCharacterHandler(charSvc, progSvc).Detail)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/characters/2", nil))
	require.Equal(t, 200, w.Code)

	var body map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	assert.Equal(t, "二", body["char"])
	assert.Equal(t, "èr", body["pinyin"])
	assert.Equal(t, model.StatusLearning, body["progressStatus"])
	assert.NotNil(t, body["lastStudiedAt"])
}

func TestCharacterHandler_Detail_NotFound(t *testing.T) {
	charSvc := &mockCharacterService{findErr: gorm.ErrRecordNotFound}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/characters/:id", withAuthContext(), handler.NewCharacterHandler(charSvc, &mockProgressService{}).Detail)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/characters/999", nil))
	assert.Equal(t, 404, w.Code)
	assert.Contains(t, w.Body.String(), "NOT_FOUND")
}

func TestCharacterHandler_Detail_InvalidID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/characters/:id", withAuthContext(), handler.NewCharacterHandler(&mockCharacterService{}, &mockProgressService{}).Detail)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/characters/not-a-number", nil))
	assert.Equal(t, 400, w.Code)
	assert.Contains(t, w.Body.String(), "INVALID_ID")
}

func TestCharacterHandler_Detail_Unauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/characters/:id", handler.NewCharacterHandler(&mockCharacterService{}, &mockProgressService{}).Detail)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/characters/2", nil))
	assert.Equal(t, 401, w.Code)
}
