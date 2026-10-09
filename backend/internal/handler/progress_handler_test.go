package handler_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"learnly/backend/internal/handler"
	"learnly/backend/internal/model"
	"learnly/backend/internal/repository"
	"learnly/backend/internal/service"
)

// mockProgressServiceForProgress 补充 RecordStudy/GetStats 覆写。
type mockProgressServiceForProgress struct {
	service.ProgressService
	recordResult *model.Progress
	recordErr    error
	stats        *repository.ProgressStats
	statsErr     error
}

func (m *mockProgressServiceForProgress) RecordStudy(ctx context.Context, childID, characterID uint64, action string) (*model.Progress, error) {
	return m.recordResult, m.recordErr
}

func (m *mockProgressServiceForProgress) GetStats(ctx context.Context, childID uint64) (*repository.ProgressStats, error) {
	return m.stats, m.statsErr
}

func newProgressRouter(svc service.ProgressService, withAuth bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := handler.NewProgressHandler(svc)
	mw := func(c *gin.Context) {
		if withAuth {
			c.Set("parentId", uint64(1))
			c.Set("childId", uint64(5))
		}
		c.Next()
	}
	r.POST("/api/progress", mw, h.RecordStudy)
	r.GET("/api/progress/stats", mw, h.GetStats)
	return r
}

func TestProgressHandler_RecordStudy(t *testing.T) {
	t.Run("成功返回 200", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{recordResult: &model.Progress{Status: model.StatusLearning}}
		w := postJSON(newProgressRouter(svc, true), "/api/progress", `{"characterId":1,"action":"start"}`)
		require.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), "learning")
	})

	t.Run("未选择儿童返回 400", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{}
		w := postJSON(newProgressRouter(svc, false), "/api/progress", `{"characterId":1,"action":"start"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "CHILD_REQUIRED")
	})

	t.Run("非法 action 返回 400", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{}
		w := postJSON(newProgressRouter(svc, true), "/api/progress", `{"characterId":1,"action":"bad"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "INVALID_PARAMS")
	})

	t.Run("业务错误返回 400", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{recordErr: errText("childId 与 characterId 必填")}
		w := postJSON(newProgressRouter(svc, true), "/api/progress", `{"characterId":1,"action":"start"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "RECORD_FAILED")
	})
}

func TestProgressHandler_GetStats(t *testing.T) {
	t.Run("成功返回统计", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{stats: &repository.ProgressStats{
			Learned: 1, Learning: 2, Unlearned: 267, Total: 270,
		}}
		w := httptest.NewRecorder()
		newProgressRouter(svc, true).ServeHTTP(w, httptest.NewRequest("GET", "/api/progress/stats", nil))
		require.Equal(t, 200, w.Code)
		var body repository.ProgressStats
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		assert.Equal(t, int64(270), body.Total)
		assert.Equal(t, int64(267), body.Unlearned)
	})

	t.Run("未选择儿童返回 400", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{}
		w := httptest.NewRecorder()
		newProgressRouter(svc, false).ServeHTTP(w, httptest.NewRequest("GET", "/api/progress/stats", nil))
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "CHILD_REQUIRED")
	})

	t.Run("查询失败返回 500", func(t *testing.T) {
		svc := &mockProgressServiceForProgress{statsErr: assert.AnError}
		w := httptest.NewRecorder()
		newProgressRouter(svc, true).ServeHTTP(w, httptest.NewRequest("GET", "/api/progress/stats", nil))
		assert.Equal(t, 500, w.Code)
		assert.Contains(t, w.Body.String(), "QUERY_FAILED")
	})
}
