package handler_test

import (
	"context"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"

	"learnly/backend/internal/handler"
	"learnly/backend/internal/model"
	"learnly/backend/internal/service"
)

// mockChildService 仅覆写被测方法。
type mockChildService struct {
	service.ChildService
	createResult *model.ChildProfile
	createErr    error
	switchToken  string
	switchErr    error
}

func (m *mockChildService) CreateProfile(ctx context.Context, parentID uint64, name, avatar string) (*model.ChildProfile, error) {
	return m.createResult, m.createErr
}

func (m *mockChildService) SwitchProfile(ctx context.Context, parentID, childID uint64) (string, error) {
	return m.switchToken, m.switchErr
}

func newChildRouter(svc service.ChildService, withAuth bool) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := handler.NewChildHandler(svc)
	mw := func(c *gin.Context) {
		if withAuth {
			c.Set("parentId", uint64(1))
			c.Set("childId", uint64(5))
		}
		c.Next()
	}
	r.POST("/api/profiles", mw, h.CreateProfile)
	r.POST("/api/profiles/switch", mw, h.SwitchProfile)
	return r
}

func TestChildHandler_CreateProfile(t *testing.T) {
	t.Run("成功返回 201", func(t *testing.T) {
		svc := &mockChildService{createResult: &model.ChildProfile{ID: 5, Name: "小明"}}
		w := postJSON(newChildRouter(svc, true), "/api/profiles", `{"name":"小明","avatar":"a.png"}`)
		assert.Equal(t, 201, w.Code)
		assert.Contains(t, w.Body.String(), "小明")
	})

	t.Run("未登录返回 401", func(t *testing.T) {
		svc := &mockChildService{}
		w := postJSON(newChildRouter(svc, false), "/api/profiles", `{"name":"小明"}`)
		assert.Equal(t, 401, w.Code)
	})

	t.Run("缺少名称返回 400", func(t *testing.T) {
		svc := &mockChildService{}
		w := postJSON(newChildRouter(svc, true), "/api/profiles", `{"avatar":"a.png"}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "INVALID_PARAMS")
	})
}

func TestChildHandler_SwitchProfile(t *testing.T) {
	t.Run("成功返回新 token", func(t *testing.T) {
		svc := &mockChildService{switchToken: "new-jwt"}
		w := postJSON(newChildRouter(svc, true), "/api/profiles/switch", `{"childId":6}`)
		assert.Equal(t, 200, w.Code)
		assert.Contains(t, w.Body.String(), "new-jwt")
	})

	t.Run("缺少 childId 返回 400", func(t *testing.T) {
		svc := &mockChildService{}
		w := postJSON(newChildRouter(svc, true), "/api/profiles/switch", `{}`)
		assert.Equal(t, 400, w.Code)
	})

	t.Run("档案不属于当前家长返回 400", func(t *testing.T) {
		svc := &mockChildService{switchErr: errText("儿童档案不存在")}
		w := postJSON(newChildRouter(svc, true), "/api/profiles/switch", `{"childId":99}`)
		assert.Equal(t, 400, w.Code)
		assert.Contains(t, w.Body.String(), "SWITCH_FAILED")
	})
}
